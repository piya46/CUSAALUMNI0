import { z } from 'zod';
import { claimScopeList } from './claimScopes.js';

export const accessPolicySchema = z.object({
  registration: z.enum(['closed','invite','open']),
  defaultRoleId: z.uuid().nullable(),
  requirePhone: z.boolean(), requireLine: z.boolean(),
  minimumMfa: z.enum(['standard','strong']),
  requiredScopes: claimScopeList,
  registrationLimit: z.number().int().min(1).max(100000),
  pendingDays: z.number().int().min(1).max(30),
  inactiveDays: z.number().int().min(30).max(3650).nullable(),
  noticeDays: z.number().int().min(7).max(90),
  recoveryDays: z.number().int().min(7).max(90),
}).strict().refine(p=>p.registration==='closed'||p.defaultRoleId!==null,'Choose a default service role before enabling registration');
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export function pendingMembershipSql() {
  return `(m.enrollment='pending' AND m.pending_until>UTC_TIMESTAMP(3) AND
    (policy.registration='open' OR (policy.registration='invite' AND EXISTS(
      SELECT 1 FROM application_invitations invitation WHERE invitation.application_id=a.id
      AND invitation.email=u.email AND invitation.expires_at>UTC_TIMESTAMP(3)))))`;
}

// Internal identifiers only. Applied again at consent, code exchange and every
// live token lookup, so removing a required identity invalidates existing access.
export function serviceRequirementsSql(app='a',user='u',session='s') {
  return `NOT EXISTS(SELECT 1 FROM application_access_policies requirement WHERE requirement.application_id=${app}.id AND (
    (requirement.require_phone=TRUE AND NOT EXISTS(SELECT 1 FROM phone_identities phone WHERE phone.user_id=${user}.id)) OR
    (requirement.require_line=TRUE AND NOT EXISTS(SELECT 1 FROM line_identities line WHERE line.user_id=${user}.id)) OR
    (requirement.minimum_mfa='strong' AND ${session}.mfa_method NOT IN ('totp','passkey'))
  )) AND ${session}.mfa_method<>'recovery'`;
}
