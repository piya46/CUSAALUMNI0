import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool, query, execute, transaction } from '../src/db.js';
import { withMaintenanceLock, maintenanceLockName } from '../src/services/maintenanceLock.js';
import { runMaintenanceTask } from '../src/services/maintenanceTasks.js';
const enabled = process.env.RUN_DB_TESTS === '1';

test('MariaDB rejects concurrent maintenance, keeps lock on transactional connection, and releases after failure', { skip: !enabled }, async () => {
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = withMaintenanceLock('evidence_purge', async connection => {
    const [owner] = await query<any>('SELECT IS_USED_LOCK(?) AS owner, CONNECTION_ID() AS id', [maintenanceLockName('evidence_purge')], connection);
    assert.equal(Number(owner.owner), Number(owner.id));
    await transaction(async tx => { assert.equal(tx, connection); }, connection);
    const [held] = await query<any>('SELECT IS_USED_LOCK(?) AS owner', [maintenanceLockName('evidence_purge')], connection);
    assert.equal(Number(held.owner), Number(owner.id));
    started(); await hold; return 'done';
  });
  try {
    await Promise.race([ready, first]);
    assert.deepEqual(await runMaintenanceTask('evidence_purge'), { outcome: 'skipped' });
  } finally { release(); await first; }
  await assert.rejects(withMaintenanceLock('evidence_purge', async () => { throw new Error('fixture failure'); }));
  const result = await withMaintenanceLock('evidence_purge', async () => 'recovered');
  assert.deepEqual(result, { acquired: true, value: 'recovered' });
});

// Run on a dedicated local DB: this job deliberately scans all expired rows.
test('server cleanup removes expired rows while retaining live entries and audit evidence', { skip: !enabled || process.env.DB_NAME !== 'cusa_scheduler_test' }, async () => {
  const dead = `maintenance-dead-${randomUUID()}`, live = `maintenance-live-${randomUUID()}`;
  const [before] = await query<any>('SELECT COUNT(*) AS total FROM audit_logs');
  try {
    await execute('INSERT INTO rate_limits (bucket_hash,hits,reset_at) VALUES (?,1,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR)),(?,1,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [dead, live]);
    const result = await runMaintenanceTask('expired_credentials');
    assert.equal(result.outcome, 'completed');
    assert.equal((await query('SELECT bucket_hash FROM rate_limits WHERE bucket_hash=?', [dead])).length, 0);
    assert.equal((await query('SELECT bucket_hash FROM rate_limits WHERE bucket_hash=?', [live])).length, 1);
    const [after] = await query<any>('SELECT COUNT(*) AS total FROM audit_logs');
    assert.equal(after.total, before.total);
  } finally { await execute('DELETE FROM rate_limits WHERE bucket_hash IN (?,?)', [dead, live]); }
});
after(async () => { await pool.end(); });
