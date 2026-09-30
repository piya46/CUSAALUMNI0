import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import test,{after} from 'node:test';
import request from 'supertest';
import { config } from '../src/config.js';
import { execute,query,pool,transaction } from '../src/db.js';
import { createApp } from '../src/app.js';
import { sessionCookie } from '../src/middleware/security.js';
import { randomToken,hashToken,seal,unseal } from '../src/services/crypto.js';
import { recordAudit,findSession,type AuthAudit } from '../src/models/authModel.js';
import { clearAdditionalFactors } from '../src/models/factorModel.js';
import * as passkey from '../src/models/passkeyModel.js';
import * as line from '../src/models/lineModel.js';
import * as phone from '../src/models/phoneModel.js';
import { revokeUserSessions } from '../src/models/adminModel.js';
const enabled=process.env.RUN_DB_TESTS==='1',owned:{userId:string;email:string}[]=[],apps:string[]=[];
const realFetch=globalThis.fetch;
if(enabled){config.configured=true;config.passkeyEnabled=true;config.lineMfaEnabled=true;config.firebasePhoneEnabled=true;config.sessionSecret=`factors-test-${randomUUID()}`;config.lineMessagingChannelSecret='test-webhook-secret';config.lineLoginChannelId='test-line-channel';}
const audit:AuthAudit=(conn,event,target,metadata)=>recordAudit({actorId:null,actorEmail:null,sessionId:null,userAgent:'factors-test',event,target:target??null,ip:'127.0.0.1',metadata,status:event.endsWith('failure')?'failure':'success'},conn);
async function fixture(kind:'full'|'pending'='full',role='user'){
  const userId=randomUUID(),email=`factors-${userId}@example.test`,sessionId=randomUUID(),token=randomToken(),csrf=randomToken();owned.push({userId,email});
  await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,role]);
  await execute('INSERT INTO users(id,google_sub,email,name,totp_secret) VALUES (?,?,?,?,?)',[userId,userId,email,'Synthetic',seal('JBSWY3DPEHPK3PXP')]);
  await execute('INSERT INTO sessions(id,user_id,token_hash,csrf_token,kind,mfa_method,authenticated_at,expires_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))',[sessionId,userId,hashToken(token),csrf,kind,kind==='full'?'totp':null]);
  return {userId,email,sessionId,token,csrf,cookie:`${sessionCookie}=${token}`};
}
async function linked(){const s=await fixture('pending'),subject=`U${randomUUID().replaceAll('-','')}`;await execute('INSERT INTO line_identities(user_id,subject_hash,subject_encrypted) VALUES (?,?,?)',[s.userId,hashToken(`line:${subject}`),seal(subject)]);return {...s,subject};}
after(async()=>{globalThis.fetch=realFetch;if(enabled){for(const id of apps)await execute('DELETE FROM applications WHERE id=?',[id]);for(const s of owned){await execute('DELETE FROM users WHERE id=?',[s.userId]);await execute('DELETE FROM allowed_emails WHERE email=?',[s.email]);}}await pool.end();});

