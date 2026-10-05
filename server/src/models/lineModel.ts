import { randomInt } from 'node:crypto';
import { execute, query, transaction } from '../db.js';
import { hashToken, randomToken, seal, unseal } from '../services/crypto.js';
import { HttpError } from '../middleware/security.js';
import { requireLine, lineLoginUrl, exchangeLine, sendLineMatching } from '../services/line.js';
import { lineReference } from '../services/lineMessages.js';
import { failure, promote, OtpCooldownError, type AuthAudit } from './authModel.js';
import { createFactorChallenge, factorChallenge, factorFingerprint, lockFactorSession, type FactorRow } from './factorModel.js';

export async function lineLinkStart(sessionId:string,record:AuthAudit,returnTo?:string){
  requireLine();return transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'manage');
    const [linked]=await query('SELECT user_id FROM line_identities WHERE user_id=?',[s.user_id],conn);
    if(linked)throw new HttpError(409,'ผูก LINE แล้ว ให้ถอดการผูกเดิมก่อน','LINE_ALREADY_LINKED');
    const nonce=randomToken(),verifier=randomToken(48),state=randomToken();
    const id=await createFactorChallenge(sessionId,'line_link',{nonce,verifier,returnTo,stateHash:hashToken(state),factor:factorFingerprint(s)},conn);
    await record(conn,'mfa.line.link.started',s.user_id);
    return {url:lineLoginUrl(`${id}.${state}`,nonce,verifier)};
  });
}
export async function lineLinkFinish(sessionId:string,state:string,code:string,record:AuthAudit){
  requireLine();const [id,secret]=state.split('.');
  const saved=await transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'manage');
    const challenge=await factorChallenge(id,sessionId,'line_link',conn);
    if(!challenge||challenge.data.stateHash!==hashToken(secret)||challenge.data.factor!==factorFingerprint(s))throw new HttpError(400,'คำขอผูก LINE ไม่ถูกต้อง','INVALID_STATE');
    await execute("UPDATE factor_challenges SET status='used' WHERE id=?",[id],conn);return challenge.data;
  });
  const subject=await exchangeLine(code,saved.nonce,saved.verifier);
  await transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'manage');
    if(saved.factor!==factorFingerprint(s))throw new HttpError(409,'MFA เปลี่ยนไป กรุณาเริ่มใหม่','FACTOR_CHANGED');
    const [exists]=await query('SELECT user_id FROM line_identities WHERE subject_hash=? OR user_id=?',[hashToken(`line:${subject}`),s.user_id],conn);
    if(exists)throw new HttpError(409,'LINE นี้หรือบัญชีนี้มีการผูกอยู่แล้ว','LINE_ALREADY_LINKED');
    await execute('INSERT INTO line_identities(user_id,subject_hash,subject_encrypted) VALUES (?,?,?)',[s.user_id,hashToken(`line:${subject}`),seal(subject)],conn);
    await record(conn,'mfa.line.linked',s.user_id);
  });
  return saved.returnTo as string|undefined;
}
export async function unlinkLine(sessionId:string,record:AuthAudit){
  await transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'manage');
    await execute('DELETE FROM line_identities WHERE user_id=?',[s.user_id],conn);
    await execute('DELETE FROM sessions WHERE user_id=? AND id<>?',[s.user_id,sessionId],conn);
    await record(conn,'mfa.line.unlinked',s.user_id);
  });
}
export async function startLineChallenge(sessionId:string,record:AuthAudit){
  requireLine();const issued=await transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'pending');
    const [application]=await query<FactorRow>('SELECT a.name FROM sessions s JOIN applications a ON a.id=s.login_application_id AND a.revoked_at IS NULL WHERE s.id=?',[sessionId],conn);
    const [link]=await query<FactorRow>('SELECT subject_encrypted FROM line_identities WHERE user_id=?',[s.user_id],conn);
    if(!link)throw new HttpError(409,'ยังไม่ได้ผูก LINE','LINE_UNAVAILABLE');
    const [cooldown]=await query<FactorRow>('SELECT GREATEST(0,CEIL(60-TIMESTAMPDIFF(MICROSECOND,line_sent_at,UTC_TIMESTAMP(3))/1000000)) AS seconds FROM users WHERE id=?',[s.user_id],conn);
    if(Number(cooldown.seconds)>0)throw new OtpCooldownError(Number(cooldown.seconds));
    await execute('UPDATE users SET line_sent_at=UTC_TIMESTAMP(3) WHERE id=?',[s.user_id],conn);
    await execute("DELETE c FROM factor_challenges c JOIN sessions s ON s.id=c.session_id WHERE s.user_id=? AND c.kind='line_auth'",[s.user_id],conn);
    const number=String(randomInt(10,100));const numbers=new Set([number]);while(numbers.size<3)numbers.add(String(randomInt(10,100)));
    const values=[...numbers];for(let i=values.length-1;i>0;i--){const j=randomInt(i+1);[values[i],values[j]]=[values[j],values[i]];}
    const choices=[...values.map(label=>({label,value:randomToken()})),{label:'ปฏิเสธ',value:randomToken()}];
    const payload={factor:factorFingerprint(s),subjectHash:hashToken(`line:${unseal(link.subject_encrypted)}`),choices:choices.map(c=>({hash:hashToken(c.value),correct:c.label===number}))};
    const id=await createFactorChallenge(sessionId,'line_auth',payload,conn);
    await record(conn,'auth.line.requested',s.user_id);
    return {id,number,choices,subject:unseal(link.subject_encrypted),applicationName:application?.name as string|undefined};
  });
  try{await sendLineMatching(issued.subject,issued.id,issued.choices,issued.applicationName);}catch{
    await transaction(async conn=>{await execute("UPDATE factor_challenges SET status='denied' WHERE id=?",[issued.id],conn);await record(conn,'auth.line.delivery.failure',undefined,{failure_reason:'LINE_UNAVAILABLE'});});
    throw new HttpError(503,'ส่ง LINE ไม่สำเร็จ ตรวจสอบว่าเพิ่มเพื่อน Official Account แล้ว หรือลอง Authenticator','LINE_UNAVAILABLE');
  }
  return {challengeId:issued.id,number:issued.number,reference:lineReference(issued.id),expiresIn:180,retryAfter:60};
}
// Signed LINE callbacks approve a challenge only. The originating browser must
// subsequently consume it with its own cookie and CSRF token to receive a session.
export async function applyLineChoice(id:string,subject:string,choice:string,record:AuthAudit){
  return transaction(async conn=>{
    const [candidate]=await query<FactorRow>('SELECT session_id FROM factor_challenges WHERE id=?',[id],conn);
    if(!candidate)return;
    let s;try{s=await lockFactorSession(candidate.session_id,conn,'pending');}catch(error){if(error instanceof HttpError)return;throw error;}
    const challenge=await factorChallenge(id,s.id,'line_auth',conn);
    if(!challenge||challenge.status!=='pending'||challenge.data.subjectHash!==hashToken(`line:${subject}`)||challenge.data.factor!==factorFingerprint(s))return;
    const [linked]=await query('SELECT user_id FROM line_identities WHERE user_id=? AND subject_hash=?',[s.user_id,challenge.data.subjectHash],conn);if(!linked)return;
    const match=challenge.data.choices.find((c:{hash:string})=>c.hash===hashToken(choice));
    if(!match)return;
    await execute('UPDATE factor_challenges SET status=? WHERE id=?',[match.correct?'approved':'denied',id],conn);
    if(!match.correct)await failure(s.user_id,conn,record);
    await record(conn,match.correct?'auth.line.approved':'auth.line.failure',s.user_id,{challengeId:id});
    return match.correct ? 'approved' as const : 'denied' as const;
  });
}
export async function lineChallengeStatus(sessionId:string,id:string){
  const [row]=await query<FactorRow>("SELECT status,expires_at>UTC_TIMESTAMP(3) AS alive FROM factor_challenges WHERE id=? AND session_id=? AND kind='line_auth'",[id,sessionId]);
  return {status:row?.alive?row.status:'expired'};
}
export async function finishLineChallenge(sessionId:string,id:string,record:AuthAudit){
  requireLine();return transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'pending');const challenge=await factorChallenge(id,sessionId,'line_auth',conn);
    if(!challenge||challenge.status!=='approved'||challenge.data.factor!==factorFingerprint(s))return null;
    const [linked]=await query('SELECT user_id FROM line_identities WHERE user_id=? AND subject_hash=?',[s.user_id,challenge.data.subjectHash],conn);if(!linked)return null;
    await execute("UPDATE factor_challenges SET status='used' WHERE id=?",[id],conn);
    return promote(sessionId,s.user_id,'line',conn,record);
  });
}
