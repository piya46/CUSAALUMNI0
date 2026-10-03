import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { execute, query, transaction } from '../db.js';
import { HttpError } from '../middleware/security.js';
import { isFreshStrongMfa } from '../services/mfaPolicy.js';
import { hashToken, randomToken } from '../services/crypto.js';

type Role = 'admin' | 'user';
export type Actor = { userId: string; email: string; sessionId?:string };
export type AuditWriter = (connection: PoolConnection, event: string, target?: string, metadata?: Record<string, unknown>) => Promise<void>;
export type Pagination = { page: number; limit: number; search: string };
type AuditFilters = Pagination & {cursor?:string; event?: string; email?: string; status?: 'success' | 'failure'; startAt?: Date; endBefore?: Date };
type AllowedEmail = { id: string; email: string; role: Role; createdAt: Date };
type Application = { id: string; name: string; description: string; redirectUri: string; createdAt: Date; revokedAt: Date | null };
type ApiKey = { id: string; applicationId: string; name: string; prefix: string; scopes: string[]; createdAt: Date; expiresAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };

const allowlistSelect = 'SELECT id, email, role, created_at AS createdAt FROM allowed_emails';
const applicationSelect = `SELECT id, name, description, redirect_uri AS redirectUri,
  created_at AS createdAt, revoked_at AS revokedAt FROM applications`;
const keySelect = `SELECT id, application_id AS applicationId, name, prefix, scopes,
  created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM api_keys`;

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function duplicate(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY');
}

const meta = (total: number | string, options: Pagination) => ({
  total: Number(total), totalPages: Math.ceil(Number(total) / options.limit), currentPage: options.page, limit: options.limit,
});
const searchPattern = (search: string) => `%${search.replace(/[!%_]/g, '!$&')}%`;

async function paginated<T>(select: string, from: string, where: string, params: unknown[], orderBy: string, options: Pagination) {
  const [count] = await query<{ total: string | number }>(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`, params);
  const rows = await query<T>(`SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, options.limit, (options.page - 1) * options.limit]);
  return { rows, meta: meta(count.total, options) };
}

// Every administrative write takes the same locks in the same order. Current reads
// serialize concurrent removals so two requests cannot both remove the last admins.
export async function lockAdministrators(actor: Actor, connection: PoolConnection): Promise<AllowedEmail[]> {
  const admins = await query<AllowedEmail>(`${allowlistSelect} WHERE role = 'admin' ORDER BY id FOR UPDATE`, [], connection);
  if (!admins.some(admin => admin.email.toLowerCase() === actor.email.toLowerCase())) {
    throw new HttpError(403, 'Administrator access is no longer available.', 'ADMIN_REVOKED');
  }
  if(actor.sessionId) {
    const [session]=await query<{id:string;mfa_method:string;authenticated_at:Date}>(`SELECT s.id,s.mfa_method,s.authenticated_at FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.user_id=? AND s.kind='full'
      AND s.expires_at>UTC_TIMESTAMP(3)
      AND u.deleted_at IS NULL AND u.totp_secret IS NOT NULL FOR UPDATE`,[actor.sessionId,actor.userId],connection);
    if(!session||!isFreshStrongMfa(session.mfa_method,session.authenticated_at))throw new HttpError(403,'กรุณายืนยัน Passkey หรือ Authenticator อีกครั้ง','MFA_REAUTH_REQUIRED');
  }
  return admins;
}

function checkRemoval(actor: Actor, target: AllowedEmail | undefined, admins: AllowedEmail[]) {
  if (!target) return;
  if (target.email.toLowerCase() === actor.email.toLowerCase()) {
    throw new HttpError(409, 'You cannot remove your own access.', 'SELF_REMOVAL');
  }
  if (target.role === 'admin' && admins.length <= 1) {
    throw new HttpError(409, 'The last administrator cannot be removed.', 'LAST_ADMIN');
  }
}

