import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,execute,pool } from '../src/db.js';
import * as model from '../src/models/authModel.js';
import { hashToken,randomToken } from '../src/services/crypto.js';
import { makeTotp } from '../src/services/totp.js';

const enabled=process.env.RUN_DB_TESTS==='1';
const users:string[]=[]; const emails:string[]=[];
async function fixture(){
  const email=`auth-${randomUUID()}@example.com`; emails.push(email);
  await execute('INSERT INTO allowed_emails (id,email,role) VALUES (?, ?, \'user\')',[randomUUID(),email]);
  const session=await model.startGoogleSession({sub:randomUUID(),email,name:'Auth test',avatar:null}); assert.ok(session);
  users.push(session.userId); const identity=await model.findSession(session.token); assert.ok(identity);
  return {email,...session,sessionId:identity.sessionId};
}
after(async()=>{
  if(enabled){for(const id of users)await execute('DELETE FROM users WHERE id=?',[id]);for(const email of emails)await execute('DELETE FROM allowed_emails WHERE email=?',[email]);}
  await pool.end();
});
test('OTP promotion rotates credential and concurrent reuse succeeds exactly once',{skip:!enabled},async()=>{
  const s=await fixture(); await model.createOtp(s.sessionId,'654321');
  const results=await Promise.all([model.verifyEmailOtp(s.sessionId,'654321'),model.verifyEmailOtp(s.sessionId,'654321')]);
  assert.equal(results.filter(Boolean).length,1); assert.equal(await model.findSession(s.token),undefined);
  const full=await model.findSession(results.find(Boolean)!); assert.equal(full?.kind,'full'); assert.equal(full?.mfaMethod,'email');
});
test('five failed MFA attempts lock account across newly created Google sessions',{skip:!enabled},async()=>{
  const s=await fixture(); await model.createOtp(s.sessionId,'654321');
  for(let i=0;i<5;i++)assert.equal(await model.verifyEmailOtp(s.sessionId,'000000'),null);
  assert.equal(await model.isMfaLocked(s.userId),true); assert.equal(await model.verifyEmailOtp(s.sessionId,'654321'),null);
  const [r]=await query<any>('SELECT mfa_failed_attempts,mfa_locked_until FROM users WHERE id=?',[s.userId]); assert.equal(r.mfa_failed_attempts,5);
  await execute('UPDATE users SET mfa_locked_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[s.userId]);
  await model.createOtp(s.sessionId,'112233');
  assert.ok(await model.verifyEmailOtp(s.sessionId,'112233')); assert.equal(await model.isMfaLocked(s.userId),false);
});
test('recovery codes activate after TOTP confirmation and are single use',{skip:!enabled},async()=>{
  const s=await fixture(); await model.createOtp(s.sessionId,'654321'); await model.verifyEmailOtp(s.sessionId,'654321');
  const totp=makeTotp(s.email); const codes=model.generateRecoveryCodes();
  await model.saveEnrollment(s.sessionId,totp.secret.base32,codes); assert.equal(await model.recoveryCodesRemaining(s.userId),0);
  assert.equal(await model.enableTotp(s.sessionId,totp.generate()),true); assert.equal(await model.recoveryCodesRemaining(s.userId),10);
  const [stored]=await query<any>('SELECT code_hash FROM mfa_recovery_codes WHERE user_id=? LIMIT 1',[s.userId]); assert.ok(!codes.includes(stored.code_hash));
  const pendingId=randomUUID(); const pendingToken=randomToken();
  await execute('INSERT INTO sessions (id,token_hash,user_id,kind,csrf_token,expires_at) VALUES (?,?,?,\'pending\',?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))',[pendingId,hashToken(pendingToken),s.userId,randomToken()]);
  const results=await Promise.all([model.verifyRecovery(pendingId,codes[0]),model.verifyRecovery(pendingId,codes[0])]);
  assert.equal(results.filter(Boolean).length,1); assert.equal((await model.findSession(results.find(Boolean)!))?.mfaMethod,'recovery'); assert.equal(await model.recoveryCodesRemaining(s.userId),9);
});
test('concurrent session policy retains new session plus two most recent devices',{skip:!enabled},async()=>{
  const s=await fixture();
  for(let i=0;i<4;i++) await execute('INSERT INTO sessions (id,token_hash,user_id,kind,csrf_token,mfa_method,authenticated_at,expires_at) VALUES (?,?,?,\'full\',?,\'email\',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))',[randomUUID(),hashToken(randomToken()),s.userId,randomToken()]);
  await model.createOtp(s.sessionId,'654321'); assert.ok(await model.verifyEmailOtp(s.sessionId,'654321'));
  assert.equal((await model.listSessions(s.userId)).length,3);
});
test('removing an allowlisted email immediately blocks existing session lookup',{skip:!enabled},async()=>{
  const s=await fixture(); await model.createOtp(s.sessionId,'654321'); const token=await model.verifyEmailOtp(s.sessionId,'654321'); assert.ok(token);
  await execute('DELETE FROM allowed_emails WHERE email=?',[s.email]); assert.equal(await model.findSession(token),undefined);
});
test('audit enqueue failure rolls back session promotion and leaves OTP usable',{skip:!enabled},async()=>{
  const s=await fixture();await model.createOtp(s.sessionId,'654321');
  await assert.rejects(model.verifyEmailOtp(s.sessionId,'654321',async()=>{throw new Error('simulated outbox outage');}));
  assert.equal((await model.findSession(s.token))?.kind,'pending');
  assert.ok(await model.verifyEmailOtp(s.sessionId,'654321'));
});
test('audit failure preserves previous recovery codes and TOTP time step',{skip:!enabled},async()=>{
  const s=await fixture();await model.createOtp(s.sessionId,'654321');await model.verifyEmailOtp(s.sessionId,'654321');
  const totp=makeTotp(s.email),codes=model.generateRecoveryCodes();await model.saveEnrollment(s.sessionId,totp.secret.base32,codes);await model.enableTotp(s.sessionId,totp.generate());
  await execute('UPDATE users SET totp_last_step=NULL WHERE id=?',[s.userId]);
  await assert.rejects(model.regenerateRecovery(s.sessionId,totp.generate(),async()=>{throw new Error('simulated outbox outage');}));
  const rows=await query<any>('SELECT code_hash FROM mfa_recovery_codes WHERE user_id=?',[s.userId]);
  assert.deepEqual(rows.map(r=>r.code_hash).sort(),codes.map(hashToken).sort());
  assert.equal((await query<any>('SELECT totp_last_step FROM users WHERE id=?',[s.userId]))[0].totp_last_step,null);
});
