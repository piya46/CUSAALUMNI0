import { randomUUID } from 'node:crypto';
import { hashToken } from '../services/crypto.js';
import { execute,query,transaction } from '../db.js';
import { lockAdministrators,type Actor,type AuditWriter } from './adminModel.js';
import { HttpError } from '../middleware/security.js';
import { destroyEvidence,readEvidence } from '../services/mfaEvidence.js';
import { recordAudit } from './authModel.js';
type Row=Record<string,any>;
export const resetNoticeVersion='2026-09-30';
const fields=`r.id,r.user_id AS userId,r.status,r.reason,r.created_at AS createdAt,r.delete_after AS deleteAfter,
 r.first_approved_by AS firstApprovedBy,r.decided_at AS decidedAt,r.decision_reason AS decisionReason,r.purged_at AS purgedAt`;

export async function reserveReset(userId:string,reason:string,record:AuditWriter){
  return transaction(async conn=>{
    const [user]=await query<Row>(`SELECT u.id,u.totp_secret FROM users u JOIN allowed_emails e ON e.email=u.email
      WHERE u.id=? AND u.deleted_at IS NULL AND u.totp_secret IS NOT NULL FOR UPDATE`,[userId],conn);
    if(!user)throw new HttpError(409,'บัญชีนี้ไม่ได้ผูก Authenticator','MFA_NOT_ENABLED');
    const [existing]=await query<Row>(`SELECT id FROM mfa_reset_requests WHERE user_id=? AND status IN ('uploading','pending','pending_second') AND purged_at IS NULL AND delete_after>UTC_TIMESTAMP(3) FOR UPDATE`,[userId],conn);
    if(existing)throw new HttpError(409,'มีคำขอที่รอพิจารณาอยู่แล้ว','RESET_PENDING');
    const [{total}]=await query<Row>('SELECT COUNT(*) AS total FROM mfa_reset_requests WHERE user_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY)',[userId],conn);
    if(Number(total)>=3)throw new HttpError(429,'ส่งคำขอได้ไม่เกิน 3 ครั้งต่อวัน','RESET_QUOTA');
    const id=randomUUID();
    await execute("INSERT INTO mfa_reset_requests(id,user_id,reason,notice_version,factor_hash,delete_after) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 DAY))",[id,userId,reason,resetNoticeVersion,hashToken(user.totp_secret)],conn);
    await record(conn,'mfa.reset.started',userId,{requestId:id,reason,noticeVersion:resetNoticeVersion});return id;
  });
}
export async function finishResetUpload(id:string,record:AuditWriter){
  await transaction(async conn=>{
    const result=await execute("UPDATE mfa_reset_requests SET status='pending',evidence_ready_at=UTC_TIMESTAMP(3) WHERE id=? AND status='uploading' AND purged_at IS NULL",[id],conn);
    if(result.affectedRows!==1)throw new HttpError(409,'คำขอนี้ไม่พร้อมรับหลักฐาน','RESET_UNAVAILABLE');
    await record(conn,'mfa.reset.submitted',id);
  });
}
export async function cancelFailedUpload(id:string){
  // The durable row tracks partial files across crashes; scheduled purge retries failures.
  await execute("UPDATE mfa_reset_requests SET status='cancelled',delete_after=UTC_TIMESTAMP(3) WHERE id=? AND status='uploading'",[id]);
}
export async function ownReset(userId:string){const [row]=await query<Row>(`SELECT ${fields} FROM mfa_reset_requests r WHERE r.user_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[userId]);return row??null;}
export async function listResets(status:string,cursor?:{createdAt:Date;id:string}){
  const rows=await query<Row>(`SELECT ${fields},u.email,u.name,e.role AS userRole FROM mfa_reset_requests r
    LEFT JOIN users u ON u.id=r.user_id LEFT JOIN allowed_emails e ON e.email=u.email
    WHERE (?='all' OR r.status=?) ${cursor?'AND (r.created_at<? OR (r.created_at=? AND r.id<?))':''}
    ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[status,status,...(cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[])]);
  const requests=rows.slice(0,50),last=requests.at(-1);
  return {requests,meta:{hasMore:rows.length>50,nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify({createdAt:new Date(last.createdAt).toISOString(),id:last.id})).toString('base64url'):null}};
}
async function reviewable(id:string,conn:import('mysql2/promise').PoolConnection){
  const [row]=await query<Row>(`SELECT * FROM mfa_reset_requests WHERE id=? AND evidence_ready_at IS NOT NULL
    AND purged_at IS NULL AND delete_after>UTC_TIMESTAMP(3) FOR UPDATE`,[id],conn);
  if(!row)throw new HttpError(404,'ไม่พบหลักฐานหรือสิ้นสุดระยะจัดเก็บแล้ว','EVIDENCE_UNAVAILABLE');return row;
}
export async function viewResetEvidence(actor:Actor,id:string,record:AuditWriter){
  return transaction(async conn=>{
    await lockAdministrators(actor,conn);const row=await reviewable(id,conn);
    if(row.user_id===actor.userId)throw new HttpError(403,'ไม่สามารถตรวจคำขอของตัวเอง','SELF_REVIEW');
    const image=await readEvidence(id);
    await execute('INSERT INTO mfa_reset_reviews(request_id,admin_id) VALUES (?,?) ON DUPLICATE KEY UPDATE viewed_at=UTC_TIMESTAMP(3)',[id,actor.userId],conn);
    await record(conn,'mfa.reset.evidence.viewed',row.user_id,{requestId:id});return image;
  });
}
export async function decideReset(actor:Actor,id:string,decision:'approve'|'reject',reason:string,record:AuditWriter){
  return transaction(async conn=>{
    await lockAdministrators(actor,conn);const row=await reviewable(id,conn);
    if(row.user_id===actor.userId)throw new HttpError(403,'อนุมัติหรือปฏิเสธคำขอของตัวเองไม่ได้','SELF_REVIEW');
    if(!['pending','pending_second'].includes(row.status))throw new HttpError(409,'คำขอนี้พิจารณาเสร็จแล้ว','RESET_DECIDED');
    if(decision==='approve'){
      const [view]=await query<Row>('SELECT admin_id FROM mfa_reset_reviews WHERE request_id=? AND admin_id=? AND viewed_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE)',[id,actor.userId],conn);
      if(!view)throw new HttpError(403,'เปิดตรวจหลักฐานก่อนอนุมัติ','EVIDENCE_REVIEW_REQUIRED');
      const [user]=await query<Row>(`SELECT u.id,u.totp_secret,e.role FROM users u JOIN allowed_emails e ON e.email=u.email WHERE u.id=? AND u.deleted_at IS NULL FOR UPDATE`,[row.user_id],conn);
      if(!user?.totp_secret||hashToken(user.totp_secret)!==row.factor_hash)throw new HttpError(409,'MFA ของบัญชีเปลี่ยนไปแล้ว ให้ปฏิเสธและเริ่มคำขอใหม่','RESET_UNAVAILABLE');
      // A purge may have removed files before its DB transaction rolled back.
      // Re-check authenticated ciphertext before approving, while holding the row lock.
      const evidence=await readEvidence(id);evidence.fill(0);
      if(user.role==='admin'){
        if(!row.first_approved_by){
          await execute("UPDATE mfa_reset_requests SET status='pending_second',first_approved_by=?,first_approved_at=UTC_TIMESTAMP(3) WHERE id=?",[actor.userId,id],conn);
          await record(conn,'mfa.reset.first_approved',row.user_id,{requestId:id});return {status:'pending_second'};
        }
        if(row.first_approved_by===actor.userId)throw new HttpError(403,'บัญชีผู้ดูแลต้องมีผู้อนุมัติ 2 คนที่ไม่ใช่เจ้าของบัญชี','SECOND_REVIEWER_REQUIRED');
        const [first]=await query<Row>(`SELECT u.id FROM users u JOIN allowed_emails e ON e.email=u.email WHERE u.id=? AND e.role='admin' AND u.deleted_at IS NULL`,[row.first_approved_by],conn);
        if(!first)throw new HttpError(409,'ผู้อนุมัติคนแรกไม่มีสิทธิ์แล้ว ให้ปฏิเสธและเริ่มคำขอใหม่','REVIEWER_REVOKED');
      }
      await execute('UPDATE users SET totp_secret=NULL,totp_last_step=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?',[row.user_id],conn);
      await execute('DELETE FROM mfa_recovery_codes WHERE user_id=?',[row.user_id],conn);
      await execute('DELETE FROM sessions WHERE user_id=?',[row.user_id],conn); // cascades enrollment, authorization codes and access tokens
    }
    const status=decision==='approve'?'approved':'rejected';
    await execute('UPDATE mfa_reset_requests SET status=?,decided_by=?,decided_at=UTC_TIMESTAMP(3),decision_reason=?,delete_after=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 7 DAY) WHERE id=?',[status,actor.userId,reason,id],conn);
    await record(conn,`mfa.reset.${status}`,row.user_id,{requestId:id,reason,retentionDays:7});return {status};
  });
}
export async function purgeResetEvidence(){
  let count=0;
  // Finish one locked record at a time; filesystem deletes are idempotent after rollback/crash.
  for(let batch=0;batch<100;batch++){
    const removed=await transaction(async conn=>{
      const [row]=await query<Row>(`SELECT * FROM mfa_reset_requests WHERE purged_at IS NULL AND
        (delete_after<=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) OR (status='uploading' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR)))
        ORDER BY delete_after,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[],conn);
      if(!row)return false;
      await destroyEvidence(row.id);
      await execute("UPDATE mfa_reset_requests SET purged_at=UTC_TIMESTAMP(3),status=IF(status IN ('uploading','pending','pending_second'),'expired',status) WHERE id=?",[row.id],conn);
      await execute('DELETE FROM mfa_reset_reviews WHERE request_id=?',[row.id],conn);
      await recordAudit({actorId:null,actorEmail:null,sessionId:null,status:'success',userAgent:'',event:'mfa.reset.evidence.destroyed',target:row.user_id,ip:'system',actorType:'system',metadata:{requestId:row.id,scheduled:true}},conn);return true;
    });
    if(!removed)break;count++;
  }
  return count;
}
