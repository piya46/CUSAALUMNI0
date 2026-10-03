import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { requestContext,normalizeIp,rateIp } from '../src/middleware/requestContext.js';
import { requireAdmin,requireRecentAdminMfa,requireFreshMfa } from '../src/middleware/security.js';
import { hasAdminMfa,isFreshStrongMfa } from '../src/services/mfaPolicy.js';
import { lockAdministrators } from '../src/models/adminModel.js';
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
test('admin accepts TOTP or Passkey, reuses fresh MFA for writes and permits older strong-MFA reads',()=>{
  const req:any={identity:{kind:'full',role:'admin',totpEnabled:true,mfaMethod:'email',authenticatedAt:new Date()},method:'POST'};
  for(const method of ['email','line','recovery','phone',null]){
    req.identity.mfaMethod=method;
    assert.equal(hasAdminMfa(req.identity),false);
    assert.throws(()=>requireAdmin(req,{} as any,()=>{}),{code:'ADMIN_MFA_REQUIRED'});
    assert.throws(()=>requireFreshMfa(req,{} as any,()=>{}),{code:'MFA_REAUTH_REQUIRED'});
  }
  for(const method of ['totp','passkey']){
    req.identity.mfaMethod=method;req.identity.authenticatedAt=new Date();req.method='POST';
    assert.equal(hasAdminMfa(req.identity),true);requireAdmin(req,{} as any,()=>{});
    requireRecentAdminMfa(req,{} as any,()=>{});
    req.identity.authenticatedAt=new Date(Date.now()-301000);
    assert.throws(()=>requireRecentAdminMfa(req,{} as any,()=>{}),{code:'MFA_REAUTH_REQUIRED'});
    req.method='GET';requireAdmin(req,{} as any,()=>{});requireRecentAdminMfa(req,{} as any,()=>{});
    // Viewing private evidence is a sensitive GET: its explicit freshness gate remains enforced.
    assert.throws(()=>requireFreshMfa(req,{} as any,()=>{}),{code:'MFA_REAUTH_REQUIRED'});
    req.identity.kind='pending';assert.equal(hasAdminMfa(req.identity),false);
    assert.throws(()=>requireAdmin(req,{} as any,()=>{}),{code:'FORBIDDEN'});req.identity.kind='full';
    req.identity.totpEnabled=false;assert.equal(hasAdminMfa(req.identity),false);
    assert.throws(()=>requireAdmin(req,{} as any,()=>{}),{code:'ADMIN_MFA_REQUIRED'});req.identity.totpEnabled=true;
  }
  const now=Date.now();
  for(const at of [null,undefined,'invalid',new Date(now+10001),new Date(now-300001)])assert.equal(isFreshStrongMfa('passkey',at,now),false);
  assert.equal(isFreshStrongMfa('passkey',new Date(now-300000),now),true);
});
test('administrative transactions recheck locked assurance and a revoked administrator',async()=>{
  const actor={userId:'admin-user',email:'admin@example.test',sessionId:'admin-session'};
  let method='passkey',at=new Date(),revoked=false,sessionExists=true;
  const conn:any={execute:async(sql:string,params:unknown[])=>{
    assert.ok(sql.includes('FOR UPDATE'));
    if(sql.includes('FROM allowed_emails'))return [[...(revoked?[]:[{id:'admin',email:actor.email,role:'admin'}])]];
    assert.deepEqual(params,[actor.sessionId,actor.userId]);
    return [[...(sessionExists?[{id:actor.sessionId,mfa_method:method,authenticated_at:at}]:[])]];
  }};
  for(method of ['totp','passkey']){
    at=new Date();await lockAdministrators(actor,conn);
    at=new Date(Date.now()-301000);await assert.rejects(lockAdministrators(actor,conn),{code:'MFA_REAUTH_REQUIRED'});
    at=new Date(Date.now()+30000);await assert.rejects(lockAdministrators(actor,conn),{code:'MFA_REAUTH_REQUIRED'});
  }
  at=new Date();
  for(method of ['line','email','recovery'])await assert.rejects(lockAdministrators(actor,conn),{code:'MFA_REAUTH_REQUIRED'});
  method='passkey';sessionExists=false;await assert.rejects(lockAdministrators(actor,conn),{code:'MFA_REAUTH_REQUIRED'});
  sessionExists=true;revoked=true;await assert.rejects(lockAdministrators(actor,conn),{code:'ADMIN_REVOKED'});
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
