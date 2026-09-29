import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PoolConnection } from 'mysql2/promise';
import { pool, query, execute } from '../db.js';
import { config } from '../config.js';

export class MigrationBusyError extends Error {}
export const migrationLockName = `cusa-migrate:${createHash('sha256').update(config.dbName).digest('hex').slice(0, 40)}`;

// Named locks survive MariaDB DDL's implicit commits. Hold one connection throughout.
export async function withMigrationLock<T>(work: (connection: PoolConnection) => Promise<T>, timeout = 10): Promise<T> {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [lock] = await query<{ acquired: number }>('SELECT GET_LOCK(?, ?) AS acquired', [migrationLockName, timeout], connection);
    if (lock?.acquired !== 1) throw new MigrationBusyError('Another installation or migration is running.');
    locked = true;
    return await work(connection);
  } finally {
    try {
      if (locked) await query('SELECT RELEASE_LOCK(?)', [migrationLockName], connection);
    } finally { connection.release(); }
  }
}

export async function applyMigrations(connection: PoolConnection): Promise<string[]> {
  await execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`, [], connection);
  const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('Migration files are missing.');
  const applied: string[] = [];
  for (const name of files) {
    const source = await readFile(`${directory}/${name}`, 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const [existing] = await query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = ?', [name], connection);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error(`Applied migration ${name} changed; restore it and create a new migration.`);
      continue;
    }
    // Files contain simple DDL only; no routines or semicolons inside quoted values.
    const statements = source.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    for (const statement of statements) await execute(statement, [], connection);
    await execute('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [name, checksum], connection);
    applied.push(name);
  }
  return applied;
}

export async function migrate() {
  if (!config.dbUser || !config.dbName) throw new Error('Set DB_USER and DB_NAME before running migrations.');
  return withMigrationLock(applyMigrations);
}
