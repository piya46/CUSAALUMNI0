import type { PoolConnection } from 'mysql2/promise';
import { query, execute, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../middleware/security.js';
import { lockAdministrators, type Actor, type AuditWriter } from './adminModel.js';
import type { AccessPolicy } from '../services/servicePolicy.js';
import { scopesWithin } from '../services/claimScopes.js';

type Row = Record<string, any>;
export async function readAccessPolicy(applicationId:string,conn?:PoolConnection) {
  const [p]=await query<Row>(`SELECT p.*,a.name,a.allowed_claim_scopes FROM application_access_policies p
    JOIN applications a ON a.id=p.application_id AND a.revoked_at IS NULL WHERE p.application_id=?${conn?' FOR UPDATE':''}`,[applicationId],conn);
  if(!p)throw new HttpError(404,'ไม่พบ Service ที่เปิดใช้งาน','NOT_FOUND');
  return p;
}
export function policyResponse(p:Row) {
  return {registration:p.registration,defaultRoleId:p.default_role_id,requirePhone:Boolean(p.require_phone),requireLine:Boolean(p.require_line),
    minimumMfa:p.minimum_mfa,requiredScopes:p.required_scopes.split(' '),registrationLimit:Number(p.registration_limit),
    pendingDays:Number(p.pending_days),inactiveDays:p.inactive_days===null?null:Number(p.inactive_days),noticeDays:Number(p.notice_days),
    recoveryDays:Number(p.recovery_days),version:Number(p.version),lifecycleMode:'preview' as const};
}
export async function saveAccessPolicy(actor:Actor,id:string,input:AccessPolicy,expectedVersion:number,record:AuditWriter) {
  return transaction(async conn=>{
    await lockAdministrators(actor,conn);const p=await readAccessPolicy(id,conn);
    if(Number(p.version)!==expectedVersion)throw new HttpError(409,'นโยบายเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่','POLICY_CHANGED');
    if(!scopesWithin(input.requiredScopes.join(' '),p.allowed_claim_scopes))throw new HttpError(400,'ข้อมูลจำเป็นต้องอยู่ในรายการที่อนุญาตให้ Service ขอได้','INVALID_SCOPE');
    if(input.defaultRoleId){
      const [role]=await query<Row>('SELECT code FROM application_roles WHERE id=? AND application_id=? AND revoked_at IS NULL FOR UPDATE',[input.defaultRoleId,id],conn);
      if(!role||/^(admin|administrator|owner|superadmin|root)$/i.test(role.code))throw new HttpError(400,'เลือก Role เริ่มต้นของ Service ที่ไม่มีสิทธิ์ผู้ดูแล','INVALID_DEFAULT_ROLE');
    }
    // Provider outages fail closed at enrollment; configuration must exist before
    // an administrator can require a factor that would otherwise lock out users.
    if(input.requirePhone&&!config.firebasePhoneEnabled)throw new HttpError(400,'เปิดบริการยืนยันเบอร์ก่อนบังคับใช้','PHONE_UNAVAILABLE');
    if(input.requireLine&&!config.lineMfaEnabled)throw new HttpError(400,'เปิดบริการ LINE ก่อนบังคับใช้','LINE_UNAVAILABLE');
    await execute(`UPDATE application_access_policies SET registration=?,default_role_id=?,require_phone=?,require_line=?,minimum_mfa=?,
      required_scopes=?,registration_limit=?,pending_days=?,inactive_days=?,notice_days=?,recovery_days=?,version=version+1,updated_at=UTC_TIMESTAMP(3)
      WHERE application_id=?`,[input.registration,input.defaultRoleId,input.requirePhone,input.requireLine,input.minimumMfa,
      input.requiredScopes.join(' '),input.registrationLimit,input.pendingDays,input.inactiveDays,input.noticeDays,input.recoveryDays,id],conn);
    await execute('UPDATE applications SET sharing_version=sharing_version+1 WHERE id=?',[id],conn);
    await record(conn,'service.policy.updated',id,{before:policyResponse(p),after:input,lifecycleMode:'preview'});
    return policyResponse(await readAccessPolicy(id,conn));
  });
}

// Serializing on this policy row bounds simultaneous registration across workers.
// A revoked/expired membership is a tombstone, never silently re-created by signup.
export async function prepareMembership(applicationId:string,userId:string,email:string,conn:PoolConnection) {
  const p=await readAccessPolicy(applicationId,conn);
  const [member]=await query<Row>('SELECT *,pending_until<=UTC_TIMESTAMP(3) AS expired FROM application_memberships WHERE application_id=? AND user_id=? FOR UPDATE',[applicationId,userId],conn);
  if(member){
    if(member.revoked_at||(member.enrollment==='pending'&&member.expired))throw new HttpError(403,'สิทธิ์สมาชิกถูกระงับหรือคำขอหมดอายุ กรุณาติดต่อผู้ดูแล Service','MEMBERSHIP_UNAVAILABLE');
    if(member.enrollment==='active')return false;
  }
  if(p.registration==='closed')throw new HttpError(403,'Service นี้เปิดรับเฉพาะสมาชิกที่ผู้ดูแลเพิ่มให้','REGISTRATION_CLOSED');
  if(p.registration==='invite'){
    const [invite]=await query<Row>('SELECT email FROM application_invitations WHERE application_id=? AND email=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE',[applicationId,email],conn);
    if(!invite)throw new HttpError(403,'ไม่พบคำเชิญที่ยังใช้งานได้สำหรับบัญชีนี้','INVITATION_REQUIRED');
  }
  if(member)return false;
  const [role]=await query<Row>('SELECT id,code FROM application_roles WHERE id=? AND application_id=? AND revoked_at IS NULL FOR UPDATE',[p.default_role_id,applicationId],conn);
  if(!role||/^(admin|administrator|owner|superadmin|root)$/i.test(role.code))throw new HttpError(403,'Service ยังไม่พร้อมรับสมาชิก','REGISTRATION_CLOSED');
  const [{total}]=await query<Row>("SELECT COUNT(*) AS total FROM application_memberships WHERE application_id=? AND source='registration' AND revoked_at IS NULL FOR UPDATE",[applicationId],conn);
  if(Number(total)>=Number(p.registration_limit))throw new HttpError(429,'Service รับสมาชิกครบจำนวนที่กำหนด กรุณาติดต่อผู้ดูแล','REGISTRATION_LIMIT');
  await execute(`INSERT INTO application_memberships(application_id,user_id,enrollment,source,pending_until)
    VALUES (?,?,'pending','registration',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? DAY))`,[applicationId,userId,p.pending_days],conn);
  return true;
}

export async function enrollmentContext(applicationId:string,userId:string,sessionId:string) {
  const p=await readAccessPolicy(applicationId);
  const [row]=await query<Row>(`SELECT s.mfa_method,u.totp_secret,
    EXISTS(SELECT 1 FROM phone_identities WHERE user_id=u.id) AS phone,
    EXISTS(SELECT 1 FROM line_identities WHERE user_id=u.id) AS line,
    m.enrollment,m.revoked_at,m.pending_until<=UTC_TIMESTAMP(3) AS expired,
    EXISTS(SELECT 1 FROM application_invitations invitation WHERE invitation.application_id=? AND invitation.email=u.email AND invitation.expires_at>UTC_TIMESTAMP(3)) AS invited
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN sso_login_accounts account ON account.id=u.id
    LEFT JOIN application_memberships m ON m.user_id=u.id AND m.application_id=?
    WHERE s.id=? AND s.user_id=? AND s.kind='full' AND s.expires_at>UTC_TIMESTAMP(3)`,[applicationId,applicationId,sessionId,userId]);
  if(!row)throw new HttpError(401,'กรุณาเข้าสู่ระบบใหม่','UNAUTHENTICATED');
  const missing:string[]=[];
  if(p.require_phone&&!row.phone)missing.push('phone');
  if(p.require_line&&!row.line)missing.push('line');
  if((p.minimum_mfa==='strong'&&!['totp','passkey'].includes(row.mfa_method))||row.mfa_method==='recovery')missing.push('strong_mfa');
  const blocked=Boolean(row.revoked_at||(row.enrollment==='pending'&&(row.expired||p.registration==='closed'||(p.registration==='invite'&&!row.invited))));
  return {application:{id:applicationId,name:p.name},requirements:{phone:Boolean(p.require_phone),line:Boolean(p.require_line),minimumMfa:p.minimum_mfa},
    missing,enrolled:!!row.enrollment,blocked,ready:!!row.enrollment&&!blocked&&!missing.length,
    registration:p.registration,policyVersion:Number(p.version),pendingDays:Number(p.pending_days),
    inactiveDays:p.inactive_days===null?null:Number(p.inactive_days),noticeDays:Number(p.notice_days),lifecycleMode:'preview',
    totpEnabled:Boolean(row.totp_secret)};
}

export async function enroll(applicationId:string,userId:string,sessionId:string,email:string,record:AuditWriter) {
  await transaction(async conn=>{
    const [s]=await query<Row>(`SELECT s.id FROM sessions s JOIN sso_login_accounts a ON a.id=s.user_id
      WHERE s.id=? AND s.user_id=? AND s.kind='full' AND s.expires_at>UTC_TIMESTAMP(3) FOR UPDATE`,[sessionId,userId],conn);
    if(!s)throw new HttpError(401,'กรุณาเข้าสู่ระบบใหม่','UNAUTHENTICATED');
    if(await prepareMembership(applicationId,userId,email,conn))await record(conn,'service.registration.started',userId,{applicationId});
  });
}

export async function saveInvitation(actor:Actor,id:string,email:string,days:number,record:AuditWriter) {
  await transaction(async conn=>{
    await lockAdministrators(actor,conn);await readAccessPolicy(id,conn);
    await execute(`INSERT INTO application_invitations(application_id,email,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? DAY))
      ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at)`,[id,email,days],conn);
    await record(conn,'service.invitation.created',id,{email,days});
  });
}
export async function listInvitations(id:string,page:number,limit:number) {
  await readAccessPolicy(id);
  const rows=await query('SELECT email,expires_at AS expiresAt FROM application_invitations WHERE application_id=? ORDER BY email LIMIT ? OFFSET ?',[id,limit+1,(page-1)*limit]);
  return {invitations:rows.slice(0,limit),hasMore:rows.length>limit,page};
}
export async function removeInvitation(actor:Actor,id:string,email:string,record:AuditWriter) {
  await transaction(async conn=>{await lockAdministrators(actor,conn);await readAccessPolicy(id,conn);
    await execute('DELETE FROM application_invitations WHERE application_id=? AND email=?',[id,email],conn);
    await record(conn,'service.invitation.revoked',id,{email});});
}

// Preview only. Neither this endpoint nor background maintenance deletes identities.
// SSO login is not proof of inactivity in a client: report that limitation per row.
export async function lifecyclePreview(applicationId:string,after:string|undefined,limit:number) {
  const p=await readAccessPolicy(applicationId);
  const rows=await query<Row>(`SELECT m.user_id AS userId,u.email,u.account_type AS accountType,m.enrollment,
    m.pending_until AS pendingUntil,m.last_activity_at AS lastActivityAt,m.last_reported_activity_at AS lastReportedActivityAt,
    CASE WHEN m.enrollment='pending' THEN 'unfinished_registration' ELSE 'inactive_membership' END AS reason
    FROM application_memberships m JOIN users u ON u.id=m.user_id WHERE m.application_id=? AND m.revoked_at IS NULL
    AND u.deleted_at IS NULL AND (? IS NULL OR m.user_id>?)
    AND ((m.enrollment='pending' AND m.pending_until<=UTC_TIMESTAMP(3)) OR
      (m.enrollment='active' AND ? IS NOT NULL AND COALESCE(m.last_activity_at,m.created_at)<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)))
    ORDER BY m.user_id LIMIT ?`,[applicationId,after??null,after??null,p.inactive_days,p.inactive_days??36500,limit+1]);
  const data=rows.slice(0,limit);
  return {mode:'preview',policy:policyResponse(p),data,meta:{hasMore:rows.length>limit,nextCursor:rows.length>limit?data.at(-1)?.userId:null},
    warning:'รายงานนี้ไม่ลบหรือระงับบัญชี ต้องตรวจข้อมูลกิจกรรมจากระบบลูกและข้อผูกพันก่อนดำเนินการ'};
}

export async function reportActivity(applicationId:string,userId:string,eventId:string,apiKeyId:string) {
  return transaction(async conn=>{
    const [key]=await query<Row>(`SELECT id FROM api_keys WHERE id=? AND application_id=? AND revoked_at IS NULL
      AND expires_at>UTC_TIMESTAMP(3) AND JSON_CONTAINS(scopes,JSON_QUOTE('member:activity')) FOR UPDATE`,[apiKeyId,applicationId],conn);
    if(!key)throw new HttpError(401,'Service credential is no longer valid','invalid_client');
    const [m]=await query<Row>(`SELECT m.user_id,m.last_reported_activity_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE) AS recent FROM application_memberships m JOIN applications a ON a.id=m.application_id
      JOIN sso_login_accounts account ON account.id=m.user_id WHERE m.application_id=? AND m.user_id=?
      AND m.enrollment='active' AND m.revoked_at IS NULL AND a.revoked_at IS NULL FOR UPDATE`,[applicationId,userId],conn);
    if(!m)throw new HttpError(404,'ไม่พบสมาชิกที่ใช้งานได้ใน Service นี้','NOT_FOUND');
    const [receipt]=await query<Row>('SELECT user_id FROM service_activity_receipts WHERE application_id=? AND event_id=? FOR UPDATE',[applicationId,eventId],conn);
    if(receipt){if(receipt.user_id!==userId)throw new HttpError(409,'รหัสกิจกรรมนี้ถูกใช้แล้ว','EVENT_CONFLICT');return {ok:true,duplicate:true};}
    if(m.recent)return {ok:true,recorded:false,retryAfter:300};
    await execute('INSERT INTO service_activity_receipts(application_id,event_id,user_id,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 DAY))',[applicationId,eventId,userId],conn);
    await execute('UPDATE application_memberships SET last_activity_at=UTC_TIMESTAMP(3),last_reported_activity_at=UTC_TIMESTAMP(3) WHERE application_id=? AND user_id=?',[applicationId,userId],conn);
    return {ok:true,duplicate:false};
  }).catch(error=>{
    if(error&&typeof error==='object'&&'code' in error&&error.code==='ER_DUP_ENTRY')throw new HttpError(409,'รหัสกิจกรรมนี้ถูกใช้แล้ว','EVENT_CONFLICT');
    throw error;
  });
}
