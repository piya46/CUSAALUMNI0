import type { PoolConnection } from 'mysql2/promise';
import { execute, query } from '../db.js';
import { config } from '../config.js';
import { getAuditQueueHealth } from '../models/auditModel.js';
import { purgeResetEvidence } from '../models/mfaResetModel.js';
import { withMaintenanceLock, type MaintenanceTask } from './maintenanceLock.js';
import type { JobOutcome } from './backgroundScheduler.js';

// User records, MFA evidence and append-only audit tables are not swept here.
const expiryTables = [
  ['factor_challenges', 'expires_at'], ['sessions', 'expires_at'], ['oauth_flows', 'expires_at'],
  ['otp_challenges', 'expires_at'], ['mfa_enrollments', 'expires_at'],
  ['authorization_codes', 'expires_at'], ['access_tokens', 'expires_at'], ['rate_limits', 'reset_at'],
  ['sso_consents', 'expires_at'],
] as const;

export async function cleanupExpiredCredentials(connection: PoolConnection, signal?: AbortSignal) {
  const removed: Record<string, number> = {};
  for (const [table, column] of expiryTables) {
    removed[table] = 0;
    for (let batch = 0; batch < 100; batch++) {
      signal?.throwIfAborted();
      const result = await execute(`DELETE FROM ${table} WHERE ${column}<UTC_TIMESTAMP(3) LIMIT 1000`, [], connection);
      removed[table] += result.affectedRows;
      if (result.affectedRows < 1000) break;
    }
  }
  return removed;
}

export async function checkOperations(connection: PoolConnection) {
  const queue = await getAuditQueueHealth(connection);
  await query('SELECT phone_required FROM users LIMIT 0', [], connection);
  await query('SELECT queue_enabled,queue_rate,queue_capacity,queue_ip_limit FROM applications LIMIT 0', [], connection);
  for (const table of ['passkeys', 'line_identities', 'phone_identities', 'factor_challenges', 'sso_consents'])
    await query(`SELECT 1 FROM ${table} LIMIT 0`, [], connection);
  await query('SELECT allowed_claim_scopes,sharing_purpose,sharing_version FROM applications LIMIT 0',[],connection);
  const [server] = await query<{ zone: string; role: string }>('SELECT @@session.time_zone AS zone,CURRENT_ROLE() AS role', [], connection);
  // MariaDB can include authentication hashes in raw SHOW GRANTS output.
  const grants = await query<Record<string, string>>('SHOW GRANTS FOR CURRENT_USER', [], connection);
  const issues: string[] = [];
  for (const row of grants) for (const grant of Object.values(row)) {
    if (/\bWITH GRANT OPTION\b/i.test(grant)) issues.push('Runtime must not delegate database privileges');
    const match = grant.match(/^GRANT (.+) ON (.+) TO /i);
    if (!match) { if (/^GRANT /i.test(grant)) issues.push('Role grants require DBA review'); continue; }
    const scope = match[2].replaceAll('`', '');
    const privileges = match[1].split(',').map(p => p.trim().toUpperCase());
    if (scope === '*.*' || scope === `${config.dbName}.*` ||
        ['audit_logs', 'installation_state', 'schema_migrations'].some(table => scope === `${config.dbName}.${table}`)) {
      const allowed = scope === `${config.dbName}.audit_logs` ? ['SELECT', 'INSERT', 'USAGE'] : ['SELECT', 'USAGE'];
      if (privileges.some(p => !allowed.includes(p))) issues.push('Runtime has excessive rights on protected data or schema');
    }
  }
  if (server.role && server.role !== 'NULL') issues.push('Active role privileges need explicit DBA verification');
  const [evidence] = await query<{ total: number }>('SELECT COUNT(*) AS total FROM mfa_reset_requests WHERE purged_at IS NULL AND delete_after<=UTC_TIMESTAMP(3)', [], connection);
  if (Number(evidence.total) > 0) issues.push('Evidence deletion deadline exceeded');
  if (server.zone !== '+00:00') issues.push('Database session is not UTC');
  if (queue.pending >= 10000 || queue.oldestAgeSeconds >= 60) issues.push('Audit backlog exceeds alert threshold');
  return { ok: issues.length === 0, queue, issues: [...new Set(issues)] };
}

export async function runMaintenanceTask(task: MaintenanceTask, signal?: AbortSignal): Promise<JobOutcome> {
  signal?.throwIfAborted();
  const result = await withMaintenanceLock(task, async connection => {
    signal?.throwIfAborted();
    switch (task) {
      case 'evidence_purge': return { ok: true, details: { deleted: await purgeResetEvidence(connection, signal) } };
      case 'expired_credentials': return { ok: true, details: { removed: await cleanupExpiredCredentials(connection, signal) } };
      case 'operations_check': {
        const details = await checkOperations(connection);
        return { ok: details.ok, details };
      }
    }
  });
  return result.acquired ? { outcome: 'completed', ...result.value } : { outcome: 'skipped' };
}
