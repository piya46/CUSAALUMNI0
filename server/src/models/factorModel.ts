import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { execute, query } from '../db.js';
import { HttpError } from '../middleware/security.js';
import { hashToken, seal, unseal } from '../services/crypto.js';
import { isFreshStrongMfa } from '../services/mfaPolicy.js';
export type FactorRow = Record<string, any>;
export async function lockFactorSession(sessionId:string, connection:PoolConnection, mode:'pending'|'manage'|'phone'|'reauth') {
  const [row]=await query<FactorRow>(`SELECT s.*,u.email,u.totp_secret,u.phone_required,
    u.mfa_locked_until>UTC_TIMESTAMP(3) AS locked FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN allowed_emails a ON a.email=u.email WHERE s.id=? AND s.expires_at>UTC_TIMESTAMP(3)
    AND u.deleted_at IS NULL FOR UPDATE`,[sessionId],connection);
  if(!row)throw new HttpError(401,'กรุณาเข้าสู่ระบบใหม่','UNAUTHENTICATED');
  if(row.locked)throw new HttpError(429,'บัญชีถูกพักการยืนยัน 15 นาที','ACCOUNT_LOCKED');
  if(mode==='pending' && (row.kind!=='pending'||!row.totp_secret))throw new HttpError(403,'วิธีนี้ยังไม่พร้อมใช้งาน','MFA_REQUIRED');
  if((mode==='manage'||mode==='reauth') && (row.kind!=='full'||!row.totp_secret))throw new HttpError(403,'เปิด Authenticator และเก็บ Recovery codes ก่อนเพิ่มวิธีสำรอง','TOTP_ENROLLMENT_REQUIRED');
  if((mode==='manage'||mode==='reauth') && row.mfa_method==='recovery')throw new HttpError(403,'ตั้งค่า Authenticator ใหม่หลังใช้รหัสกู้คืน','MFA_ENROLLMENT_REQUIRED');
  if(mode==='manage' && !isFreshStrongMfa(row.mfa_method,row.authenticated_at))throw new HttpError(403,'ยืนยัน Passkey หรือ Authenticator ก่อนจัดการวิธียืนยันตัวตน','MFA_REAUTH_REQUIRED');
  if(mode==='phone' && row.kind!=='full')throw new HttpError(403,'ยืนยัน MFA ก่อนยืนยันเบอร์','MFA_REQUIRED');
  return row;
}
export async function createFactorChallenge(sessionId:string,kind:string,payload:unknown,conn:PoolConnection) {
  await execute('DELETE FROM factor_challenges WHERE session_id=? AND kind=?',[sessionId,kind],conn);
  const id=randomUUID();
  await execute('INSERT INTO factor_challenges(id,session_id,kind,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 3 MINUTE))',[id,sessionId,kind,seal(JSON.stringify(payload))],conn);
  return id;
}
export async function factorChallenge(id:string,sessionId:string,kind:string,conn:PoolConnection):Promise<(FactorRow & {data:any})|null> {
  const [row]=await query<FactorRow>("SELECT * FROM factor_challenges WHERE id=? AND session_id=? AND kind=? AND status IN ('pending','approved') AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",[id,sessionId,kind],conn);
  return row?{...row,data:JSON.parse(unseal(row.payload))}:null;
}
export const factorFingerprint=(row:FactorRow)=>hashToken(row.totp_secret??'');
export async function clearAdditionalFactors(userId:string,conn:PoolConnection){
  await execute('DELETE FROM passkeys WHERE user_id=?',[userId],conn);
  await execute('DELETE FROM line_identities WHERE user_id=?',[userId],conn);
  await execute('DELETE c FROM factor_challenges c JOIN sessions s ON s.id=c.session_id WHERE s.user_id=?',[userId],conn);
}
