import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { execute,pool } from '../src/db.js';
import * as model from '../src/models/authModel.js';
import { sessionCookie } from '../src/middleware/security.js';
const enabled=process.env.RUN_DB_TESTS==='1';
if(enabled)config.configured=true;
const app=createApp();const created:Array<{id:string;email:string}>=[];
async function fixture(){
  const email=`http-${randomUUID()}@example.com`;
  await execute('INSERT INTO allowed_emails (id,email,role) VALUES (?,?,\'user\')',[randomUUID(),email]);
  const s=await model.startGoogleSession({sub:randomUUID(),email,name:'HTTP test',avatar:null});assert.ok(s);created.push({id:s.userId,email});
  const identity=await model.findSession(s.token);assert.ok(identity);return {...s,identity,cookie:`${sessionCookie}=${s.token}`};
}
after(async()=>{for(const row of created){await execute('DELETE FROM users WHERE id=?',[row.id]);await execute('DELETE FROM allowed_emails WHERE email=?',[row.email]);}await pool.end();});
test('HTTP auth enforces CSRF, MFA, validation, rotation and role boundaries',{skip:!enabled},async()=>{
  const s=await fixture();
  const me=await request(app).get('/api/auth/me').set('Cookie',s.cookie).expect(200);
  assert.equal(me.body.status,'mfa_required');assert.equal(me.body.mfaMethod,'email');assert.equal(me.body.sessionId,undefined);assert.equal(JSON.stringify(me.body).includes(s.token),false);
  await request(app).get('/api/admin/overview').set('Cookie',s.cookie).expect(403);
  await request(app).post('/api/auth/otp/verify').set('Cookie',s.cookie).set('Origin','https://evil.example').set('X-CSRF-Token',s.identity.csrfToken).send({code:'654321'}).expect(403);
  await request(app).post('/api/auth/otp/verify').set('Cookie',s.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',s.identity.csrfToken).send({code:'invalid'}).expect(400);
  await model.createOtp(s.sessionId,'654321');
  const {reference}=await model.otpState(s.sessionId);
  const verified=await request(app).post('/api/auth/otp/verify').set('Cookie',s.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',s.identity.csrfToken).send({code:'654321',reference}).expect(200);
  const cookies=verified.headers['set-cookie'] as unknown as string[];const credential=cookies[0];
  assert.match(credential,/HttpOnly/);assert.match(credential,/SameSite=Lax/);assert.ok(!credential.includes(s.token));
  await request(app).get('/api/auth/me').set('Cookie',s.cookie).expect(401);
  await request(app).get('/api/admin/overview').set('Cookie',credential.split(';')[0]).expect(403);
});
test('an existing trusted session can manage devices even while MFA account is locked',{skip:!enabled},async()=>{
  const s=await fixture();await model.createOtp(s.sessionId,'654321');const token=await model.verifyEmailOtp(s.sessionId,'654321');assert.ok(token);
  await execute('UPDATE users SET mfa_failed_attempts=5,mfa_locked_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE) WHERE id=?',[s.userId]);
  const cookie=`${sessionCookie}=${token}`;const identity=await model.findSession(token);assert.ok(identity);
  await request(app).get('/api/auth/sessions').set('Cookie',cookie).expect(200);
  await request(app).delete(`/api/auth/sessions/${s.sessionId}`).set('Cookie',cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',identity.csrfToken).expect(200);
});