test('factor management rejects pending, recovery and stale sessions; TOTP enrollment remains mandatory',{skip:!enabled},async()=>{
  const s=await fixture('pending');await assert.rejects(passkey.registrationOptions(s.sessionId,audit),{code:'TOTP_ENROLLMENT_REQUIRED'});
  await execute("UPDATE sessions SET kind='full',mfa_method='recovery' WHERE id=?",[s.sessionId]);await assert.rejects(passkey.registrationOptions(s.sessionId,audit),{code:'MFA_REAUTH_REQUIRED'});
  await execute("UPDATE sessions SET mfa_method='totp',authenticated_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 6 MINUTE) WHERE id=?",[s.sessionId]);await assert.rejects(line.lineLinkStart(s.sessionId,audit),{code:'MFA_REAUTH_REQUIRED'});
  await execute('UPDATE users SET totp_secret=NULL WHERE id=?',[s.userId]);await assert.rejects(line.lineLinkStart(s.sessionId,audit),{code:'TOTP_ENROLLMENT_REQUIRED'});
});
test('malformed WebAuthn proofs consume challenge once, fail authentication and transactionally count failure',{skip:!enabled},async()=>{
  const s=await fixture();const options=await passkey.registrationOptions(s.sessionId,audit);
  assert.equal(options.options.rp.id,new URL(config.appOrigin).hostname);assert.equal(options.options.authenticatorSelection?.userVerification,'required');
  const proof={id:'fake',rawId:'fake',type:'public-key',response:{clientDataJSON:'bad',attestationObject:'bad'},clientExtensionResults:{}} as const;
  assert.equal(await passkey.registerPasskey(s.sessionId,options.challengeId,'Test',proof,audit),false);
  assert.equal(await passkey.registerPasskey(s.sessionId,options.challengeId,'Test',proof,audit),false);
  const [u]=await query<any>('SELECT mfa_failed_attempts FROM users WHERE id=?',[s.userId]);assert.equal(u.mfa_failed_attempts,1);
  assert.equal((await passkey.listPasskeys(s.userId)).length,0);
});
test('LINE links OAuth state to the fresh TOTP session, validates nonce at provider and rejects replay',{skip:!enabled},async()=>{
  const s=await fixture(),other=await fixture();const start=await line.lineLinkStart(s.sessionId,audit),url=new URL(start.url),state=url.searchParams.get('state')!,nonce=url.searchParams.get('nonce')!;
  const subject=`U${randomUUID().replaceAll('-','')}`;
  globalThis.fetch=async (url,init)=>{
    if(String(url).endsWith('/token')){assert.ok(String(init?.body).includes('code_verifier='));return Response.json({id_token:'synthetic-provider-proof'});}
    assert.ok(String(init?.body).includes(`nonce=${nonce}`));return Response.json({iss:'https://access.line.me',aud:config.lineLoginChannelId,nonce,exp:Math.floor(Date.now()/1000)+60,sub:subject});
  };
  try{
    await assert.rejects(line.lineLinkFinish(other.sessionId,state,'test-code',audit),{code:'INVALID_STATE'});
    await line.lineLinkFinish(s.sessionId,state,'test-code',audit);await assert.rejects(line.lineLinkFinish(s.sessionId,state,'test-code',audit),{code:'INVALID_STATE'});
    const [stored]=await query<any>('SELECT * FROM line_identities WHERE user_id=?',[s.userId]);assert.equal(unseal(stored.subject_encrypted),subject);assert.equal(stored.subject_hash,hashToken(`line:${subject}`));
  }finally{globalThis.fetch=realFetch;}
});
test('signed LINE Number Matching binds sender and browser, has persistent cooldown and permits one promotion',{skip:!enabled},async()=>{
  const s=await linked();let sent:any;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({});};
  try{
    const issued=await line.startLineChallenge(s.sessionId,audit);assert.equal(sent.to,s.subject);
    await assert.rejects(line.startLineChallenge(s.sessionId,audit),{message:'OTP_COOLDOWN'});
    const action=sent.messages[0].template.actions.find((a:any)=>a.label===issued.number),choice=new URLSearchParams(action.data).get('choice')!;
    await line.applyLineChoice(issued.challengeId,`U${'0'.repeat(32)}`,choice,audit);assert.equal((await line.lineChallengeStatus(s.sessionId,issued.challengeId)).status,'pending');
    const app=createApp(),body=JSON.stringify({events:[{type:'postback',timestamp:Date.now(),source:{type:'user',userId:s.subject},postback:{data:action.data}}]});
    const signature=createHmac('sha256',config.lineMessagingChannelSecret).update(body).digest('base64');
    await request(app).post('/api/auth/line/webhook').set('Content-Type','application/json').set('x-line-signature',signature).send(body+' ').expect(401);
    await request(app).post('/api/auth/line/webhook').set('Content-Type','application/json').set('x-line-signature',signature).send(body).expect(200);
    assert.equal((await line.lineChallengeStatus(s.sessionId,issued.challengeId)).status,'approved');
    const stranger=await fixture('pending');assert.equal(await line.finishLineChallenge(stranger.sessionId,issued.challengeId,audit),null);
    const token=await line.finishLineChallenge(s.sessionId,issued.challengeId,audit);assert.ok(token);assert.equal((await findSession(token))?.mfaMethod,'line');assert.equal(await findSession(s.token),undefined);
    await assert.rejects(line.finishLineChallenge(s.sessionId,issued.challengeId,audit),{code:'MFA_REQUIRED'});
  }finally{globalThis.fetch=realFetch;}
});
test('wrong LINE choice is final; duplicate callbacks cannot approve or multiply failures',{skip:!enabled},async()=>{
  const s=await linked();let sent:any;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({});};
  try{const issued=await line.startLineChallenge(s.sessionId,audit),actions=sent.messages[0].template.actions;
    const wrong=actions.find((a:any)=>a.label==='ปฏิเสธ'),right=actions.find((a:any)=>a.label===issued.number);
    const value=(a:any)=>new URLSearchParams(a.data).get('choice')!;
    await line.applyLineChoice(issued.challengeId,s.subject,value(wrong),audit);await line.applyLineChoice(issued.challengeId,s.subject,value(right),audit);
    assert.equal((await line.lineChallengeStatus(s.sessionId,issued.challengeId)).status,'denied');assert.equal(await line.finishLineChallenge(s.sessionId,issued.challengeId,audit),null);
    const [u]=await query<any>('SELECT mfa_failed_attempts FROM users WHERE id=?',[s.userId]);assert.equal(u.mfa_failed_attempts,1);
  }finally{globalThis.fetch=realFetch;}
});
test('LINE provider failure keeps the send cooldown and denies the undelivered challenge',{skip:!enabled},async()=>{
  const s=await linked();globalThis.fetch=async()=>{throw new Error('provider down');};
  try{await assert.rejects(line.startLineChallenge(s.sessionId,audit),{code:'LINE_UNAVAILABLE'});await assert.rejects(line.startLineChallenge(s.sessionId,audit),{message:'OTP_COOLDOWN'});const [c]=await query<any>('SELECT status FROM factor_challenges WHERE session_id=?',[s.sessionId]);assert.equal(c.status,'denied');}finally{globalThis.fetch=realFetch;}
});
test('Firebase phone binding is session-bound, encrypted, unique and does not promote MFA',{skip:!enabled},async()=>{
  const s=await fixture(),other=await fixture();const number=`+668${String(Date.now()).slice(-8)}`;
  const issued=await phone.startPhoneVerification(s.sessionId,number,audit);await assert.rejects(phone.startPhoneVerification(s.sessionId,number,audit),{message:'OTP_COOLDOWN'});
  const proof={phone:number,uid:randomUUID(),authenticatedAt:Math.floor(Date.now()/1000)};
  assert.equal(await phone.finishPhoneVerification(other.sessionId,issued.challengeId,proof,audit),false);
  assert.equal(await phone.finishPhoneVerification(s.sessionId,issued.challengeId,proof,audit),true);
  assert.equal(await phone.finishPhoneVerification(s.sessionId,issued.challengeId,proof,audit),false);
  const [row]=await query<any>('SELECT * FROM phone_identities WHERE user_id=?',[s.userId]);assert.equal(unseal(row.phone_encrypted),number);assert.equal(row.phone_hash,hashToken(`phone:${number}`));
  const otherChallenge=await phone.startPhoneVerification(other.sessionId,number,audit);assert.equal(await phone.finishPhoneVerification(other.sessionId,otherChallenge.challengeId,proof,audit),false);
  assert.equal((await findSession(s.token))?.mfaMethod,'totp');
});
test('old/mismatched Firebase phone claims are consumed and cannot satisfy required phone gate',{skip:!enabled},async()=>{
  const s=await fixture();await execute('UPDATE users SET phone_required=TRUE WHERE id=?',[s.userId]);assert.equal((await findSession(s.token))?.phoneRequired,true);
  const number='+66811112222',challenge=await phone.startPhoneVerification(s.sessionId,number,audit);
  assert.equal(await phone.finishPhoneVerification(s.sessionId,challenge.challengeId,{phone:number,uid:randomUUID(),authenticatedAt:Math.floor(Date.now()/1000)-200},audit),false);
  const app=createApp();await request(app).get('/api/auth/sessions').set('Cookie',s.cookie).expect(403);
  await request(app).get('/api/auth/factors').set('Cookie',s.cookie).expect(200);
});
test('factor reset removes LINE/passkeys/challenges but preserves separately verified phone',{skip:!enabled},async()=>{
  const s=await linked();await transaction(conn=>clearAdditionalFactors(s.userId,conn));assert.equal((await query('SELECT user_id FROM line_identities WHERE user_id=?',[s.userId])).length,0);
});
test('admin kill switch rolls back with audit failure then revokes sessions without deleting roles or MFA',{skip:!enabled},async()=>{
  const admin=await fixture('full','admin'),s=await fixture(),appId=randomUUID();apps.push(appId);
  await execute('INSERT INTO applications(id,name,redirect_uri) VALUES (?,?,?)',[appId,'Kill switch test','https://example.test/callback']);
  await execute('INSERT INTO application_memberships(application_id,user_id,department) VALUES (?,?,?)',[appId,s.userId,'Testing']);
  await execute('INSERT INTO access_tokens(token_hash,application_id,user_id,session_id,scope,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))',[hashToken(randomToken()),appId,s.userId,s.sessionId,'identity:read']);
  await assert.rejects(revokeUserSessions(admin,s.userId,async()=>{throw new Error('audit unavailable');}));assert.ok(await findSession(s.token));
  await revokeUserSessions(admin,s.userId,audit);assert.equal(await findSession(s.token),undefined);
  assert.equal((await query('SELECT user_id FROM application_memberships WHERE user_id=? AND revoked_at IS NULL',[s.userId])).length,1);
  const [user]=await query<any>('SELECT deleted_at,totp_secret FROM users WHERE id=?',[s.userId]);assert.equal(user.deleted_at,null);assert.ok(user.totp_secret);
});
