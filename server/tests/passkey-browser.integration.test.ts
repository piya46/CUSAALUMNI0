import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { config } from '../src/config.js';
import { execute,pool } from '../src/db.js';
import { hashToken,randomToken,seal } from '../src/services/crypto.js';
import { registrationOptions,registerPasskey,authenticationOptions,authenticatePasskey } from '../src/models/passkeyModel.js';
import { findSession } from '../src/models/authModel.js';
const enabled=process.env.RUN_DB_TESTS==='1';
test('real WebAuthn registration and assertions: enforce RP/origin/UV, rotate session and reject replay',{skip:!enabled,timeout:30000},async()=>{
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic WebAuthn test</title>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const oldOrigin=config.appOrigin;config.appOrigin=`http://localhost:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),headless:true});
  const id=randomUUID(),email=`webauthn-${id}@example.test`,sessionId=randomUUID(),token=randomToken();
  try{
    await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,'user']);
    await execute('INSERT INTO users(id,google_sub,email,name,totp_secret) VALUES (?,?,?,?,?)',[id,id,email,'WebAuthn fixture',seal('JBSWY3DPEHPK3PXP')]);
    await execute("INSERT INTO sessions(id,user_id,token_hash,csrf_token,kind,mfa_method,authenticated_at,expires_at) VALUES (?,?,?,?,'full','totp',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[sessionId,id,hashToken(token),randomToken()]);
    const page=await browser.newPage();const cdp=await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');const authenticator=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    await page.goto(config.appOrigin);
    // tsx/esbuild preserves function names using this helper inside evaluate.
    await page.evaluate('window.__name = (fn) => fn');
    const opts=await registrationOptions(sessionId,async()=>{});
    const registration=await page.evaluate(async(options:any)=>{
      const decode=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      const encode=(v:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const c=await navigator.credentials.create({publicKey:{...options,challenge:decode(options.challenge),user:{...options.user,id:decode(options.user.id)},excludeCredentials:[]}}) as PublicKeyCredential;
      const r=c.response as AuthenticatorAttestationResponse;
      return {id:c.id,rawId:encode(c.rawId),type:'public-key' as const,response:{clientDataJSON:encode(r.clientDataJSON),attestationObject:encode(r.attestationObject),transports:r.getTransports()},clientExtensionResults:c.getClientExtensionResults()};
    },opts.options);
    assert.equal(await registerPasskey(sessionId,opts.challengeId,'Virtual authenticator',registration as any,async()=>{}),true);
    await execute("UPDATE sessions SET kind='pending',mfa_method=NULL WHERE id=?",[sessionId]);
    const assertion=async()=>{
      const opts=await authenticationOptions(sessionId);
      const response=await page.evaluate(async(options:any)=>{
        const decode=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
        const encode=(v:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        const c=await navigator.credentials.get({publicKey:{...options,challenge:decode(options.challenge),allowCredentials:options.allowCredentials.map((v:any)=>({...v,id:decode(v.id)}))}}) as PublicKeyCredential;
        const r=c.response as AuthenticatorAssertionResponse;
        return {id:c.id,rawId:encode(c.rawId),type:'public-key' as const,response:{clientDataJSON:encode(r.clientDataJSON),authenticatorData:encode(r.authenticatorData),signature:encode(r.signature),...(r.userHandle?{userHandle:encode(r.userHandle)}:{})},clientExtensionResults:c.getClientExtensionResults()};
      },opts.options);return {...opts,response};
    };
    const wrongOrigin=await assertion();const origin=config.appOrigin;config.appOrigin='https://other.example.test';
    assert.equal(await authenticatePasskey(sessionId,wrongOrigin.challengeId,wrongOrigin.response,async()=>{}),null);config.appOrigin=origin;
    // An unverified authenticator response cannot satisfy the server's required UV policy.
    await cdp.send('WebAuthn.setUserVerified',{authenticatorId:authenticator.authenticatorId,isUserVerified:false});
    const noUv=await authenticationOptions(sessionId);
    const noUvResponse=await page.evaluate(async(options:any)=>{
      const decode=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      const encode=(v:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const c=await navigator.credentials.get({publicKey:{...options,userVerification:'discouraged',challenge:decode(options.challenge),allowCredentials:options.allowCredentials.map((v:any)=>({...v,id:decode(v.id)}))}}) as PublicKeyCredential;
      const r=c.response as AuthenticatorAssertionResponse;
      return {id:c.id,rawId:encode(c.rawId),type:'public-key' as const,response:{clientDataJSON:encode(r.clientDataJSON),authenticatorData:encode(r.authenticatorData),signature:encode(r.signature)},clientExtensionResults:{}};
    },noUv.options);
    assert.equal(await authenticatePasskey(sessionId,noUv.challengeId,noUvResponse,async()=>{}),null);
    await cdp.send('WebAuthn.setUserVerified',{authenticatorId:authenticator.authenticatorId,isUserVerified:true});
    const valid=await assertion();const promoted=await authenticatePasskey(sessionId,valid.challengeId,valid.response,async()=>{});assert.ok(promoted);
    assert.equal((await findSession(promoted))?.mfaMethod,'passkey');assert.equal(await findSession(token),undefined);
    await assert.rejects(authenticatePasskey(sessionId,valid.challengeId,valid.response,async()=>{}),{code:'MFA_REQUIRED'});
  }finally{config.appOrigin=oldOrigin;await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await execute('DELETE FROM users WHERE id=?',[id]);await execute('DELETE FROM allowed_emails WHERE email=?',[email]);await pool.end();}
});
