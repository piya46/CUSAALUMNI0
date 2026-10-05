import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,test} from 'node:test';
import {execute,query,pool,transaction} from '../src/db.js';
import {config} from '../src/config.js';
import {startGoogleSession,findSession,createOtp,verifyEmailOtp} from '../src/models/authModel.js';
import {createSsoModel,pkceChallenge} from '../src/models/ssoModel.js';
import {saveAccessPolicy,readAccessPolicy,policyResponse,enrollmentContext,enroll,saveInvitation,lifecyclePreview,reportActivity} from '../src/models/servicePolicyModel.js';
import {listUsers,addAllowedEmail,updateSharingPolicy} from '../src/models/adminModel.js';
import {revokeMember} from '../src/models/serviceAccessModel.js';
import {hashToken,randomToken,seal} from '../src/services/crypto.js';
import {requireAdmin} from '../src/middleware/security.js';
import type {Request,Response} from 'express';

const enabled=process.env.RUN_DB_TESTS==='1';
after(()=>pool.end());
test('isolated service registration, enrollment, consent and lifecycle preserve internal boundaries',{skip:!enabled},async t=>{
 assert.match(config.dbName,/_test$/);assert.equal(config.dbHost,'127.0.0.1');
 const app=randomUUID(),other=randomUUID(),role=randomUUID(),actorId=randomUUID(),actorSession=randomUUID();
 const adminEmail=`${actorId}@example.test`,externalEmail=`${randomUUID()}@example.test`,sub=randomUUID();
 const actor={userId:actorId,email:adminEmail,sessionId:actorSession},record=async()=>{};
 const ids:string[]=[actorId],emails:string[]=[adminEmail];
 const redirectUri='https://service.example.test/callback',key=hashToken(randomToken()),keyId=randomUUID(),model=createSsoModel();
 const providers={firebasePhoneEnabled:config.firebasePhoneEnabled,lineMfaEnabled:config.lineMfaEnabled,firebasePhoneRequired:config.firebasePhoneRequired};
 Object.assign(config,{firebasePhoneEnabled:true,lineMfaEnabled:true,firebasePhoneRequired:false});
 let externalId='',sessionId='',cookie='';
 const profile={sub,email:externalEmail,name:'Service Person',avatar:null,applicationId:app};
 async function save(changes:Record<string,unknown>){const {version,lifecycleMode:_,...input}=policyResponse(await readAccessPolicy(app));return saveAccessPolicy(actor,app,{...input,...changes},version,record);}
 async function approve(scope='identity:read email'){
   const verifier=randomToken();const request=await model.beginAuthorization({applicationId:app,sessionId,userId:externalId,redirectUri,challenge:pkceChallenge(verifier),state:randomToken(),scope});
   const r=await model.decideConsent(request,sessionId,externalId,true,scope.split(' '));
   return model.exchangeAuthorizationCode({apiKeyHash:key,codeHash:hashToken(new URL(r.redirectTo).searchParams.get('code')!),redirectUri,verifier});
 }
 try{
  await execute("INSERT INTO allowed_emails(id,email,role) VALUES (?,?,'admin')",[randomUUID(),adminEmail]);
  await execute('INSERT INTO users(id,google_sub,email,name,totp_secret) VALUES (?,?,?,?,?)',[actorId,randomUUID(),adminEmail,'Internal Admin',seal('SYNTHETIC')]);
  await execute("INSERT INTO sessions(id,token_hash,user_id,kind,csrf_token,mfa_method,authenticated_at,expires_at) VALUES (?,?,?,'full',?,'totp',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",[actorSession,hashToken(randomToken()),actorId,randomToken()]);
  for(const id of [app,other]){
    await execute('INSERT INTO applications(id,name,redirect_uri,allowed_claim_scopes) VALUES (?,?,?,?)',[id,'Fixture service',redirectUri,'identity:read email phone line assurance']);
    await execute('INSERT INTO application_access_policies(application_id) VALUES (?)',[id]);
  }
  await execute('INSERT INTO application_roles(id,application_id,code,name) VALUES (?,?,?,?)',[role,app,'customer','Customer']);
  await execute('INSERT INTO api_keys(id,application_id,name,prefix,key_hash,scopes,expires_at) VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))',[keyId,app,'Test','test',key,JSON.stringify(['identity:read','token:introspect','member:activity'])]);
  await t.test('default is closed; central login never creates a public identity',async()=>{
    assert.equal(await startGoogleSession({...profile,applicationId:undefined}),null);
    await assert.rejects(startGoogleSession(profile),{code:'REGISTRATION_CLOSED'});
    assert.equal((await query('SELECT id FROM users WHERE google_sub=?',[sub])).length,0);
    await save({registration:'open',defaultRoleId:role,registrationLimit:5});
    await assert.rejects(startGoogleSession(profile,undefined,async()=>{throw new Error('audit unavailable');}),/audit unavailable/);
    assert.equal((await query('SELECT id FROM users WHERE google_sub=?',[sub])).length,0);
  });
  await t.test('public signup is provisional, survives MFA, and cannot access the internal admin plane',async()=>{
    const s=await startGoogleSession(profile);assert.ok(s);externalId=s.userId;ids.push(externalId);sessionId=s.sessionId;cookie=s.token;
    assert.equal((await findSession(cookie))?.role,'service');
    assert.equal((await query('SELECT id FROM allowed_emails WHERE email=?',[externalEmail])).length,0);
    assert.equal((await query('SELECT * FROM application_member_roles WHERE user_id=?',[externalId])).length,0);
    assert.equal((await listUsers({page:1,limit:100,search:externalEmail})).meta.total,0);
    await createOtp(sessionId,'123456');cookie=(await verifyEmailOtp(sessionId,'123456'))!;assert.ok(cookie);
    const identity=await findSession(cookie);assert.equal(identity?.kind,'full');
    assert.throws(()=>requireAdmin({identity} as Request,{} as Response,()=>{}),{status:403});
    assert.equal(await startGoogleSession({...profile,applicationId:undefined}),null);
  });
  await t.test('required phone/LINE/strong MFA are checked by the model, not just UI',async()=>{
    const before=policyResponse(await readAccessPolicy(app));
    const {version,lifecycleMode:_,...valid}=before;
    await assert.rejects(saveAccessPolicy(actor,app,valid,version+1,record),{code:'POLICY_CHANGED'});
    await assert.rejects(saveAccessPolicy(actor,app,valid,version,async()=>{throw new Error('audit unavailable');}),/audit unavailable/);
    assert.equal(policyResponse(await readAccessPolicy(app)).version,version);
    const reserved=randomUUID();await execute('INSERT INTO application_roles(id,application_id,code,name) VALUES (?,?,?,?)',[reserved,app,'admin','Admin']);
    await assert.rejects(save({defaultRoleId:reserved}),{code:'INVALID_DEFAULT_ROLE'});
    await assert.rejects(save({defaultRoleId:randomUUID()}),{code:'INVALID_DEFAULT_ROLE'});
    await save({requirePhone:true,requireLine:true,minimumMfa:'strong',requiredScopes:['identity:read','email']});
    const state=await enrollmentContext(app,externalId,sessionId);
    assert.deepEqual(state.missing,['phone','line','strong_mfa']);assert.equal(state.ready,false);
    await assert.rejects(approve(),{code:'access_denied'});
    await execute('INSERT INTO phone_identities(user_id,phone_hash,phone_encrypted,firebase_uid_hash) VALUES (?,?,?,?)',[externalId,hashToken(`phone:${externalId}`),seal('+66812345678'),hashToken(externalId)]);
    await execute('INSERT INTO line_identities(user_id,subject_hash,subject_encrypted) VALUES (?,?,?)',[externalId,hashToken(`line:${externalId}`),seal('U'+'2'.repeat(32))]);
    await execute("UPDATE sessions SET mfa_method='totp' WHERE id=?",[sessionId]);
    assert.equal((await enrollmentContext(app,externalId,sessionId)).ready,true);
    await assert.rejects(approve('identity:read'),{code:'invalid_scope'});
    const request=await model.beginAuthorization({applicationId:app,sessionId,userId:externalId,redirectUri,challenge:pkceChallenge(randomToken()),state:randomToken(),scope:'identity:read email'});
    assert.equal((await model.consentContext(request,sessionId,externalId)).scopes.find(s=>s.scope==='email')?.required,true);
    await assert.rejects(model.decideConsent(request,sessionId,externalId,true,['identity:read']),{code:'invalid_scope'});
    await assert.rejects(model.decideConsent(request,sessionId,externalId,true,['identity:read','email'],async()=>{throw new Error('audit failure');}),/audit failure/);
    assert.equal((await query<{enrollment:string}>('SELECT enrollment FROM application_memberships WHERE application_id=? AND user_id=?',[app,externalId]))[0].enrollment,'pending');
    await assert.rejects(updateSharingPolicy(actor,app,{scopes:['identity:read'],purpose:'Fixture sharing'},record),{code:'REQUIRED_SCOPE'});
    const token=await approve();assert.equal((await model.getUserInfo(hashToken(token.accessToken)))?.roles[0],'customer');
    assert.equal((await query<{enrollment:string}>('SELECT enrollment FROM application_memberships WHERE application_id=? AND user_id=?',[app,externalId]))[0].enrollment,'active');
    await execute('DELETE FROM line_identities WHERE user_id=?',[externalId]);
    assert.deepEqual(await model.introspectToken(key,hashToken(token.accessToken)),{active:false});
    await assert.rejects(approve(),{code:'access_denied'});
    await save({requirePhone:false,requireLine:false,minimumMfa:'standard'});
    await execute("UPDATE sessions SET mfa_method='recovery' WHERE id=?",[sessionId]);await assert.rejects(approve(),{code:'access_denied'});
    await execute("UPDATE sessions SET mfa_method='totp' WHERE id=?",[sessionId]);
  });
  await t.test('membership and activity are service scoped, replay bounded; retention only previews',async()=>{
    await assert.rejects(enroll(other,externalId,sessionId,externalEmail,record),{code:'REGISTRATION_CLOSED'});
    const event=randomUUID();await reportActivity(app,externalId,event,keyId);
    assert.equal((await reportActivity(app,externalId,event,keyId)).duplicate,true);
    assert.equal((await reportActivity(app,externalId,randomUUID(),keyId)).recorded,false);
    await assert.rejects(reportActivity(other,externalId,randomUUID(),keyId),{code:'invalid_client'});
    await save({inactiveDays:180});
    await execute('UPDATE application_memberships SET last_activity_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 200 DAY) WHERE application_id=? AND user_id=?',[app,externalId]);
    const preview=await lifecyclePreview(app,undefined,50);assert.equal(preview.mode,'preview');assert.equal(preview.data[0].userId,externalId);
    assert.equal((await findSession(cookie))?.role,'service');
    assert.equal((await query<{revoked_at:Date|null}>('SELECT revoked_at FROM application_memberships WHERE application_id=? AND user_id=?',[app,externalId]))[0].revoked_at,null);
    await revokeMember(actor,app,externalId,record);
    await assert.rejects(startGoogleSession(profile),{code:'MEMBERSHIP_UNAVAILABLE'});
    assert.ok(await findSession(cookie)); // Identity/self-service survives losing one service.
  });
  await t.test('invitations bind verified email; pending expiry and quotas cannot be bypassed',async()=>{
    await save({registration:'invite'});const email=`${randomUUID()}@example.test`,p={...profile,email,sub:randomUUID()};
    await assert.rejects(startGoogleSession(p),{code:'INVITATION_REQUIRED'});
    await saveInvitation(actor,app,email,7,record);
    const s=await startGoogleSession(p);assert.ok(s);ids.push(s.userId);
    await execute("UPDATE sessions SET kind='full',mfa_method='email',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?",[s.sessionId]);
    const request=await model.beginAuthorization({applicationId:app,sessionId:s.sessionId,userId:s.userId,redirectUri,challenge:pkceChallenge(randomToken()),state:randomToken(),scope:'identity:read email'});
    await execute('DELETE FROM application_invitations WHERE application_id=? AND email=?',[app,email]);
    await assert.rejects(model.decideConsent(request,s.sessionId,s.userId,true,['identity:read','email']),{code:'access_denied'});
    await assert.rejects(startGoogleSession(p),{code:'INVITATION_REQUIRED'});
    await saveInvitation(actor,app,email,7,record);
    await save({registration:'closed'});
    await assert.rejects(startGoogleSession(p),{code:'REGISTRATION_CLOSED'});
    await assert.rejects(model.beginAuthorization({applicationId:app,sessionId:s.sessionId,userId:s.userId,redirectUri,challenge:pkceChallenge(randomToken()),state:randomToken(),scope:'identity:read email'}),{code:'access_denied'});
    await save({registration:'invite'});
    await execute('UPDATE application_memberships SET pending_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE application_id=? AND user_id=?',[app,s.userId]);
    await assert.rejects(startGoogleSession(p),{code:'MEMBERSHIP_UNAVAILABLE'});
    assert.ok((await lifecyclePreview(app,undefined,50)).data.some(r=>r.userId===s.userId&&r.reason==='unfinished_registration'));
    await save({registration:'open',registrationLimit:1});
    const third={...profile,email:`${randomUUID()}@example.test`,sub:randomUUID()};
    await assert.rejects(startGoogleSession(third),{code:'REGISTRATION_LIMIT'});
    assert.equal((await query('SELECT id FROM users WHERE google_sub=?',[third.sub])).length,0);
  });
  await t.test('removed internal allowlist never falls back to public signup; explicit admin admission is required',async()=>{
    const id=randomUUID(),email=`${id}@example.test`,googleSub=randomUUID();ids.push(id);
    await execute('INSERT INTO users(id,google_sub,email,name) VALUES (?,?,?,?)',[id,googleSub,email,'Former internal']);
    assert.equal(await startGoogleSession({...profile,sub:googleSub,email}),null);
    await addAllowedEmail(actor,{email:externalEmail,role:'user'},record);emails.push(externalEmail);
    const [u]=await query<{account_type:string}>('SELECT account_type FROM users WHERE id=?',[externalId]);assert.equal(u.account_type,'internal');
    assert.equal(await findSession(cookie),undefined);
    assert.equal((await listUsers({page:1,limit:100,search:externalEmail})).meta.total,1);
  });
 }finally{
  Object.assign(config,providers);
  for(const id of [app,other])await execute('DELETE FROM applications WHERE id=?',[id]);
  for(const id of ids)await execute('DELETE FROM users WHERE id=?',[id]);
  for(const email of emails)await execute('DELETE FROM allowed_emails WHERE email=?',[email]);
 }
});