async function revokeUser(userId: string, connection: PoolConnection) {
  await execute('UPDATE application_memberships SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId], connection);
  await execute('DELETE FROM application_member_roles WHERE user_id = ?', [userId], connection);
  await execute('UPDATE access_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId], connection);
  await execute('DELETE FROM authorization_codes WHERE user_id = ?', [userId], connection);
  await execute('DELETE FROM sessions WHERE user_id = ?', [userId], connection);
}

export async function listUsers(options: Pagination) {
  const result = await paginated<{ id: string; email: string; name: string; firstName: string; lastName: string; avatar: string | null; role: Role; totpEnabled: number; lastLoginAt: Date | null; createdAt: Date }>(
    `u.id, u.email, COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.name) AS name,
      u.first_name AS firstName, u.last_name AS lastName, u.avatar, a.role, (u.totp_secret IS NOT NULL) AS totpEnabled,
      u.last_login_at AS lastLoginAt, u.created_at AS createdAt`,
    'users u JOIN allowed_emails a ON a.email = u.email',
    "u.deleted_at IS NULL AND (u.email LIKE ? ESCAPE '!' OR u.name LIKE ? ESCAPE '!' OR CONCAT(u.first_name, ' ', u.last_name) LIKE ? ESCAPE '!')",
    Array(3).fill(searchPattern(options.search)), 'u.created_at DESC, u.id', options);
  return { users: result.rows.map(user => ({ ...user, totpEnabled: Boolean(user.totpEnabled) })), meta: result.meta };
}

export async function listAllowedEmails(options: Pagination) {
  const result = await paginated<AllowedEmail>('id, email, role, created_at AS createdAt', 'allowed_emails',
    "email LIKE ? ESCAPE '!'", [searchPattern(options.search)], 'created_at DESC, id', options);
  return { emails: result.rows, meta: result.meta };
}

export async function updateUserProfile(actor: Actor, id: string, data: { firstName: string; lastName: string }, audit: AuditWriter) {
  await transaction(async connection => {
    await lockAdministrators(actor, connection);
    const [user] = await query<{ id: string }>('SELECT id,first_name AS firstName,last_name AS lastName FROM users WHERE id=? AND deleted_at IS NULL FOR UPDATE', [id], connection);
    if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้', 'NOT_FOUND');
    await execute('UPDATE users SET first_name=?,last_name=? WHERE id=?', [data.firstName, data.lastName, id], connection);
    await audit(connection, 'user.profile.updated', id, { before:user,after:data });
  });
}

export async function listApplications(options: Pagination) {
  const result = await paginated<Application>('id, name, description, redirect_uri AS redirectUri, created_at AS createdAt, revoked_at AS revokedAt',
    'applications', "name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!' OR redirect_uri LIKE ? ESCAPE '!'",
    [searchPattern(options.search), searchPattern(options.search), searchPattern(options.search)], 'created_at DESC, id', options);
  return { applications: result.rows, meta: result.meta };
}

export async function listApiKeys(options: Pagination) {
  const result = await paginated<Omit<ApiKey, 'scopes'> & { scopes: string[] | string }>(
    'id, application_id AS applicationId, name, prefix, scopes, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt',
    'api_keys', "name LIKE ? ESCAPE '!' OR prefix LIKE ? ESCAPE '!'", [searchPattern(options.search), searchPattern(options.search)], 'created_at DESC, id', options);
  return { apiKeys: result.rows.map(key => ({ ...key, scopes: parseJson<string[]>(key.scopes) })), meta: result.meta };
}

export async function listAudit(options: AuditFilters) {
  let cursor:{createdAt:string;id:string;startAt:string;endBefore:string}|undefined;
  if(options.cursor) {
    try {const value=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));
      if(!/^[0-9a-f-]{36}$/i.test(value.id)||![value.createdAt,value.startAt,value.endBefore].every(v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v)))) throw new Error();
      cursor=value;
    }catch{throw new HttpError(400,'Invalid audit cursor','VALIDATION_ERROR');}
  }
  const endBefore=options.endBefore??(cursor?new Date(cursor.endBefore):new Date());
  const startAt=options.startAt??(cursor?new Date(cursor.startAt):new Date(endBefore.getTime()-7*86400000));
  if(startAt>=endBefore||endBefore.getTime()-startAt.getTime()>31*86400000) throw new HttpError(400,'ค้นหา Audit ครั้งละไม่เกิน 31 วัน','VALIDATION_ERROR');
  const conditions=['created_at>=?','created_at<?']; const params:unknown[]=[startAt,endBefore];
  if(options.search){conditions.push("(event LIKE ? ESCAPE '!' OR actor_email LIKE ? ESCAPE '!' OR target LIKE ? ESCAPE '!' OR ip LIKE ? ESCAPE '!')");params.push(...Array(4).fill(searchPattern(options.search)));}
  for(const [column,value] of [['event',options.event],['actor_email',options.email],['status',options.status]] as const){if(value!==undefined){conditions.push(`${column}=?`);params.push(value);}}
  if(cursor){conditions.push('(created_at<? OR (created_at=? AND id<?))');params.push(new Date(cursor.createdAt),new Date(cursor.createdAt),cursor.id);}
  const rows=await query<{id:string;createdAt:Date;metadata:Record<string,unknown>|string|null}>(`SELECT id,actor_email AS actorEmail,event,status,target,ip,session_id AS sessionId,user_agent AS userAgent,
    request_id AS requestId,peer_ip AS peerIp,ip_source AS ipSource,actor_type AS actorType,application_id AS applicationId,api_key_id AS apiKeyId,
    metadata,created_at AS createdAt FROM audit_logs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`,[...params,options.limit+1]);
  const hasMore=rows.length>options.limit; const events=rows.slice(0,options.limit);const last=events.at(-1);
  const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({createdAt:last.createdAt.toISOString(),id:last.id,startAt:startAt.toISOString(),endBefore:endBefore.toISOString()})).toString('base64url'):null;
  return {events:events.map(row=>({...row,metadata:row.metadata===null?null:parseJson<Record<string,unknown>>(row.metadata)})),meta:{limit:options.limit,hasMore,nextCursor,startAt,endBefore}};
}

