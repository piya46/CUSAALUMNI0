import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import request from 'supertest';
import { config } from '../src/config.js';
import { execute,query,pool } from '../src/db.js';
import * as auth from '../src/models/authModel.js';
import * as reset from '../src/models/mfaResetModel.js';
import { seal } from '../src/services/crypto.js';
import { watermarkEvidence,storeEvidence,destroyEvidence } from '../src/services/mfaEvidence.js';
import { createApp } from '../src/app.js';
import { sessionCookie } from '../src/middleware/security.js';
import type { AuditWriter } from '../src/models/adminModel.js';
const enabled=process.env.RUN_DB_TESTS==='1';
const owned:Array<{userId:string;email:string}>=[];
let directory='';
const record:AuditWriter=async(conn,event,target,metadata)=>{await auth.recordAudit({actorId:null,actorEmail:null,sessionId:null,userAgent:'test',status:'success',event,target:target??null,ip:'test',metadata},conn);};
if(enabled){config.configured=true;config.sessionSecret=`reset-test-${randomUUID()}`;config.mfaEvidenceKey=Buffer.alloc(32,9).toString('base64');directory=await mkdtemp(join(tmpdir(),'cusa-reset-integration-'));config.mfaEvidenceDir=directory;}
async function fixture(role='user'){
  const email=`reset-${randomUUID()}@example.test`;
  await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,role]);
  const session=await auth.startGoogleSession({email,sub:randomUUID(),name:'Synthetic member',avatar:null});assert.ok(session);
  owned.push({...session,email});await execute('UPDATE users SET totp_secret=? WHERE id=?',[seal('JBSWY3DPEHPK3PXP'),session.userId]);
  if(role==='admin')await execute("UPDATE sessions SET kind='full',mfa_method='totp',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?",[session.sessionId]);
  const identity=await auth.findSession(session.token);assert.ok(identity);
  return {...session,identity,actor:{userId:session.userId,email,sessionId:session.sessionId},cookie:`${sessionCookie}=${session.token}`};
}
const image=()=>sharp({create:{width:600,height:400,channels:3,background:'#cdeedd'}}).png().toBuffer();
async function submit(userId:string){const id=await reset.reserveReset(userId,'lost',record);await storeEvidence(id,await watermarkEvidence(await image(),id));await reset.finishResetUpload(id,record);return id;}
after(async()=>{if(enabled){for(const u of owned){await execute('DELETE FROM mfa_reset_requests WHERE user_id=?',[u.userId]);await execute('DELETE FROM users WHERE id=?',[u.userId]);await execute('DELETE FROM allowed_emails WHERE email=?',[u.email]);}await rm(directory,{recursive:true,force:true});}await pool.end();});

