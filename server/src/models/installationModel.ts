import type { PoolConnection } from 'mysql2/promise';
import { query, execute } from '../db.js';

export async function installationState(connection: PoolConnection): Promise<'empty' | 'existing' | 'complete'> {
  const tables = new Set((await query<{ name: string }>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()', [], connection,
  )).map(row => row.name));
  if (tables.has('installation_state')) {
    const rows = await query('SELECT id FROM installation_state WHERE id = 1', [], connection);
    if (rows.length) return 'complete';
  }
  // Also closes the installer for legacy/CLI deployments without a completion marker.
  for (const table of ['users', 'allowed_emails', 'applications', 'audit_logs', 'audit_outbox']) {
    if (tables.has(table) && (await query(`SELECT 1 FROM ${table} LIMIT 1`, [], connection)).length) return 'existing';
  }
  return 'empty';
}

export async function completeInstallation(connection: PoolConnection) {
  await execute('INSERT INTO installation_state (id) VALUES (1)', [], connection);
}