export async function getOverview() {
  const [stats] = await query<Record<'users' | 'allowedEmails' | 'applications' | 'activeApiKeys' | 'mfaEnabled' | 'activeSessions', string | number>>(`
    SELECT
      (SELECT COUNT(*) FROM users u JOIN allowed_emails a ON a.email = u.email WHERE u.deleted_at IS NULL) AS users,
      (SELECT COUNT(*) FROM allowed_emails) AS allowedEmails,
      (SELECT COUNT(*) FROM applications WHERE revoked_at IS NULL) AS applications,
      (SELECT COUNT(*) FROM api_keys k JOIN applications a ON a.id = k.application_id
        WHERE k.revoked_at IS NULL AND k.expires_at > UTC_TIMESTAMP(3) AND a.revoked_at IS NULL) AS activeApiKeys,
      (SELECT COUNT(*) FROM users u JOIN allowed_emails a ON a.email = u.email WHERE u.totp_secret IS NOT NULL AND u.deleted_at IS NULL) AS mfaEnabled,
      (SELECT COUNT(*) FROM sessions s JOIN users u ON u.id = s.user_id JOIN allowed_emails a ON a.email = u.email
        WHERE s.kind = 'full' AND s.expires_at > UTC_TIMESTAMP(3) AND u.deleted_at IS NULL) AS activeSessions`);
  return { stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value)])), activity: (await listAudit({ page: 1, limit: 8, search: '' })).events };
}

export async function addAllowedEmail(actor: Actor, data: { email: string; role: Role }, audit: AuditWriter) {
  try {
    return await transaction(async connection => {
      await lockAdministrators(actor, connection);
      const id = randomUUID();
      await execute('INSERT INTO allowed_emails (id, email, role) VALUES (?, ?, ?)', [id, data.email, data.role], connection);
      const restored = await execute('UPDATE users SET deleted_at = NULL WHERE email = ? AND deleted_at IS NOT NULL', [data.email], connection);
      await audit(connection, 'allowlist.created', data.email, { role: data.role, restoredUser: restored.affectedRows > 0 });
      const [email] = await query<AllowedEmail>(`${allowlistSelect} WHERE id = ?`, [id], connection);
      return email;
    });
  } catch (error) {
    if (duplicate(error)) throw new HttpError(409, 'This email is already on the allowlist.', 'EMAIL_EXISTS');
    throw error;
  }
}

