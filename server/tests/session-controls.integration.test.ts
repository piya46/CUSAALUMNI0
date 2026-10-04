import { consentedCode } from './consent-fixture.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { execute, query, pool } from '../src/db.js';
import { hashToken, randomToken } from '../src/services/crypto.js';
import * as auth from '../src/models/authModel.js';
import { ssoModel, pkceChallenge } from '../src/models/ssoModel.js';
import { createApp } from '../src/app.js';
import { sessionCookie } from '../src/middleware/security.js';
const enabled=process.env.RUN_DB_TESTS==='1';
if(enabled)config.configured=true;
const apps:string[]=[],users:Array<{id:string;email:string}>=[];
async function user(){
  const email=`session-controls-${randomUUID()}@example.test`;
  await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,'user']);
  const s=await auth.startGoogleSession({email,sub:randomUUID(),name:'Synthetic user',avatar:null});assert.ok(s);users.push({id:s.userId,email});
  await execute("UPDATE sessions SET kind='full',mfa_method='totp',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?",[s.sessionId]);
  const identity=await auth.findSession(s.token);assert.ok(identity);return {...s,identity,cookie:`${sessionCookie}=${s.token}`};
}
async function service(u:Awaited<ReturnType<typeof user>>){
  const id=randomUUID(),role=randomUUID(),key='cusa_'+randomToken(),redirectUri='https://synthetic.example.test/callback',verifier=randomToken();apps.push(id);
  await execute('INSERT INTO applications(id,name,redirect_uri) VALUES (?,?,?)',[id,'Synthetic service',redirectUri]);
  await execute('INSERT INTO application_roles(id,application_id,code,name) VALUES (?,?,?,?)',[role,id,'member','Member']);
  await execute('INSERT INTO application_memberships(application_id,user_id) VALUES (?,?)',[id,u.userId]);
  await execute('INSERT INTO application_member_roles(application_id,user_id,role_id) VALUES (?,?,?)',[id,u.userId,role]);
  await execute('INSERT INTO api_keys(id,application_id,name,prefix,key_hash,scopes,expires_at) VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))',[randomUUID(),id,'Test','test',hashToken(key),JSON.stringify(['identity:read','token:introspect','token:revoke'])]);
  const code=await consentedCode(ssoModel,{applicationId:id,userId:u.userId,sessionId:u.sessionId,redirectUri,challenge:pkceChallenge(verifier)});
  const token=await ssoModel.exchangeAuthorizationCode({apiKeyHash:hashToken(key),codeHash:hashToken(code),redirectUri,verifier});
  return {id,key,...token};
}
after(async()=>{for(const id of apps)await execute('DELETE FROM applications WHERE id=?',[id]);for(const u of users){await execute('DELETE FROM users WHERE id=?',[u.id]);await execute('DELETE FROM allowed_emails WHERE email=?',[u.email]);}await pool.end();});

test('Service revocation needs scope and cannot revoke another Service or the global SSO session',{skip:!enabled},async()=>{
  const u=await user(),a=await service(u),b=await service(u),web=createApp();
  const revoke=(key:string,token:string)=>request(web).post('/api/sso/revoke').set('X-API-Key',key).send({token});
  await request(web).post('/api/sso/revoke').send({token:a.accessToken}).expect(401);
  await execute('UPDATE api_keys SET scopes=? WHERE application_id=?',[JSON.stringify(['identity:read']),a.id]);
  await revoke(a.key,a.accessToken).expect(403);
  await execute('UPDATE api_keys SET scopes=? WHERE application_id=?',[JSON.stringify(['identity:read','token:introspect','token:revoke']),a.id]);
  await revoke(a.key,b.accessToken).expect(200);assert.equal((await ssoModel.introspectToken(hashToken(b.key),hashToken(b.accessToken))).active,true);
  await revoke(a.key,a.accessToken).expect(200);await revoke(a.key,a.accessToken).expect(200);
  assert.equal((await ssoModel.introspectToken(hashToken(a.key),hashToken(a.accessToken))).active,false);
  assert.equal((await ssoModel.introspectToken(hashToken(b.key),hashToken(b.accessToken))).active,true);
  assert.ok(await auth.findSession(u.token));
});

test('Self logout-all is CSRF protected, owner-only and rolls back on audit failure',{skip:!enabled},async()=>{
  const u=await user(),other=await user(),s=await service(u),web=createApp();
  await assert.rejects(auth.deleteOwnSessions(u.userId,u.sessionId,async()=>{throw new Error('audit unavailable');}));
  assert.ok(await auth.findSession(u.token));assert.equal((await ssoModel.introspectToken(hashToken(s.key),hashToken(s.accessToken))).active,true);
  assert.equal(await auth.deleteOwnSessions(other.userId,u.sessionId,async()=>{}),false);
  await request(web).delete('/api/auth/sessions').set('Cookie',u.cookie).expect(403);
  await request(web).delete('/api/auth/sessions').set('Cookie',u.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',u.identity.csrfToken).expect(200);
  assert.equal(await auth.findSession(u.token),undefined);assert.ok(await auth.findSession(other.token));
  assert.equal((await ssoModel.introspectToken(hashToken(s.key),hashToken(s.accessToken))).active,false);
  assert.equal((await query('SELECT id FROM users WHERE id=? AND deleted_at IS NULL',[u.userId])).length,1);
});
