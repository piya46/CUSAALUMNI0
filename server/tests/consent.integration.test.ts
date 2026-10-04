import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { config } from '../src/config.js';
import { execute, query, pool } from '../src/db.js';
import { createSsoModel, pkceChallenge } from '../src/models/ssoModel.js';
import { hashToken, randomToken, seal } from '../src/services/crypto.js';
import { cleanupExpiredCredentials } from '../src/services/maintenanceTasks.js';
import { getSharingPolicy, updateSharingPolicy } from '../src/models/adminModel.js';

const enabled=process.env.RUN_DB_TESTS==='1';
after(()=>pool.end());
test('MariaDB consent, disclosure, phone comparison and policy changes remain account/service/session bound', {skip:!enabled},async t=>{
  assert.equal(config.dbHost,'127.0.0.1');assert.match(config.dbName,/_test$/);
  const model=createSsoModel(),user=randomUUID(),session=randomUUID(),otherSession=randomUUID(),app=randomUUID(),otherApp=randomUUID();
  const email=`${user}@example.test`,key=hashToken(randomToken()),otherKey=hashToken(randomToken()),verifier=randomToken();
  const redirectUri='https://portal.example.test/callback',all='identity:read profile email phone phone:match line assurance';
  const start=(scope=all)=>model.beginAuthorization({applicationId:app,userId:user,sessionId:session,redirectUri,challenge:pkceChallenge(verifier),state:randomToken(),scope});
  const decide=(request:string,scope=all)=>model.decideConsent(request,session,user,true,scope.split(' '));
  async function exchange(url:string){const code=new URL(url).searchParams.get('code')!;return model.exchangeAuthorizationCode({apiKeyHash:key,codeHash:hashToken(code),redirectUri,verifier});}
  async function token(scope=all){return exchange((await decide(await start(scope),scope)).redirectTo);}
  try{
    await execute("INSERT INTO allowed_emails(id,email,role) VALUES (?,?,'user')",[randomUUID(),email]);
    await execute('INSERT INTO users(id,google_sub,email,name,first_name,last_name,avatar) VALUES (?,?,?,?,?,?,?)',[user,`test-${user}`,email,'Test Person','Test','Person','https://lh3.googleusercontent.com/avatar']);
    for(const id of [session,otherSession])await execute("INSERT INTO sessions(id,token_hash,user_id,kind,csrf_token,mfa_method,authenticated_at,expires_at) VALUES (?,?,?,'full',?,'totp',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[id,hashToken(randomToken()),user,randomToken()]);
    for(const [id,hash] of [[app,key],[otherApp,otherKey]]){
      await execute('INSERT INTO applications(id,name,redirect_uri,allowed_claim_scopes) VALUES (?,?,?,?)',[id,'Test Service',redirectUri,all]);
      await execute('INSERT INTO api_keys(id,application_id,name,prefix,key_hash,scopes,expires_at) VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))',[randomUUID(),id,'Test','test',hash,JSON.stringify(['identity:read','token:introspect'])]);
      await execute('INSERT INTO application_memberships(application_id,user_id,department) VALUES (?,?,?)',[id,user,'Science']);
      const role=randomUUID();await execute('INSERT INTO application_roles(id,application_id,code,name) VALUES (?,?,?,?)',[role,id,'viewer','Viewer']);
      await execute('INSERT INTO application_member_roles(application_id,user_id,role_id) VALUES (?,?,?)',[id,user,role]);
    }
    const phone='+66812345678',line='U'+'1'.repeat(32);
    await execute('INSERT INTO phone_identities(user_id,phone_hash,phone_encrypted,firebase_uid_hash) VALUES (?,?,?,?)',[user,hashToken(`phone:${phone}`),seal(phone),hashToken(`firebase:${user}`)]);
    await execute('INSERT INTO line_identities(user_id,subject_hash,subject_encrypted) VALUES (?,?,?)',[user,hashToken(`line:${line}`),seal(line)]);

    await t.test('no automatic code; scope overreach, wrong user/session, expiry, denial and replay fail closed',async()=>{
      const request=await start('identity:read email');
      assert.equal(Number((await query<{n:number}>('SELECT COUNT(*) n FROM authorization_codes WHERE application_id=?',[app]))[0].n),0);
      await assert.rejects(model.consentContext(request,otherSession,user),{code:'access_denied'});
      await assert.rejects(model.consentContext(request,session,randomUUID()),{code:'access_denied'});
      await assert.rejects(decide(request,'identity:read email phone'),{code:'invalid_scope'});
      await assert.rejects(decide(request,'identity:read email email'),{code:'invalid_scope'});
      await assert.rejects(decide(request,'email'),{code:'invalid_scope'});
      const denied=await model.decideConsent(request,session,user,false,[]);
      assert.equal(new URL(denied.redirectTo).searchParams.get('error'),'access_denied');
      assert.equal(new URL(denied.redirectTo).searchParams.has('code'),false);
      await assert.rejects(decide(request,'identity:read'),{code:'access_denied'});
      const expired=await start();await execute('UPDATE sso_consents SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE request_hash=?',[hashToken(expired)]);
      await assert.rejects(decide(expired),{code:'access_denied'});
    });
    await t.test('consent audit failure rolls back, then concurrent approval produces exactly one code',async()=>{
      const request=await start();
      await assert.rejects(model.decideConsent(request,session,user,true,all.split(' '),async()=>{throw new Error('audit unavailable');}),/audit unavailable/);
      const results=await Promise.allSettled([decide(request),decide(request)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.filter(r=>r.status==='rejected').length,1);
      const result=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{redirectTo:string}>;
      const issued=await exchange(result.value.redirectTo);
      assert.equal(issued.scope,all);
      await assert.rejects(exchange(result.value.redirectTo),{code:'invalid_grant'});
    });
    await t.test('both identity endpoints omit unapproved fields, even when stored and enrolled',async()=>{
      const minimal=await token('identity:read'),digest=hashToken(minimal.accessToken);
      const profile=await model.getUserInfo(digest);assert.deepEqual(Object.keys(profile!).sort(),['applicationOrigin','aud','roles','scope','sub']);
      const info=await model.introspectToken(key,digest);assert.equal(info.active,true);
      assert.equal('email' in info,false);assert.equal('line' in info,false);assert.equal('phone_number' in info,false);assert.equal('authentication' in info,false);
      await assert.rejects(model.matchPhone(key,digest,phone),{code:'insufficient_scope'});
    });
    await t.test('profile/LINE/verified phone and assurance use verified server values; later elevation does not upgrade an old grant',async()=>{
      const issued=await token(),digest=hashToken(issued.accessToken);
      await execute("UPDATE sessions SET mfa_method='passkey',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?",[session]);
      const info=await model.getUserInfo(digest);
      assert.equal(info?.picture,'https://lh3.googleusercontent.com/avatar');assert.equal(info?.given_name,'Test');assert.equal(info?.family_name,'Person');
      assert.equal(info?.phone_number,phone);assert.equal(info?.phone_number_verified,true);assert.ok(info?.phone_number_verified_at);
      assert.equal(info?.line?.user_id,line);assert.equal(info?.authentication?.second_step_method,'totp');assert.equal(info?.authentication?.assurance,'cusa:strong');
      assert.equal(info?.authentication?.phishing_resistant,false);
      await execute('DELETE FROM line_identities WHERE user_id=?',[user]);assert.deepEqual((await model.getUserInfo(digest))?.line,{linked:false});
    });
    await t.test('phone match accepts Thai/E.164, protects audience, returns tri-state and never returns the number',async()=>{
      const issued=await token('identity:read phone:match'),digest=hashToken(issued.accessToken);
      const match=await model.matchPhone(key,digest,'081-234-5678');assert.equal(match.status,'matched');assert.equal(match.match,true);assert.equal('phone_number' in match,false);
      assert.equal((await model.matchPhone(key,digest,'+66812345679')).status,'mismatch');
      await assert.rejects(model.matchPhone(otherKey,digest,phone),{code:'invalid_grant'});
      await execute('DELETE FROM phone_identities WHERE user_id=?',[user]);
      assert.deepEqual(await model.matchPhone(key,digest,phone),{status:'unverified',match:null,phone_number_verified:false});
    });
    await t.test('revocation kills code before exchange and both identity APIs after exchange, ownership enforced',async()=>{
      const request=await start(),approved=await decide(request),issued=await exchange(approved.redirectTo);
      const [consent]=await query<{id:string}>('SELECT id FROM sso_consents WHERE request_hash=?',[hashToken(request)]);
      await assert.rejects(model.revokeConsent(consent.id,randomUUID()),{code:'access_denied'});
      await model.revokeConsent(consent.id,user);
      assert.equal(await model.getUserInfo(hashToken(issued.accessToken)),null);assert.deepEqual(await model.introspectToken(key,hashToken(issued.accessToken)),{active:false});
      const pending=await start(),url=(await decide(pending)).redirectTo;
      const [next]=await query<{id:string}>('SELECT id FROM sso_consents WHERE request_hash=?',[hashToken(pending)]);
      await model.revokeConsent(next.id,user);await assert.rejects(exchange(url),{code:'invalid_grant'});
    });
    await t.test('policy changes invalidate old requests and tokens; legacy tokens without consent are inactive',async()=>{
      const issued=await token(),request=await start();
      await execute("UPDATE applications SET allowed_claim_scopes='identity:read profile email',sharing_version=sharing_version+1 WHERE id=?",[app]);
      await assert.rejects(decide(request),{code:'access_denied'});await assert.rejects(start(),{code:'invalid_scope'});
      assert.equal(await model.getUserInfo(hashToken(issued.accessToken)),null);
      await execute('UPDATE access_tokens SET consent_id=NULL WHERE token_hash=?',[hashToken(issued.accessToken)]);
      assert.deepEqual(await model.introspectToken(key,hashToken(issued.accessToken)),{active:false});
    });
    await t.test('indexed cleanup purges expired requests but preserves approved consent until its separate retention deadline',async()=>{
      const pending=await start('identity:read'),approved=await start('identity:read');
      const issued=await exchange((await decide(approved,'identity:read')).redirectTo);
      const [retention]=await query<{days:number}>('SELECT TIMESTAMPDIFF(DAY,decided_at,expires_at) AS days FROM sso_consents WHERE request_hash=?',[hashToken(approved)]);
      assert.equal(Number(retention.days),90);
      await execute('UPDATE sso_consents SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE request_hash=?',[hashToken(pending)]);
      const conn=await pool.getConnection();try{await cleanupExpiredCredentials(conn);}finally{conn.release();}
      assert.equal((await query('SELECT id FROM sso_consents WHERE request_hash=?',[hashToken(pending)])).length,0);
      assert.equal((await model.getUserInfo(hashToken(issued.accessToken)))?.sub,user);
    });
    await t.test('admin sharing changes require current fresh strong MFA and roll back policy/version on audit failure',async()=>{
      const actor={userId:user,email,sessionId:session},data={scopes:['identity:read','profile'],purpose:'Display the membership profile'};
      await assert.rejects(updateSharingPolicy(actor,app,data,async()=>{}),{code:'ADMIN_REVOKED'});
      await execute("UPDATE allowed_emails SET role='admin' WHERE email=?",[email]);
      await execute('UPDATE users SET totp_secret=? WHERE id=?',[seal('JBSWY3DPEHPK3PXP'),user]);
      await execute("UPDATE sessions SET mfa_method='line' WHERE id=?",[session]);
      await assert.rejects(updateSharingPolicy(actor,app,data,async()=>{}),{code:'MFA_REAUTH_REQUIRED'});
      await execute("UPDATE sessions SET mfa_method='passkey',authenticated_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 6 MINUTE) WHERE id=?",[session]);
      await assert.rejects(updateSharingPolicy(actor,app,data,async()=>{}),{code:'MFA_REAUTH_REQUIRED'});
      await execute('UPDATE sessions SET authenticated_at=UTC_TIMESTAMP(3) WHERE id=?',[session]);
      const before=await getSharingPolicy(app),issued=await token('identity:read');
      await assert.rejects(updateSharingPolicy(actor,app,data,async()=>{throw new Error('audit unavailable');}),/audit unavailable/);
      assert.deepEqual(await getSharingPolicy(app),before);
      await updateSharingPolicy(actor,app,data,async()=>{});
      const after=await getSharingPolicy(app);assert.deepEqual(after.scopes,data.scopes);assert.equal(after.version,before.version+1);
      assert.equal(await model.getUserInfo(hashToken(issued.accessToken)),null);
    });
  }finally{
    for(const id of [app,otherApp])await execute('DELETE FROM applications WHERE id=?',[id]);
    await execute('DELETE FROM users WHERE id=?',[user]);await execute('DELETE FROM allowed_emails WHERE email=?',[email]);
  }
});
