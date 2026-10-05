import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { execute, query, transaction } from '../db.js';
import { HttpError } from '../middleware/security.js';
import { lockAdministrators, type Actor, type AuditWriter, type Pagination } from './adminModel.js';

export interface ServiceRole { id: string; applicationId: string; code: string; name: string; description: string }
export type RoleInput = Pick<ServiceRole, 'code' | 'name' | 'description'>;
export type MembershipInput = { department: string; roleIds: string[] };
export const displayName = "COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.name)";
const roleSelect = 'SELECT id, application_id AS applicationId, code, name, description FROM application_roles';

async function activeApplication(id: string, connection?: PoolConnection) {
  const [app] = await query<{ id: string }>(`SELECT id FROM applications WHERE id=? AND revoked_at IS NULL${connection ? ' FOR UPDATE' : ''}`, [id], connection);
  if (!app) throw new HttpError(404, 'ไม่พบ Service ที่เปิดใช้งาน', 'NOT_FOUND');
}
export async function listRoles(applicationId: string) {
  await activeApplication(applicationId);
  return query<ServiceRole>(`${roleSelect} WHERE application_id=? AND revoked_at IS NULL ORDER BY code`, [applicationId]);
}
export async function saveRole(actor: Actor, applicationId: string, roleId: string | null, input: RoleInput, audit: AuditWriter) {
  try {
    return await transaction(async conn => {
      await lockAdministrators(actor, conn); await activeApplication(applicationId, conn);
      const id = roleId || randomUUID();
      let before:ServiceRole|null=null;
      if (roleId) {
        const [existing] = await query<ServiceRole>(`${roleSelect} WHERE id=? AND application_id=? AND revoked_at IS NULL FOR UPDATE`, [id, applicationId], conn);
        before=existing??null;
        if (!existing) throw new HttpError(404, 'ไม่พบ Role', 'NOT_FOUND');
        if (existing.code !== input.code) throw new HttpError(409, 'เปลี่ยนรหัส Role ไม่ได้ กรุณาสร้าง Role ใหม่', 'IMMUTABLE_ROLE_CODE');
        await execute('UPDATE application_roles SET name=?, description=? WHERE id=?', [input.name, input.description, id], conn);
      } else {
        const [{ total }] = await query<{ total: number }>('SELECT COUNT(*) AS total FROM application_roles WHERE application_id=? AND revoked_at IS NULL', [applicationId], conn);
        if (Number(total) >= 100) throw new HttpError(409, 'แต่ละ Service รองรับได้สูงสุด 100 Role', 'ROLE_LIMIT');
        await execute('INSERT INTO application_roles (id,application_id,code,name,description) VALUES (?,?,?,?,?)', [id, applicationId, input.code, input.name, input.description], conn);
      }
      await audit(conn, roleId ? 'service.role.updated' : 'service.role.created', id, { applicationId,before,after:input });
      return { id, applicationId, ...input };
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'รหัส Role นี้เคยถูกใช้ใน Service แล้ว กรุณาเลือกรหัสใหม่', 'ROLE_EXISTS');
    throw error;
  }
}
export async function revokeRole(actor: Actor, applicationId: string, roleId: string, audit: AuditWriter) {
  await transaction(async conn => {
    await lockAdministrators(actor, conn); await activeApplication(applicationId, conn);
    const [role] = await query<ServiceRole>(`${roleSelect} WHERE id=? AND application_id=? AND revoked_at IS NULL FOR UPDATE`, [roleId, applicationId], conn);
    if (!role) throw new HttpError(404, 'ไม่พบ Role', 'NOT_FOUND');
    const [inUse] = await query<{ userId: string }>(`SELECT mr.user_id AS userId FROM application_member_roles mr
      JOIN application_memberships m ON m.application_id=mr.application_id AND m.user_id=mr.user_id
      WHERE mr.application_id=? AND mr.role_id=? AND m.revoked_at IS NULL LIMIT 1`, [applicationId, roleId], conn);
    if (inUse) throw new HttpError(409, 'ยังมีผู้ใช้ที่ได้รับ Role นี้ กรุณาเปลี่ยนสิทธิ์ผู้ใช้ก่อนลบ', 'ROLE_IN_USE');
    await execute('UPDATE application_roles SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?', [roleId], conn);
    await audit(conn, 'service.role.revoked', roleId, { applicationId, code: role.code });
  });
}
export async function listMembers(applicationId: string, options: Pagination) {
  await activeApplication(applicationId);
  const pattern = `%${options.search.replace(/[!%_]/g, '!$&')}%`;
  const from = `application_memberships m JOIN users u ON u.id=m.user_id JOIN sso_login_accounts e ON e.id=u.id`;
  const where = `m.application_id=? AND u.deleted_at IS NULL AND
    (u.email LIKE ? ESCAPE '!' OR ${displayName} LIKE ? ESCAPE '!' OR m.department LIKE ? ESCAPE '!')`;
  const params = [applicationId, pattern, pattern, pattern];
  const [{ total }] = await query<{ total: number }>(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`, params);
  const members = await query<{ userId: string; name: string; email: string; department: string; roleIds: string | string[] }>(`SELECT m.user_id AS userId, ${displayName} AS name, u.email, u.account_type AS accountType, m.enrollment, m.revoked_at AS revokedAt, m.last_activity_at AS lastActivityAt, m.department,
    COALESCE((SELECT JSON_ARRAYAGG(mr.role_id) FROM application_member_roles mr JOIN application_roles r ON r.id=mr.role_id AND r.revoked_at IS NULL
      WHERE mr.application_id=m.application_id AND mr.user_id=m.user_id), JSON_ARRAY()) AS roleIds
    FROM ${from} WHERE ${where} ORDER BY m.created_at DESC, m.user_id LIMIT ? OFFSET ?`, [...params, options.limit, (options.page - 1) * options.limit]);
  return { members: members.map(m => ({ ...m, roleIds: typeof m.roleIds === 'string' ? JSON.parse(m.roleIds) as string[] : m.roleIds })),
    meta: { total: Number(total), totalPages: Math.ceil(Number(total) / options.limit), currentPage: options.page, limit: options.limit } };
}
async function revokeCredentials(applicationId: string, userId: string, conn: PoolConnection) {
  await execute('UPDATE access_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE application_id=? AND user_id=? AND revoked_at IS NULL', [applicationId, userId], conn);
  await execute('DELETE FROM authorization_codes WHERE application_id=? AND user_id=?', [applicationId, userId], conn);
}
export async function saveMember(actor: Actor, applicationId: string, userId: string, input: MembershipInput, audit: AuditWriter) {
  if (!input.roleIds.length || input.roleIds.length > 20 || new Set(input.roleIds).size !== input.roleIds.length) throw new HttpError(400, 'เลือก Role ที่ไม่ซ้ำกัน 1–20 รายการ', 'INVALID_SERVICE_ROLE');
  await transaction(async conn => {
    await lockAdministrators(actor, conn); await activeApplication(applicationId, conn);
    const [user] = await query<{ id: string }>('SELECT u.id FROM users u JOIN sso_login_accounts e ON e.id=u.id WHERE u.id=? AND u.deleted_at IS NULL FOR UPDATE', [userId], conn);
    if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้ที่มีสิทธิ์เข้าสู่ระบบ', 'NOT_FOUND');
    const roles = await query<{ id: string }>(`SELECT id FROM application_roles WHERE application_id=? AND revoked_at IS NULL AND id IN (${input.roleIds.map(() => '?').join(',')}) FOR UPDATE`, [applicationId, ...input.roleIds], conn);
    if (!input.roleIds.length || roles.length !== input.roleIds.length) throw new HttpError(400, 'Role ต้องเป็นของ Service นี้และยังเปิดใช้งานอยู่', 'INVALID_SERVICE_ROLE');
    const before=await membershipSnapshot(applicationId,userId,conn);
    await execute(`INSERT INTO application_memberships (application_id,user_id,department) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE department=VALUES(department),enrollment='active',pending_until=NULL,revoked_at=NULL,updated_at=UTC_TIMESTAMP(3)`, [applicationId, userId, input.department], conn);
    await execute('DELETE FROM application_member_roles WHERE application_id=? AND user_id=?', [applicationId, userId], conn);
    for (const roleId of input.roleIds) await execute('INSERT INTO application_member_roles (application_id,user_id,role_id) VALUES (?,?,?)', [applicationId, userId, roleId], conn);
    await revokeCredentials(applicationId, userId, conn);
    await audit(conn, 'service.member.updated', userId, { applicationId,before,after:input });
  });
}
export async function revokeMember(actor: Actor, applicationId: string, userId: string, audit: AuditWriter) {
  await transaction(async conn => {
    await lockAdministrators(actor, conn); await activeApplication(applicationId, conn);
    const before=await membershipSnapshot(applicationId,userId,conn);
    const result = await execute('UPDATE application_memberships SET revoked_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE application_id=? AND user_id=? AND revoked_at IS NULL', [applicationId, userId], conn);
    if (!result.affectedRows) throw new HttpError(404, 'ไม่พบสมาชิก Service', 'NOT_FOUND');
    await execute('DELETE FROM application_member_roles WHERE application_id=? AND user_id=?', [applicationId, userId], conn);
    await revokeCredentials(applicationId, userId, conn);
    await audit(conn, 'service.member.revoked', userId, { applicationId,before,after:null });
  });
}

async function membershipSnapshot(applicationId:string,userId:string,conn:PoolConnection) {
  const [member]=await query<{department:string;revoked_at:Date|null}>('SELECT department,revoked_at FROM application_memberships WHERE application_id=? AND user_id=? FOR UPDATE',[applicationId,userId],conn);
  if(!member||member.revoked_at)return null;
  const roles=await query<{role_id:string}>('SELECT role_id FROM application_member_roles WHERE application_id=? AND user_id=? ORDER BY role_id',[applicationId,userId],conn);
  return {department:member.department,roleIds:roles.map(row=>row.role_id)};
}
