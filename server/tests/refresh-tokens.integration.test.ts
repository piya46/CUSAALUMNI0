import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { config } from '../src/config.js';
import { execute, pool, query } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createSsoModel, pkceChallenge, SsoModelError, type SsoAuditWriter } from '../src/models/ssoModel.js';
import { saveMember } from '../src/models/serviceAccessModel.js';
import { hashToken, randomToken, seal } from '../src/services/crypto.js';
import { consentedCode } from './consent-fixture.js';

test('MariaDB rotating refresh tokens preserve MFA, consent and revocation boundaries',{
  skip:process.env.RUN_DB_TESTS!=='1',
},async context=>{
  assert.ok(['127.0.0.1','localhost','::1'].includes(config.dbHost));
  assert.match(config.dbName,/_test$/);
  config.configured=true;
  const model=createSsoModel(),apps:string[]=[],users:Array<{id:string;email:string}>=[];
  const scopes=['identity:read','token:introspect','token:revoke'];
  const errorCode=(code='invalid_grant')=>(error:unknown)=>error instanceof SsoModelError&&error.code===code;
  async function fixture(){
    const userId=randomUUID(),email=`refresh-${userId}@example.test`,sessionId=randomUUID();
    const applicationId=randomUUID(),keyId=randomUUID(),roleId=randomUUID(),key=`cusa_${randomToken()}`;
    const redirectUri=`https://refresh-${applicationId}.example.test/callback`,verifier=randomToken();
    apps.push(applicationId);users.push({id:userId,email});
    await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,'user']);
    await execute('INSERT INTO users(id,google_sub,email,name) VALUES (?,?,?,?)',[userId,randomUUID(),email,'Synthetic refresh fixture']);
    await execute(`INSERT INTO sessions(id,token_hash,user_id,kind,csrf_token,mfa_method,authenticated_at,expires_at)
      VALUES (?,?,?,'full',?,'totp',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))`,
      [sessionId,hashToken(randomToken()),userId,randomToken()]);
    await execute('INSERT INTO applications(id,name,redirect_uri) VALUES (?,?,?)',[applicationId,'Refresh test',redirectUri]);
    await execute('INSERT INTO application_access_policies(application_id) VALUES (?)',[applicationId]);
    await execute('INSERT INTO application_memberships(application_id,user_id) VALUES (?,?)',[applicationId,userId]);
    await execute('INSERT INTO application_roles(id,application_id,code,name) VALUES (?,?,?,?)',[roleId,applicationId,'viewer','Viewer']);
    await execute('INSERT INTO application_member_roles(application_id,user_id,role_id) VALUES (?,?,?)',[applicationId,userId,roleId]);
    await execute(`INSERT INTO api_keys(id,application_id,name,prefix,key_hash,scopes,expires_at)
      VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR))`,[keyId,applicationId,'Test key','test',hashToken(key),JSON.stringify(scopes)]);
    const authorize={applicationId,userId,sessionId,redirectUri,challenge:pkceChallenge(verifier)};
    const exchange=async(code:string,refresh=true,record?:SsoAuditWriter)=>model.exchangeAuthorizationCode({
      apiKeyHash:hashToken(key),codeHash:hashToken(code),redirectUri,verifier,requestRefreshToken:refresh,
    },record);
    const issue=async(scope='identity:read profile email')=>exchange(await consentedCode(model,authorize,scope));
    const renew=(token:string,record?:SsoAuditWriter)=>model.refreshAccessToken({apiKeyHash:hashToken(key),refreshTokenHash:hashToken(token)},record);
    return {userId,email,sessionId,applicationId,keyId,roleId,key,authorize,exchange,issue,renew};
  }
  async function family(token:string){
    const [row]=await query<{id:string;consentId:string;expiresAt:Date;revokedAt:Date|null}>(`SELECT f.id,f.consent_id AS consentId,
      f.expires_at AS expiresAt,f.revoked_at AS revokedAt FROM sso_refresh_families f
      JOIN refresh_tokens r ON r.family_id=f.id WHERE r.token_hash=?`,[hashToken(token)]);
    assert.ok(row);return row;
  }
  try{
    await context.test('legacy exchanges remain access-only; explicit opt-in stores digests and preserves reduced consent',async()=>{
      const f=await fixture(),code=await consentedCode(model,f.authorize);
      const legacy=await f.exchange(code,false);
      assert.equal(legacy.refreshToken,undefined);assert.equal(legacy.expiresIn,300);
      assert.equal((await query('SELECT id FROM sso_refresh_families WHERE session_id=?',[f.sessionId])).length,0);
      const initial=await f.issue('identity:read');
      assert.match(initial.refreshToken!,/^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(initial.refreshToken,initial.accessToken);
      assert.ok(initial.refreshExpiresIn!<=3600&&initial.refreshExpiresIn!>3500);
      const saved=await family(initial.refreshToken!);
      await execute('UPDATE access_tokens SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE token_hash=?',[hashToken(initial.accessToken)]);
      assert.equal(await model.getUserInfo(hashToken(initial.accessToken)),null);
      const rotated=await f.renew(initial.refreshToken!);
      assert.notEqual(rotated.refreshToken,initial.refreshToken);assert.notEqual(rotated.accessToken,initial.accessToken);
      assert.equal(rotated.scope,'identity:read');assert.equal(rotated.expiresIn,300);
      assert.ok(await model.getUserInfo(hashToken(rotated.accessToken)));
      assert.equal((await family(rotated.refreshToken!)).expiresAt.getTime(),saved.expiresAt.getTime());
      const rows=await query<{token_hash:string;consumed_at:Date|null}>('SELECT token_hash,consumed_at FROM refresh_tokens WHERE family_id=?',[saved.id]);
      assert.equal(rows.length,2);assert.ok(rows.find(row=>row.token_hash===hashToken(initial.refreshToken!))?.consumed_at);
      assert.ok(rows.every(row=>/^[a-f0-9]{64}$/.test(row.token_hash)));
      assert.equal((await model.getUserInfo(hashToken(rotated.accessToken)))?.email,undefined);
      assert.deepEqual(await model.introspectToken(hashToken(f.key),hashToken(rotated.refreshToken!)),{active:false});
      assert.equal(await model.getUserInfo(hashToken(rotated.refreshToken!)),null);
    });

    await context.test('replaying any ancestor commits family and access-token revocation, without revoking another family',async()=>{
      const f=await fixture(),initial=await f.issue(),other=await f.issue();
      const second=await f.renew(initial.refreshToken!),third=await f.renew(second.refreshToken!);
      const events:Array<{event:string;metadata:unknown}>=[];
      await assert.rejects(f.renew(initial.refreshToken!,async(_conn,event,_target,metadata)=>{events.push({event,metadata});}),errorCode());
      assert.ok((await family(third.refreshToken!)).revokedAt);
      assert.equal(events[0].event,'sso.refresh.reuse.failure');
      assert.ok(!JSON.stringify(events).includes(initial.refreshToken!));
      for(const token of [initial,second,third]){
        assert.equal(await model.getUserInfo(hashToken(token.accessToken)),null);
        await assert.rejects(f.renew(token.refreshToken!),errorCode());
      }
      assert.ok((await f.renew(other.refreshToken!)).refreshToken);
    });

    await context.test('concurrent refresh has one winner; reuse revokes even the winner before subsequent use',async()=>{
      const f=await fixture(),initial=await f.issue();
      const results=await Promise.allSettled([f.renew(initial.refreshToken!),f.renew(initial.refreshToken!)]);
      const successes=results.filter(result=>result.status==='fulfilled');
      const failures=results.filter(result=>result.status==='rejected');
      assert.equal(successes.length,1);assert.equal(failures.length,1);assert.ok(errorCode()(failures[0].reason));
      assert.equal(await model.getUserInfo(hashToken(successes[0].value.accessToken)),null);
      await assert.rejects(f.renew(successes[0].value.refreshToken!),errorCode());
    });

    await context.test('another application or another key in the same application cannot consume or revoke a family',async()=>{
      const f=await fixture(),other=await fixture(),initial=await f.issue(),replacement=randomToken();
      await execute(`INSERT INTO api_keys(id,application_id,name,prefix,key_hash,scopes,expires_at)
        VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))`,
        [randomUUID(),f.applicationId,'Second key','test',hashToken(replacement),JSON.stringify(scopes)]);
      for(const key of [other.key,replacement])await assert.rejects(model.refreshAccessToken({apiKeyHash:hashToken(key),refreshTokenHash:hashToken(initial.refreshToken!)}),errorCode());
      const next=await f.renew(initial.refreshToken!);
      await assert.rejects(model.refreshAccessToken({apiKeyHash:hashToken(replacement),refreshTokenHash:hashToken(initial.refreshToken!)}),errorCode());
      assert.ok((await f.renew(next.refreshToken!)).refreshToken);
    });

    await context.test('audit failure rolls back initial issuance and rotation, including consumption of the old grant',async()=>{
      const f=await fixture(),code=await consentedCode(model,f.authorize);
      const unavailable=async()=>{throw new Error('synthetic audit failure');};
      await assert.rejects(f.exchange(code,true,unavailable),/synthetic audit failure/);
      assert.equal((await query('SELECT id FROM sso_refresh_families WHERE session_id=?',[f.sessionId])).length,0);
      const initial=await f.exchange(code);
      await assert.rejects(f.renew(initial.refreshToken!,unavailable),/synthetic audit failure/);
      assert.equal((await query('SELECT token_hash FROM refresh_tokens WHERE family_id=?',[(await family(initial.refreshToken!)).id])).length,1);
      assert.ok((await f.renew(initial.refreshToken!)).refreshToken);
    });

    await context.test('absolute expiry caps both credentials by session and key and never slides when session is extended',async()=>{
      for(const table of ['sessions','api_keys']){
        const f=await fixture(),id=table==='sessions'?f.sessionId:f.keyId;
        await execute(`UPDATE ${table} SET expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND) WHERE id=?`,[id]);
        const first=await f.issue(),saved=await family(first.refreshToken!);
        assert.ok(first.expiresIn<=60&&first.expiresIn>0);assert.equal(first.refreshExpiresIn,first.expiresIn);
        await execute(`UPDATE ${table} SET expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR) WHERE id=?`,[id]);
        const next=await f.renew(first.refreshToken!);
        assert.ok(next.refreshExpiresIn!<=first.refreshExpiresIn!);assert.ok(next.expiresIn<=60);
        assert.equal((await family(next.refreshToken!)).expiresAt.getTime(),saved.expiresAt.getTime());
        const tokens=await query<{expires_at:Date}>('SELECT expires_at FROM access_tokens WHERE refresh_family_id=?',[saved.id]);
        assert.ok(tokens.every(token=>token.expires_at.getTime()<=saved.expiresAt.getTime()));
      }
    });

    // Each case gets a fresh session/consent to prove every live predicate independently.
    const cases:Array<[string,(f:Awaited<ReturnType<typeof fixture>>,token:string)=>Promise<unknown>,string?]>=[
      ['logout',f=>execute('DELETE FROM sessions WHERE id=?',[f.sessionId])],
      ['session expiry',f=>execute('UPDATE sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[f.sessionId])],
      ['pending MFA',f=>execute("UPDATE sessions SET kind='pending' WHERE id=?",[f.sessionId])],
      ['recovery MFA',f=>execute("UPDATE sessions SET mfa_method='recovery' WHERE id=?",[f.sessionId])],
      ['changed MFA authentication time',f=>execute('UPDATE sessions SET authenticated_at=DATE_ADD(authenticated_at,INTERVAL 1 SECOND) WHERE id=?',[f.sessionId])],
      ['deleted user',f=>execute('UPDATE users SET deleted_at=UTC_TIMESTAMP(3) WHERE id=?',[f.userId])],
      ['removed internal allowlist',f=>execute('DELETE FROM allowed_emails WHERE email=?',[f.email])],
      ['revoked membership',f=>execute('UPDATE application_memberships SET revoked_at=UTC_TIMESTAMP(3) WHERE application_id=?',[f.applicationId])],
      ['pending enrollment',f=>execute("UPDATE application_memberships SET enrollment='pending' WHERE application_id=?",[f.applicationId])],
      ['removed role',f=>execute('DELETE FROM application_member_roles WHERE application_id=?',[f.applicationId])],
      ['required phone',f=>execute('UPDATE application_access_policies SET require_phone=TRUE WHERE application_id=?',[f.applicationId])],
      ['required LINE',f=>execute('UPDATE application_access_policies SET require_line=TRUE WHERE application_id=?',[f.applicationId])],
      ['revoked consent',async(f,token)=>model.revokeConsent((await family(token)).consentId,f.userId)],
      ['changed consent policy',f=>execute('UPDATE applications SET sharing_version=sharing_version+1 WHERE id=?',[f.applicationId])],
      ['reduced sharing scopes',f=>execute("UPDATE applications SET allowed_claim_scopes='identity:read' WHERE id=?",[f.applicationId])],
      ['changed registered callback',f=>execute("UPDATE applications SET redirect_uri='https://changed.example.test/callback' WHERE id=?",[f.applicationId])],
      ['expired family',async(_f,token)=>execute('UPDATE sso_refresh_families SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[(await family(token)).id])],
      ['revoked application',f=>execute('UPDATE applications SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?',[f.applicationId]),'invalid_client'],
      ['revoked issuing key',f=>execute('UPDATE api_keys SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?',[f.keyId]),'invalid_client'],
      ['expired issuing key',f=>execute('UPDATE api_keys SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[f.keyId]),'invalid_client'],
      ['removed issuing-key scope',f=>execute('UPDATE api_keys SET scopes=? WHERE id=?',[JSON.stringify(['token:introspect']),f.keyId]),'insufficient_scope'],
    ];
    for(const [name,change,code] of cases)await context.test(`${name} prevents refresh and use of associated access token`,async()=>{
      const f=await fixture(),initial=await f.issue();
      await change(f,initial.refreshToken!);
      await assert.rejects(f.renew(initial.refreshToken!),errorCode(code));
      assert.equal(await model.getUserInfo(hashToken(initial.accessToken)),null);
    });

    await context.test('saving member roles permanently revokes refresh families, even if the user remains authorized',async()=>{
      const f=await fixture(),initial=await f.issue();
      await execute("UPDATE allowed_emails SET role='admin' WHERE email=?",[f.email]);
      await execute('UPDATE users SET totp_secret=? WHERE id=?',[seal(randomToken()),f.userId]);
      await saveMember({userId:f.userId,email:f.email,sessionId:f.sessionId},f.applicationId,f.userId,
        {department:'Changed department',roleIds:[f.roleId]},async()=>{});
      await assert.rejects(f.renew(initial.refreshToken!),errorCode());
      assert.ok((await family(initial.refreshToken!)).revokedAt);
      assert.equal(await model.getUserInfo(hashToken(initial.accessToken)),null);
    });

    await context.test('HTTP revocation accepts refresh or access tokens, stays app-scoped and preserves the global session',async()=>{
      const web=createApp(),f=await fixture(),other=await fixture(),initial=await f.issue(),second=await f.issue(),otherToken=await other.issue();
      const revoke=(token:string)=>request(web).post('/api/sso/revoke').set('X-API-Key',f.key).send({token});
      await revoke(otherToken.refreshToken!).expect(200);
      assert.ok(await model.getUserInfo(hashToken(otherToken.accessToken)));
      await revoke(randomToken()).expect(200);
      await revoke(initial.refreshToken!).expect(200);
      await revoke(initial.refreshToken!).expect(200);
      for(const token of [initial,second]){
        await assert.rejects(f.renew(token.refreshToken!),errorCode());
        assert.equal(await model.getUserInfo(hashToken(token.accessToken)),null);
      }
      assert.equal((await query('SELECT id FROM sessions WHERE id=?',[f.sessionId])).length,1);
      const fresh=await f.issue();
      await revoke(fresh.accessToken).expect(200);
      await assert.rejects(f.renew(fresh.refreshToken!),errorCode());
      assert.ok((await other.renew(otherToken.refreshToken!)).refreshToken);
    });
  }finally{
    for(const id of apps)await execute('DELETE FROM applications WHERE id=?',[id]);
    for(const user of users){
      await execute('DELETE FROM users WHERE id=?',[user.id]);
      await execute('DELETE FROM allowed_emails WHERE email=?',[user.email]);
    }
    await pool.end();
  }
});
