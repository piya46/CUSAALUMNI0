import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomToken,hashToken,seal,unseal,otpHash,verifyOtpHash } from '../src/services/crypto.js';
import { makeTotp,totpStep } from '../src/services/totp.js';
import { safeReturnTo } from '../src/controllers/authController.js';

test('high entropy token hashes use a deterministic keyed digest, not a plain SHA digest',()=>{
  const token=randomToken(); assert.equal(token.length,43); assert.equal(hashToken(token).length,64);
  assert.equal(hashToken(token),hashToken(token)); assert.notEqual(hashToken(token),createHash('sha256').update(token).digest('hex'));
  assert.notEqual(hashToken(token),hashToken(randomToken()));
});
test('AES-GCM rejects tampering and uses random IVs',()=>{
  const a=seal('totp-secret'); const b=seal('totp-secret'); assert.notEqual(a,b); assert.equal(unseal(a),'totp-secret');
  const pieces=a.split('.'); const encrypted=Buffer.from(pieces[2],'base64url'); encrypted[0]^=1; pieces[2]=encrypted.toString('base64url');
  assert.throws(()=>unseal(pieces.join('.')));
});
test('Argon2id OTP is salted, bound to its session and verifies only matching code',async()=>{
  const a=await otpHash('session-a','012345'); const b=await otpHash('session-a','012345');
  assert.match(a,/^\$argon2id\$/); assert.notEqual(a,b);
  assert.equal(await verifyOtpHash(a,'session-a','012345'),true);
  assert.equal(await verifyOtpHash(a,'session-b','012345'),false);
  assert.equal(await verifyOtpHash(a,'session-a','012346'),false);
});
test('TOTP validates the expected time step and rejects expired codes',()=>{
  const totp=makeTotp('test@example.com'); const time=1700000000000;
  const token=totp.generate({timestamp:time}); assert.equal(totpStep('test@example.com',totp.secret.base32,token,time),Math.floor(time/30000));
  assert.equal(totpStep('test@example.com',totp.secret.base32,token,time+120000),null);
});
test('post-login navigation allows only local SSO authorization endpoint',()=>{
  assert.equal(safeReturnTo('https://attacker.example'),''); assert.equal(safeReturnTo('//attacker.example'),'');
  assert.equal(safeReturnTo('/api/sso/authorize?client_id=one'),'/api/sso/authorize?client_id=one');
  assert.equal(safeReturnTo('/api/sso/authorize?x=1\r\nLocation: https://attacker.example'),'');
});
