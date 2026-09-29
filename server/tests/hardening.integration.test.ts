import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { execute,query,pool } from '../src/db.js';
import * as auth from '../src/models/authModel.js';
import { listAudit } from '../src/models/adminModel.js';
import { createApp } from '../src/app.js';
import { sessionCookie } from '../src/middleware/security.js';
import { makeTotp } from '../src/services/totp.js';
import { randomToken,hashToken } from '../src/services/crypto.js';
const enabled=process.env.RUN_DB_TESTS==='1';
const owned:Array<{userId:string;email:string}>=[];const apps:string[]=[];
if(enabled){config.configured=true;config.sessionSecret=`hardening-test-${randomUUID()}`;}
async function fixture(role='user'){
  const email=`hardening-${randomUUID()}@example.test`,sub=randomUUID();
  await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,role]);
  const profile={email,sub,name:'Test',avatar:null};const s=await auth.startGoogleSession(profile);assert.ok(s);owned.push({...s,email});
  const identity=await auth.findSession(s.token);assert.ok(identity);
  return {...s,identity,profile,cookie:`${sessionCookie}=${s.token}`};
}
after(async()=>{if(enabled){for(const id of apps)await execute('DELETE FROM applications WHERE id=?',[id]);for(const u of owned){await execute('DELETE FROM users WHERE id=?',[u.userId]);await execute('DELETE FROM allowed_emails WHERE email=?',[u.email]);}}await pool.end();});
test('concurrent OTP requests issue once, persist cooldown across sessions and bind ref to the newest code',{skip:!enabled},async()=>{
  const s=await fixture();
  const result=await Promise.allSettled([auth.createOtp(s.sessionId,'012345'),auth.createOtp(s.sessionId,'012345'),auth.createOtp(s.sessionId,'012345')]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  for(const r of result)if(r.status==='rejected'){assert.ok(r.reason instanceof auth.OtpCooldownError);assert.ok(r.reason.retryAfter>0&&r.reason.retryAfter<=60);}
  const first=await auth.otpState(s.sessionId);assert.match(first.reference,/^[A-F0-9]{8}$/);
  assert.equal(await auth.verifyEmailOtp(s.sessionId,'012345',undefined,'00000000'),null);
  const other=await auth.startGoogleSession(s.profile);assert.ok(other);
  await assert.rejects(auth.createOtp(other.sessionId,'012345'),auth.OtpCooldownError);
  await execute('UPDATE users SET otp_sent_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE id=?',[s.userId]);
  await auth.createOtp(other.sessionId,'123456');const second=await auth.otpState(other.sessionId);assert.notEqual(first.reference,second.reference);
  assert.equal(await auth.verifyEmailOtp(other.sessionId,'123456',undefined,first.reference),null);
  assert.ok(await auth.verifyEmailOtp(other.sessionId,'123456',undefined,second.reference));
});
test('delivery failure leaves no usable OTP and returns persistent Retry-After; reload exposes cooldown',{skip:!enabled},async()=>{
  const s=await fixture(),app=createApp();config.mailConfigured=false;
  const send=()=>request(app).post('/api/auth/otp/send').set('Cookie',s.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',s.identity.csrfToken).send({});
  const failed=await send().expect(503);assert.equal(failed.body.code,'MAIL_UNAVAILABLE');
  const again=await send().expect(429);assert.equal(again.body.code,'OTP_COOLDOWN');assert.ok(Number(again.headers['retry-after'])>0);
  const me=await request(app).get('/api/auth/me').set('Cookie',s.cookie).expect(200);
  assert.equal(me.body.otp.reference,null);assert.ok(me.body.otp.retryAfter>0);
  assert.equal((await query('SELECT id FROM otp_challenges WHERE session_id=?',[s.sessionId])).length,0);
});
test('MFA failure counter and challenge attempt roll back if durable failure audit cannot be written',{skip:!enabled},async()=>{
  const s=await fixture();await auth.createOtp(s.sessionId,'012345');
  await assert.rejects(auth.verifyEmailOtp(s.sessionId,'000000',async()=>{throw new Error('outbox down');}));
  const [row]=await query<any>('SELECT u.mfa_failed_attempts,c.attempts FROM users u JOIN sessions s ON s.user_id=u.id JOIN otp_challenges c ON c.session_id=s.id WHERE u.id=?',[s.userId]);
  assert.equal(row.mfa_failed_attempts,0);assert.equal(row.attempts,0);
});
test('admin email session can enroll but cannot administer; old MFA must reauthenticate and replay is denied',{skip:!enabled},async()=>{
  const s=await fixture('admin');await auth.createOtp(s.sessionId,'012345');const token=await auth.verifyEmailOtp(s.sessionId,'012345');assert.ok(token);
  const identity=await auth.findSession(token);assert.ok(identity);const app=createApp(),cookie=`${sessionCookie}=${token}`;
  const blocked=await request(app).get('/api/admin/overview').set('Cookie',cookie).expect(403);assert.equal(blocked.body.code,'ADMIN_MFA_REQUIRED');
  const totp=makeTotp(s.profile.email);await auth.saveEnrollment(s.sessionId,totp.secret.base32,auth.generateRecoveryCodes());assert.equal(await auth.enableTotp(s.sessionId,totp.generate()),true);
  await request(app).get('/api/admin/overview').set('Cookie',cookie).expect(200);
  await execute('UPDATE sessions SET authenticated_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 6 MINUTE) WHERE id=?',[s.sessionId]);
  const write=await request(app).post('/api/admin/applications').set('Cookie',cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',identity.csrfToken).send({}).expect(403);
  assert.equal(write.body.code,'MFA_REAUTH_REQUIRED');
  await execute('UPDATE users SET totp_last_step=NULL WHERE id=?',[s.userId]);
  const reauth=()=>request(app).post('/api/auth/reauth').set('Cookie',cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',identity.csrfToken).send({code:totp.generate()});
  await reauth().expect(200);await reauth().expect(400);
  const created=await request(app).post('/api/admin/applications').set('Cookie',cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',identity.csrfToken).send({name:'After reauth',redirectUri:'https://example.test/callback'}).expect(201);apps.push(created.body.application.id);
});
test('audit keyset preserves ties without duplicates and rejects unbounded windows',{skip:!enabled},async()=>{
  const event=`hardening.${randomUUID()}`,when=new Date(Date.now()-1000);const ids=Array.from({length:5},()=>randomUUID()).sort().reverse();
  for(const id of ids)await execute("INSERT INTO audit_logs(id,event,metadata,created_at) VALUES (?,?,?,?)",[id,event,'{}',when]);
  const found:string[]=[];let cursor:string|undefined;
  do{const page=await listAudit({page:1,limit:2,search:'',event,cursor});found.push(...page.events.map(e=>e.id));cursor=page.meta.nextCursor??undefined;}while(cursor);
  assert.deepEqual(found,ids);
  await assert.rejects(listAudit({page:1,limit:2,search:'',startAt:new Date('2000-01-01'),endBefore:new Date()}),{code:'VALIDATION_ERROR'});
});
test('health polling and browser quota do not exhaust authenticated SSO; service quotas use registered identity',{skip:!enabled},async()=>{
  const app=createApp();const appId=randomUUID(),key=randomToken();apps.push(appId);
  await execute('INSERT INTO applications(id,name,redirect_uri) VALUES (?,?,?)',[appId,'Quota test','https://example.test/callback']);
  await execute('INSERT INTO api_keys(id,application_id,name,prefix,key_hash,scopes,expires_at) VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))',[randomUUID(),appId,'Test','test',hashToken(key),'["token:introspect"]']);
  for(let i=0;i<181;i++)await request(app).get('/api/health').expect(200);
  for(let i=0;i<181;i++)await request(app).get('/api/auth/status');
  await request(app).post('/api/sso/introspect').set('X-API-Key',key).send({token:randomToken()}).expect(200,{active:false});
  await execute('UPDATE api_keys SET revoked_at=UTC_TIMESTAMP(3) WHERE application_id=?',[appId]);
  await request(app).post('/api/sso/introspect').set('X-API-Key',key).send({token:randomToken()}).expect(401);
});