test('pending owner submits only for self; CSRF, authorization and fresh admin MFA protect private evidence',{skip:!enabled},async()=>{
  const owner=await fixture(),other=await fixture(),admin=await fixture('admin'),app=createApp();
  await request(app).post('/api/auth/mfa-reset').set('Cookie',owner.cookie).expect(403);
  const response=await request(app).post('/api/auth/mfa-reset').set('Cookie',owner.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',owner.identity.csrfToken)
    .field('reason','lost').field('noticeVersion',reset.resetNoticeVersion).field('acknowledged','true').attach('evidence',await image(),{filename:'test.png',contentType:'image/png'}).expect(201);
  const id=response.body.id;
  assert.equal((await reset.ownReset(owner.userId)).id,id);assert.equal(await reset.ownReset(other.userId),null);
  await request(app).get(`/api/admin/mfa-resets/${id}/evidence`).set('Cookie',owner.cookie).expect(403);
  await request(app).get(`/api/admin/mfa-resets/${id}/evidence`).expect(401);
  const photo=await request(app).get(`/api/admin/mfa-resets/${id}/evidence`).set('Cookie',admin.cookie).expect(200);
  assert.match(photo.headers['cache-control'],/no-store/);assert.equal(photo.headers['content-type'],'image/jpeg');
  await execute('UPDATE sessions SET authenticated_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 6 MINUTE) WHERE id=?',[admin.sessionId]);
  const stale=await request(app).get(`/api/admin/mfa-resets/${id}/evidence`).set('Cookie',admin.cookie).expect(403);assert.equal(stale.body.code,'MFA_REAUTH_REQUIRED');
  await assert.rejects(reset.reserveReset(owner.userId,'lost',record),{code:'RESET_PENDING'});
});

test('approval requires a reviewed image, survives audit failure atomically, revokes all sessions and recovery codes once',{skip:!enabled},async()=>{
  const owner=await fixture(),admin=await fixture('admin'),id=await submit(owner.userId);
  await execute('INSERT INTO mfa_recovery_codes(id,user_id,code_hash) VALUES (?,?,?)',[randomUUID(),owner.userId,'test']);
  await assert.rejects(reset.decideReset(admin.actor,id,'approve','identity_verified',record),{code:'EVIDENCE_REVIEW_REQUIRED'});
  await reset.viewResetEvidence(admin.actor,id,record);
  await assert.rejects(reset.decideReset(admin.actor,id,'approve','identity_verified',async()=>{throw new Error('audit unavailable');}));
  assert.ok(await auth.findSession(owner.token));assert.equal((await reset.ownReset(owner.userId)).status,'pending');
  const results=await Promise.allSettled([reset.decideReset(admin.actor,id,'approve','identity_verified',record),reset.decideReset(admin.actor,id,'approve','identity_verified',record)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(await auth.findSession(owner.token),undefined);
  const [user]=await query<any>('SELECT totp_secret FROM users WHERE id=?',[owner.userId]);assert.equal(user.totp_secret,null);
  assert.equal((await query('SELECT id FROM mfa_recovery_codes WHERE user_id=?',[owner.userId])).length,0);
  const row=await reset.ownReset(owner.userId);assert.equal(row.status,'approved');assert.ok(new Date(row.deleteAfter).getTime()-Date.now()<=7*86400000);
});

test('admin reset requires two different other admins and cannot reset a changed factor',{skip:!enabled},async()=>{
  const owner=await fixture('admin'),first=await fixture('admin'),second=await fixture('admin'),id=await submit(owner.userId);
  await assert.rejects(reset.viewResetEvidence(owner.actor,id,record),{code:'SELF_REVIEW'});
  await assert.rejects(reset.decideReset(owner.actor,id,'approve','identity_verified',record),{code:'SELF_REVIEW'});
  await reset.viewResetEvidence(first.actor,id,record);
  assert.equal((await reset.decideReset(first.actor,id,'approve','identity_verified',record)).status,'pending_second');
  await assert.rejects(reset.decideReset(first.actor,id,'approve','identity_verified',record),{code:'SECOND_REVIEWER_REQUIRED'});
  await reset.viewResetEvidence(second.actor,id,record);
  assert.equal((await reset.decideReset(second.actor,id,'approve','identity_verified',record)).status,'approved');
  const changed=await fixture(),old=await submit(changed.userId);await reset.viewResetEvidence(first.actor,old,record);
  await execute('UPDATE users SET totp_secret=? WHERE id=?',[seal('ANOTHERMFASECRET'),changed.userId]);
  await assert.rejects(reset.decideReset(first.actor,old,'approve','identity_verified',record),{code:'RESET_UNAVAILABLE'});
});

test('missing files block approval; due evidence is destroyed and cannot be read after expiry, purge retries safely',{skip:!enabled},async()=>{
  const owner=await fixture(),admin=await fixture('admin'),id=await submit(owner.userId);await reset.viewResetEvidence(admin.actor,id,record);
  await destroyEvidence(id);await assert.rejects(reset.decideReset(admin.actor,id,'approve','identity_verified',record));assert.ok(await auth.findSession(owner.token));
  await execute('UPDATE mfa_reset_requests SET delete_after=UTC_TIMESTAMP(3) WHERE id=?',[id]);
  await assert.rejects(reset.viewResetEvidence(admin.actor,id,record),{code:'EVIDENCE_UNAVAILABLE'});
  await reset.purgeResetEvidence();await reset.purgeResetEvidence();assert.ok((await reset.ownReset(owner.userId)).purgedAt);
  const second=await fixture(),another=await submit(second.userId);await execute('UPDATE mfa_reset_requests SET delete_after=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE) WHERE id=?',[another]);
  await reset.purgeResetEvidence();await assert.rejects(access(join(directory,`${another}.enc`)));await assert.rejects(access(join(directory,`${another}.key`)));
  const [log]=await query<any>("SELECT id FROM audit_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.event'))='mfa.reset.evidence.destroyed' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.target'))=?",[second.userId]);assert.ok(log);
});
