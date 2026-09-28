import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, query, execute } from './db.js';
import { config } from './config.js';

async function migrate() {
  if (!config.dbUser || !config.dbName) throw new Error('Set DB_USER and DB_NAME before running migrations.');
  const connection = await pool.getConnection();
  const lockName = `cusa-migrate:${createHash('sha256').update(config.dbName).digest('hex').slice(0, 40)}`;
  let locked = false;
  try {
    const [lock] = await query<{ acquired: number }>('SELECT GET_LOCK(?, 10) AS acquired', [lockName], connection);
    if (lock?.acquired !== 1) throw new Error('Another migration is running; try again later.');
    locked = true;
    await execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`, [], connection);
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const source = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const [existing] = await query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = ?', [name], connection);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration ${name} changed; restore it and create a new migration.`);
        console.log(`Already applied: ${name}`);
        continue;
      }
      // Migrations contain simple DDL only: no routines or semicolons in quoted values.
      const statements = source.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
      for (const statement of statements) await execute(statement, [], connection);
      await execute('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [name, checksum], connection);
      console.log(`Applied: ${name}`);
    }
  } finally {
    try {
      if (locked) await query('SELECT RELEASE_LOCK(?)', [lockName], connection);
    } finally {
      connection.release();
    }
  }
}

migrate().catch(error => {
  console.error(error instanceof Error ? error.message : 'Migration failed.');
  process.exitCode = 1;
}).finally(() => pool.end());
