import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { pool, query, execute } from '../src/db.js';
import { config } from '../src/config.js';
import { installationService, InstallationError } from '../src/services/installation.js';
import { applyMigrations, migrate, MigrationBusyError, withMigrationLock } from '../src/services/migrations.js';

const enabled = process.env.RUN_INSTALL_TESTS === '1';
if (enabled && (!['localhost', '127.0.0.1'].includes(config.dbHost) || !/^cusa_install_\d+_test$/.test(config.dbName))) {
  throw new Error('Installer tests require an empty, dedicated local cusa_install_<number>_test database.');
}
after(async () => { await pool.end(); });

test('real installer retries partial DDL, rolls back admin on failure, serializes runs and permanently closes', { skip: !enabled }, async () => {
  assert.equal((await query('SHOW TABLES')).length, 0, 'Use a new empty test database');
  // Simulate interruption after the migration journal was created, before any DDL was recorded.
  await execute(`CREATE TABLE schema_migrations (
    name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB`);
  assert.equal((await installationService.check()).adminEmail, config.bootstrapAdminEmail);
  assert.equal((await query('SHOW TABLES')).length, 1, 'Check must not run migrations');
  await withMigrationLock(async () => {
    await assert.rejects(installationService.run(), error => error instanceof MigrationBusyError);
  });
  await withMigrationLock(applyMigrations);
  // Existing deployments without a completion row are protected too.
  await execute("INSERT INTO allowed_emails (id,email,role) VALUES (?, 'existing@example.test', 'admin')", [randomUUID()]);
  await assert.rejects(installationService.run(), error => error instanceof InstallationError && error.code === 'INSTALL_LOCKED');
  await execute("DELETE FROM allowed_emails WHERE email = 'existing@example.test'");

  await execute(`CREATE TRIGGER test_install_failure BEFORE INSERT ON installation_state
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test marker failure'`);
  await assert.rejects(installationService.run());
  assert.equal((await query('SELECT id FROM allowed_emails')).length, 0);
  assert.equal((await query('SELECT id FROM audit_logs')).length, 0);
  assert.equal((await query('SELECT id FROM installation_state')).length, 0);
  await execute('DROP TRIGGER test_install_failure');

  const outcomes = await Promise.allSettled([installationService.run(), installationService.run()]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const failure = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failure.reason instanceof MigrationBusyError || (failure.reason instanceof InstallationError && failure.reason.code === 'INSTALL_LOCKED'));
  const [admin] = await query<{ email: string; role: string }>('SELECT email,role FROM allowed_emails');
  assert.deepEqual(admin, { email: config.bootstrapAdminEmail, role: 'admin' });
  assert.equal((await query("SELECT id FROM audit_logs WHERE event = 'admin.bootstrapped'")).length, 1);
  assert.equal((await query('SELECT id FROM installation_state')).length, 1);
  assert.equal((await query('SELECT name FROM schema_migrations')).length, 7);
  assert.deepEqual(await migrate(), [], 'Future migration runs must preserve installation lock');
  await assert.rejects(installationService.check(), error => error instanceof InstallationError && error.code === 'INSTALL_LOCKED');
  await assert.rejects(installationService.run(), error => error instanceof InstallationError && error.code === 'INSTALL_LOCKED');
  await execute("UPDATE schema_migrations SET checksum = REPEAT('0',64) WHERE name = '002_service_roles.sql'");
  await assert.rejects(migrate(), /changed/, 'Never silently rewrite an applied migration');
});