export async function removeAllowedEmail(actor: Actor, id: string, audit: AuditWriter) {
  await transaction(async connection => {
    const admins = await lockAdministrators(actor, connection);
    const [entry] = await query<AllowedEmail>(`${allowlistSelect} WHERE id = ? FOR UPDATE`, [id], connection);
    if (!entry) throw new HttpError(404, 'Allowed email not found.', 'NOT_FOUND');
    checkRemoval(actor, entry, admins);
    const users = await query<{ id: string }>('SELECT id FROM users WHERE email = ? FOR UPDATE', [entry.email], connection);
    for (const user of users) await revokeUser(user.id, connection);
    await execute('DELETE FROM allowed_emails WHERE id = ?', [id], connection);
    await audit(connection, 'allowlist.removed', entry.email, { revokedUsers: users.length });
  });
}

export async function removeUser(actor: Actor, id: string, audit: AuditWriter) {
  if (id === actor.userId) throw new HttpError(409, 'You cannot remove your own account.', 'SELF_REMOVAL');
  await transaction(async connection => {
    const admins = await lockAdministrators(actor, connection);
    const [user] = await query<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id], connection);
    if (!user) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
    const [entry] = await query<AllowedEmail>(`${allowlistSelect} WHERE email = ? FOR UPDATE`, [user.email], connection);
    checkRemoval(actor, entry, admins);
    await revokeUser(user.id, connection);
    await execute('DELETE FROM allowed_emails WHERE email = ?', [user.email], connection);
    await execute('UPDATE users SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?', [id], connection);
    await audit(connection, 'user.removed', user.email, { softDeleted: true });
  });
}

export async function revokeUserSessions(actor: Actor, id: string, audit: AuditWriter) {
  return transaction(async connection => {
    await lockAdministrators(actor, connection);
    const [user] = await query<{ id: string }>('SELECT id FROM users WHERE id=? AND deleted_at IS NULL FOR UPDATE', [id], connection);
    if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้', 'NOT_FOUND');
    const tokens = await execute('UPDATE access_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=? AND revoked_at IS NULL', [id], connection);
    await execute('DELETE FROM authorization_codes WHERE user_id=?', [id], connection);
    const sessions = await execute('DELETE FROM sessions WHERE user_id=?', [id], connection);
    await audit(connection, 'user.sessions.revoked', id, { sessions: sessions.affectedRows, accessTokens: tokens.affectedRows });
    return { sessions: sessions.affectedRows };
  });
}

export async function addApplication(actor: Actor, data: { name: string; description: string; redirectUri: string }, audit: AuditWriter) {
  return transaction(async connection => {
    await lockAdministrators(actor, connection);
    const id = randomUUID();
    await execute('INSERT INTO applications (id, name, description, redirect_uri) VALUES (?, ?, ?, ?)', [id, data.name, data.description, data.redirectUri], connection);
    await audit(connection, 'application.created', id, { name: data.name });
    const [app] = await query<Application>(`${applicationSelect} WHERE id = ?`, [id], connection);
    return app;
  });
}

