import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { query, execute, transaction } from '../db.js';
import { config } from '../config.js';
import { hashToken, randomToken, otpHash, verifyOtpHash, seal, unseal } from '../services/crypto.js';
import { totpStep } from '../services/totp.js';
import type { Identity } from '../types.js';

type Row = Record<string, any>;
export type AuthAudit=(conn:PoolConnection,event:string,target?:string,metadata?:unknown)=>Promise<void>;
const sessionSelect = `SELECT s.*, u.email,COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.name) AS name,u.first_name,u.last_name,u.avatar,u.totp_secret,a.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN allowed_emails a ON a.email=u.email WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(3) AND u.deleted_at IS NULL`;
export async function findSession(token: string): Promise<Identity | undefined> {
  const [s] = await query<Row>(sessionSelect, [hashToken(token)]);
  return s && { sessionId: s.id, userId: s.user_id, email: s.email, name: s.name, firstName: s.first_name, lastName: s.last_name, avatar: s.avatar, role: s.role, kind: s.kind, csrfToken: s.csrf_token, totpEnabled: Boolean(s.totp_secret), mfaMethod: s.mfa_method, authenticatedAt: s.authenticated_at };
}
export async function recordAudit(data: { actorId: string | null; actorEmail: string | null; sessionId: string|null; status:'success'|'failure'; userAgent:string; event: string; target: string | null; ip: string; metadata: unknown }, conn?: PoolConnection) {
  const id=randomUUID();
  await execute('INSERT INTO audit_outbox (id,payload) VALUES (?,?)',[id,JSON.stringify({...data,metadata:data.metadata??{},id,ip:data.ip.slice(0,64),createdAt:new Date().toISOString()})],conn);
}
export async function hitRateLimit(bucketHash: string, limit: number, seconds: number): Promise<boolean> {
  return transaction(async conn => {
    await execute('INSERT INTO rate_limits (bucket_hash,hits,reset_at) VALUES (?,1,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND)) ON DUPLICATE KEY UPDATE hits=IF(reset_at<=UTC_TIMESTAMP(3),1,hits+1),reset_at=IF(reset_at<=UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),reset_at)', [bucketHash,seconds,seconds], conn);
    const [row] = await query<Row>('SELECT hits FROM rate_limits WHERE bucket_hash=?', [bucketHash], conn);
    return row.hits <= limit;
  });
}
export async function createFlow(state: string, browser: string, nonce: string, verifier: string, returnTo: string) {
  await execute('INSERT INTO oauth_flows (state_hash,browser_hash,nonce,verifier,return_to,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))', [hashToken(state),hashToken(browser),nonce,seal(verifier),returnTo]);
}
export async function takeFlow(state: string, browser: string) {
  return transaction(async conn => {
    const [row] = await query<Row>('SELECT * FROM oauth_flows WHERE state_hash=? AND browser_hash=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE', [hashToken(state),hashToken(browser)], conn);
    if (!row) return null;
    await execute('DELETE FROM oauth_flows WHERE state_hash=?', [hashToken(state)], conn);
    return { nonce: row.nonce as string, verifier: unseal(row.verifier), returnTo: row.return_to as string };
  });
}
export async function startGoogleSession(profile: { sub: string; email: string; name: string; avatar: string | null; firstName?: string; lastName?: string }, oldToken?: string,record?:(conn:PoolConnection,userId:string,sessionId:string)=>Promise<void>) {
  return transaction(async conn => {
    const [allowed] = await query<Row>('SELECT id FROM allowed_emails WHERE email=? FOR UPDATE', [profile.email], conn);
    if (!allowed) return null;
    let [user] = await query<Row>('SELECT * FROM users WHERE google_sub=? FOR UPDATE', [profile.sub], conn);
    if (user?.deleted_at) return null;
    const [collision] = await query<Row>('SELECT id FROM users WHERE email=? AND google_sub<>?', [profile.email,profile.sub], conn);
    if (collision) return null;
    if (!user) {
      user = { id: randomUUID() };
      await execute('INSERT INTO users (id,google_sub,email,name,avatar,first_name,last_name) VALUES (?,?,?,?,?,?,?)', [user.id,profile.sub,profile.email,profile.name,profile.avatar,profile.firstName ?? '',profile.lastName ?? ''], conn);
    } else {
      if (user.email !== profile.email) await execute('DELETE FROM sessions WHERE user_id=?', [user.id], conn);
      await execute('UPDATE users SET email=?,name=?,avatar=? WHERE id=?', [profile.email,profile.name,profile.avatar,user.id], conn);
    }
    if (oldToken) await execute('DELETE FROM sessions WHERE token_hash=?', [hashToken(oldToken)], conn);
    // Bound abandoned browser sessions without extending any existing session.
    await execute('DELETE FROM sessions WHERE user_id=? AND (kind=\'pending\' OR expires_at<=UTC_TIMESTAMP(3))', [user.id], conn);
    const token = randomToken(); const id = randomUUID();
    await execute('INSERT INTO sessions (id,token_hash,user_id,kind,csrf_token,expires_at) VALUES (?,?,?,\'pending\',?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))', [id,hashToken(token),user.id,randomToken()], conn);
    await record?.(conn,user.id,id);
    return { token, userId: user.id as string,sessionId:id };
  });
}
export async function createOtp(sessionId: string, code: string,record?:AuthAudit) {
  const encoded=await otpHash(sessionId,code);
  return transaction(async conn => {
    const [s] = await query<Row>('SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.kind=\'pending\' AND s.expires_at>UTC_TIMESTAMP(3) AND u.totp_secret IS NULL FOR UPDATE', [sessionId], conn);
    if (!s) return null;
    await execute('DELETE FROM otp_challenges WHERE session_id=?', [sessionId], conn);
    const id = randomUUID();
    await execute('INSERT INTO otp_challenges (id,session_id,code_hash,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MINUTE))', [id,sessionId,encoded,config.otpMinutes], conn);
    await record?.(conn,'auth.otp.requested');
    return id;
  });
}
export async function discardOtp(id: string) { await execute('DELETE FROM otp_challenges WHERE id=?', [id]); }
async function promote(sessionId: string, userId: string, method: string, conn: PoolConnection,record?:AuthAudit) {
  const token = randomToken();
  await execute('UPDATE sessions SET kind=\'full\',token_hash=?,csrf_token=?,mfa_method=?,authenticated_at=UTC_TIMESTAMP(3),expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? HOUR) WHERE id=?', [hashToken(token),randomToken(),method,config.sessionHours,sessionId], conn);
  await execute('UPDATE users SET last_login_at=UTC_TIMESTAMP(3),mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?', [userId], conn);
  const older=await query<Row>('SELECT id FROM sessions WHERE user_id=? AND id<>? AND kind=\'full\' AND expires_at>UTC_TIMESTAMP(3) ORDER BY authenticated_at DESC,created_at DESC LIMIT 100 OFFSET 2',[userId,sessionId],conn);
  for (const s of older) await execute('DELETE FROM sessions WHERE id=?',[s.id],conn);
  await record?.(conn,`auth.${method}.success`,userId);
  return token;
}
async function failure(userId:string,conn:PoolConnection) {
  await execute('UPDATE users SET mfa_failed_attempts=IF(mfa_locked_until IS NOT NULL AND mfa_locked_until<=UTC_TIMESTAMP(3),1,mfa_failed_attempts+1),mfa_locked_until=IF(mfa_failed_attempts>=5,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE),NULL) WHERE id=?',[userId],conn);
}
async function locked(userId:string,conn:PoolConnection) {
  const [row]=await query<Row>('SELECT mfa_locked_until>UTC_TIMESTAMP(3) AS locked FROM users WHERE id=? FOR UPDATE',[userId],conn); return Boolean(row?.locked);
}
export async function isMfaLocked(userId:string) {
  const [row]=await query<Row>('SELECT mfa_locked_until>UTC_TIMESTAMP(3) AS locked FROM users WHERE id=?',[userId]); return Boolean(row?.locked);
}
export async function verifyEmailOtp(sessionId: string, code: string,record?:AuthAudit): Promise<string | null> {
  return transaction(async conn => {
    const [s] = await query<Row>('SELECT s.*,u.totp_secret FROM sessions s JOIN users u ON u.id=s.user_id JOIN allowed_emails a ON a.email=u.email WHERE s.id=? AND s.kind=\'pending\' AND s.expires_at>UTC_TIMESTAMP(3) FOR UPDATE', [sessionId], conn);
    if (!s || s.totp_secret) return null;
    if (await locked(s.user_id,conn)) return null;
    const [challenge] = await query<Row>('SELECT * FROM otp_challenges WHERE session_id=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3) AND attempts<5 FOR UPDATE', [sessionId], conn);
    if (!challenge) { await failure(s.user_id,conn); return null; }
    await execute('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?', [challenge.id], conn);
    if (!await verifyOtpHash(challenge.code_hash,sessionId,code)) { await failure(s.user_id,conn); return null; }
    await execute('UPDATE otp_challenges SET consumed_at=UTC_TIMESTAMP(3) WHERE id=?', [challenge.id], conn);
    return promote(sessionId,s.user_id,'email',conn,record);
  });
}
export async function verifyTotp(sessionId: string, code: string, action: 'login' | 'disable',record?:AuthAudit): Promise<string | boolean | null> {
  return transaction(async conn => {
    const [s] = await query<Row>('SELECT s.*,u.email,u.totp_secret,u.totp_last_step FROM sessions s JOIN users u ON u.id=s.user_id JOIN allowed_emails a ON a.email=u.email WHERE s.id=? AND s.expires_at>UTC_TIMESTAMP(3) FOR UPDATE', [sessionId], conn);
    if (!s?.totp_secret || s.kind !== (action === 'login' ? 'pending' : 'full')) return null;
    if (await locked(s.user_id,conn)) return null;
    const step = totpStep(s.email,unseal(s.totp_secret),code);
    if (step === null || (s.totp_last_step !== null && step <= Number(s.totp_last_step))) { await failure(s.user_id,conn); return null; }
    if (action === 'disable') {
      await execute('UPDATE users SET totp_secret=NULL,totp_last_step=NULL WHERE id=?', [s.user_id], conn);
      await execute('DELETE FROM sessions WHERE user_id=? AND id<>?', [s.user_id,sessionId], conn);
      await execute('DELETE FROM mfa_enrollments WHERE session_id=?', [sessionId], conn);
      await execute('DELETE FROM mfa_recovery_codes WHERE user_id=?',[s.user_id],conn);
      await execute('UPDATE users SET mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?',[s.user_id],conn);
      await record?.(conn,'mfa.disabled',s.user_id);
      return true;
    }
    await execute('UPDATE users SET totp_last_step=? WHERE id=?', [step,s.user_id], conn);
    return promote(sessionId,s.user_id,'totp',conn,record);
  });
}
export function generateRecoveryCodes() { return Array.from({length:10},() => randomToken(15)); }
export async function saveEnrollment(sessionId: string, secret: string, codes: string[],record?:AuthAudit) {
  await transaction(async conn=>{
    await execute('INSERT INTO mfa_enrollments (session_id,secret,recovery_hashes,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)) ON DUPLICATE KEY UPDATE secret=VALUES(secret),recovery_hashes=VALUES(recovery_hashes),expires_at=VALUES(expires_at)', [sessionId,seal(secret),JSON.stringify(codes.map(hashToken))],conn);
    await record?.(conn,'mfa.setup.started');
  });
}
export async function enableTotp(sessionId: string, code: string,record?:AuthAudit) {
  return transaction(async conn => {
    const [s] = await query<Row>('SELECT s.*,u.email,u.totp_secret FROM sessions s JOIN users u ON u.id=s.user_id JOIN allowed_emails a ON a.email=u.email WHERE s.id=? AND s.kind=\'full\' AND s.expires_at>UTC_TIMESTAMP(3) FOR UPDATE', [sessionId], conn);
    if (!s || (s.totp_secret && s.mfa_method !== 'recovery')) return false;
    if (await locked(s.user_id,conn)) return false;
    const [enroll] = await query<Row>('SELECT * FROM mfa_enrollments WHERE session_id=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE', [sessionId], conn);
    if (!enroll) return false;
    const step = totpStep(s.email,unseal(enroll.secret),code);
    if (step === null) { await failure(s.user_id,conn); return false; }
    await execute('UPDATE users SET totp_secret=?,totp_last_step=?,mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?', [enroll.secret,step,s.user_id], conn);
    await execute('DELETE FROM mfa_recovery_codes WHERE user_id=?', [s.user_id], conn);
    const hashes: string[] = typeof enroll.recovery_hashes === 'string' ? JSON.parse(enroll.recovery_hashes) : enroll.recovery_hashes;
    for (const hash of hashes) await execute('INSERT INTO mfa_recovery_codes (id,user_id,code_hash) VALUES (?,?,?)',[randomUUID(),s.user_id,hash],conn);
    await execute('UPDATE sessions SET mfa_method=\'totp\',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?', [sessionId], conn);
    await execute('DELETE FROM sessions WHERE user_id=? AND id<>?', [s.user_id,sessionId], conn);
    await execute('DELETE FROM mfa_enrollments WHERE session_id=?', [sessionId], conn);
    await record?.(conn,'mfa.enabled',s.user_id);
    return true;
  });
}
export async function listSessions(userId: string) {
  return query<Row>('SELECT id,created_at,expires_at,mfa_method FROM sessions WHERE user_id=? AND kind=\'full\' AND expires_at>UTC_TIMESTAMP(3) ORDER BY created_at DESC', [userId]);
}
export async function deleteSession(id: string, userId: string,record?:AuthAudit) {
  return transaction(async conn=>{
    const result=await execute('DELETE FROM sessions WHERE id=? AND user_id=?',[id,userId],conn);
    if(result.affectedRows)await record?.(conn,'session.revoked',id);
    return result;
  });
}

