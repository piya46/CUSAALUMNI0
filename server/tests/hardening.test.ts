import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { requestContext,normalizeIp,rateIp } from '../src/middleware/requestContext.js';
import { requireAdmin,requireRecentAdminMfa } from '../src/middleware/security.js';
import { redactAudit } from '../src/models/authModel.js';
import { renderOtpEmail,buildOtpMessage } from '../src/services/mail.js';

test('untrusted forwarded headers cannot forge audit IP; trusted loopback honors the nearest untrusted hop',async()=>{
  for(const trust of [false,'loopback']) {
    const app=express();app.set('trust proxy',trust);app.use(requestContext);app.get('/',(req,res)=>res.json({...req.context,bucket:rateIp(req)}));
    const result=await request(app).get('/').set('X-Forwarded-For','198.51.100.9, 203.0.113.20').set('X-Request-ID','forged');
    assert.equal(result.body.clientIp,trust?'203.0.113.20':'127.0.0.1');
    assert.equal(result.body.peerIp,'127.0.0.1');assert.notEqual(result.body.requestId,'forged');
    assert.equal(result.headers['x-request-id'],result.body.requestId);
  }
  assert.equal(normalizeIp('::ffff:192.0.2.5'),'192.0.2.5');
  assert.equal(rateIp({ip:'2001:db8:abcd:1201::1'} as any),rateIp({ip:'2001:db8:abcd:12ff::9'} as any));
});
test('admin requires TOTP and recent MFA for writes, while allowing older TOTP reads',()=>{
  const req:any={identity:{kind:'full',role:'admin',totpEnabled:true,mfaMethod:'email',authenticatedAt:new Date()},method:'POST'};
  assert.throws(()=>requireAdmin(req,{} as any,()=>{}),{code:'ADMIN_MFA_REQUIRED'});
  req.identity.mfaMethod='recovery';assert.throws(()=>requireAdmin(req,{} as any,()=>{}),{code:'ADMIN_MFA_REQUIRED'});
  req.identity.mfaMethod='totp';requireAdmin(req,{} as any,()=>{});
  requireRecentAdminMfa(req,{} as any,()=>{}); // The login's fresh TOTP already authorizes writes.
  req.identity.authenticatedAt=new Date(Date.now()-301000);assert.throws(()=>requireRecentAdminMfa(req,{} as any,()=>{}),{code:'MFA_REAUTH_REQUIRED'});
  req.method='GET';requireRecentAdminMfa(req,{} as any,()=>{});
});
test('OTP mail has CUSA SSO sender, matching ref and escaped server-side purpose in both MIME alternatives',()=>{
  const {html,text}=renderOtpEmail('012345','ABC12345','Service <unsafe> & name');
  assert.match(text,/วัตถุประสงค์: ยืนยันการเข้าสู่ระบบ CUSA SSO เพื่อเข้าใช้งาน Service <unsafe>/);
  assert.match(html,/Service &lt;unsafe&gt; &amp; name/);assert.doesNotMatch(html,/<unsafe>/);
  for(const part of [text,html]){assert.match(part,/012345/);assert.match(part,/ABC12345/);}
  const message=buildOtpMessage('test@example.com','012345','ABC12345');
  assert.match(message,/^From: CUSA SSO </);assert.doesNotMatch(message,/CUSA Identity/i);
  assert.match(message,/multipart\/alternative/);assert.match(message,/text\/plain/);assert.match(message,/text\/html/);
  assert.throws(()=>buildOtpMessage('test@example.com\r\nBcc: other@example.com','012345','ABC12345'));
});
test('audit redacts nested credentials but preserves role changes and failure classifications',()=>{
  assert.deepEqual(redactAudit({before:{roleIds:['a']},after:{roleIds:['b']},code:'123456',access_token:'secret',failure_reason:'INVALID_CODE'}),
    {before:{roleIds:['a']},after:{roleIds:['b']},code:'[redacted]',access_token:'[redacted]',failure_reason:'INVALID_CODE'});
});