export async function revokeApplication(actor: Actor, id: string, audit: AuditWriter) {
  await transaction(async connection => {
    await lockAdministrators(actor, connection);
    const [app] = await query<Application>(`${applicationSelect} WHERE id = ? FOR UPDATE`, [id], connection);
    if (!app) throw new HttpError(404, 'Application not found.', 'NOT_FOUND');
    if (app.revokedAt) return;
    await execute('UPDATE applications SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [id], connection);
    await execute('UPDATE api_keys SET revoked_at = UTC_TIMESTAMP(3) WHERE application_id = ? AND revoked_at IS NULL', [id], connection);
    await execute('UPDATE access_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE application_id = ? AND revoked_at IS NULL', [id], connection);
    await execute('DELETE FROM authorization_codes WHERE application_id = ?', [id], connection);
    await audit(connection, 'application.revoked', id, { name: app.name });
  });
}

export async function addApiKey(actor: Actor, data: { applicationId: string; name: string; scopes: string[]; expiresInDays: number }, audit: AuditWriter) {
  return transaction(async connection => {
    await lockAdministrators(actor, connection);
    const [app] = await query<{ id: string; revoked_at: Date | null }>('SELECT id, revoked_at FROM applications WHERE id = ? FOR UPDATE', [data.applicationId], connection);
    if (!app || app.revoked_at) throw new HttpError(409, 'Choose an active application.', 'APPLICATION_UNAVAILABLE');
    const id = randomUUID();
    const key = `cusa_${randomToken(32)}`;
    const prefix = key.slice(0, 13);
    const expiresAt = new Date(Date.now() + data.expiresInDays * 86_400_000);
    await execute(`INSERT INTO api_keys (id, application_id, name, prefix, key_hash, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, data.applicationId, data.name, prefix, hashToken(key), JSON.stringify(data.scopes), expiresAt], connection);
    await audit(connection, 'api_key.created', id, { applicationId: data.applicationId, scopes: data.scopes, expiresInDays: data.expiresInDays });
    const [apiKey] = await query<Omit<ApiKey, 'scopes'> & { scopes: string[] | string }>(`${keySelect} WHERE id = ?`, [id], connection);
    return { key, apiKey: { ...apiKey, scopes: parseJson<string[]>(apiKey.scopes) } };
  });
}

export async function revokeApiKey(actor: Actor, id: string, audit: AuditWriter) {
  await transaction(async connection => {
    await lockAdministrators(actor, connection);
    const [key] = await query<{ id: string; revoked_at: Date | null }>('SELECT id, revoked_at FROM api_keys WHERE id = ? FOR UPDATE', [id], connection);
    if (!key) throw new HttpError(404, 'API key not found.', 'NOT_FOUND');
    if (key.revoked_at) return;
    await execute('UPDATE api_keys SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [id], connection);
    await audit(connection, 'api_key.revoked', id);
  });
}

export async function bootstrapAdmin(email: string, connection?: PoolConnection, source: 'cli' | 'web_install' = 'cli',context?:{requestId?:string;ip?:string;peerIp?:string;ipSource?:string;userAgent?:string}): Promise<{ created: boolean }> {
  const create = async (connection: PoolConnection) => {
    const admins = await query<AllowedEmail>(`${allowlistSelect} WHERE role = 'admin' ORDER BY id FOR UPDATE`, [], connection);
    const [existing] = await query<AllowedEmail>(`${allowlistSelect} WHERE email = ? FOR UPDATE`, [email], connection);
    if (existing?.role === 'admin') return { created: false };
    if (existing) throw new Error('This email already has user access. Bootstrap never silently elevates an existing user.');
    if (admins.length) throw new Error('An administrator already exists. Sign in as an administrator to add further access.');
    const [existingUser] = await query<{ id: string }>('SELECT id FROM users WHERE email = ? FOR UPDATE', [email], connection);
    if (existingUser) throw new Error('This email has an existing user record. Bootstrap never silently elevates an existing user.');
    const id = randomUUID();
    await execute("INSERT INTO allowed_emails (id, email, role) VALUES (?, ?, 'admin')", [id, email], connection);
    await execute("INSERT INTO audit_logs (id, event, target, metadata,actor_type,request_id,ip,peer_ip,ip_source,user_agent) VALUES (?, 'admin.bootstrapped', ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), email, JSON.stringify({ source }),source==='cli'?'system':'installer',context?.requestId??null,context?.ip??null,context?.peerIp??null,context?.ipSource??null,context?.userAgent??null], connection);
    return { created: true };
  };
  return connection ? create(connection) : transaction(create);
}