export async function recoveryCodesRemaining(userId: string) {
  const [r] = await query<Row>('SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL',[userId]); return Number(r.count);
}
export async function verifyRecovery(sessionId: string, code: string,record?:AuthAudit) {
  return transaction(async conn => {
    const [s] = await query<Row>('SELECT s.*,u.totp_secret FROM sessions s JOIN users u ON u.id=s.user_id JOIN allowed_emails a ON a.email=u.email WHERE s.id=? AND s.kind=\'pending\' AND s.expires_at>UTC_TIMESTAMP(3) AND u.deleted_at IS NULL FOR UPDATE',[sessionId],conn);
    if (!s?.totp_secret) return null;
    if (await locked(s.user_id,conn)) return null;
    const result = await execute('UPDATE mfa_recovery_codes SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND code_hash=? AND used_at IS NULL',[s.user_id,hashToken(code)],conn);
    if (result.affectedRows !== 1) { await failure(s.user_id,conn); return null; }
    return promote(sessionId,s.user_id,'recovery',conn,record);
  });
}
export async function regenerateRecovery(sessionId: string, code: string,record?:AuthAudit) {
  return transaction(async conn => {
    const [s] = await query<Row>('SELECT s.*,u.email,u.totp_secret,u.totp_last_step FROM sessions s JOIN users u ON u.id=s.user_id JOIN allowed_emails a ON a.email=u.email WHERE s.id=? AND s.kind=\'full\' AND s.expires_at>UTC_TIMESTAMP(3) AND u.deleted_at IS NULL FOR UPDATE',[sessionId],conn);
    if (!s?.totp_secret) return null;
    if (await locked(s.user_id,conn)) return null;
    const step = totpStep(s.email,unseal(s.totp_secret),code);
    if (step === null || (s.totp_last_step !== null && step <= Number(s.totp_last_step))) { await failure(s.user_id,conn); return null; }
    const codes = generateRecoveryCodes();
    await execute('UPDATE users SET totp_last_step=?,mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?',[step,s.user_id],conn);
    await execute('DELETE FROM mfa_recovery_codes WHERE user_id=?',[s.user_id],conn);
    for (const recovery of codes) await execute('INSERT INTO mfa_recovery_codes (id,user_id,code_hash) VALUES (?,?,?)',[randomUUID(),s.user_id,hashToken(recovery)],conn);
    await record?.(conn,'mfa.recovery.regenerated',s.user_id);
    return codes;
  });
}
