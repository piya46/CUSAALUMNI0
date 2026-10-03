import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createBackgroundScheduler, type JobOutcome } from '../src/services/backgroundScheduler.js';
import { cleanupExpiredCredentials, checkOperations } from '../src/services/maintenanceTasks.js';
import { config } from '../src/config.js';
import { startBackgroundJobs, getBackgroundJobsStatus } from '../src/services/backgroundJobs.js';

const success = (): JobOutcome => ({ outcome: 'completed', ok: true, details: {} });
const settle = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

test('startup scans once, independent schedules repeat without overlap, and stop cancels future ticks', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const calls = [0, 0];
  const worker = createBackgroundScheduler([10, 25].map((intervalMs, i) => ({
    name: `job${i}`, intervalMs, run: async () => { calls[i]++; return success(); },
  })), () => {});
  worker.start(); await settle(); assert.deepEqual(calls, [1, 1]);
  assert.throws(() => worker.start(), /already started/);
  t.mock.timers.tick(9); await settle(); assert.deepEqual(calls, [1, 1]);
  t.mock.timers.tick(1); await settle(); assert.deepEqual(calls, [2, 1]);
  t.mock.timers.tick(15); await settle(); assert.deepEqual(calls, [3, 2]);
  await worker.stop(); t.mock.timers.tick(100); await settle();
  assert.deepEqual(calls, [3, 2]); assert.equal(worker.status().running, false);
});

test('a slow task never overlaps; shutdown aborts cooperatively and waits before closing resources', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let release!: () => void, observed!: AbortSignal;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, nextCalls = 0;
  const worker = createBackgroundScheduler([
    { name: 'slow', intervalMs: 10, run: async signal => { calls++; observed = signal; await hold; return success(); } },
    { name: 'later', intervalMs: 10, run: async () => { nextCalls++; return success(); } },
  ], () => {});
  worker.start(); t.mock.timers.tick(100_000); await settle(); assert.equal(calls, 1);
  let stopped = false;
  const pending = worker.stop().then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false); assert.equal(observed.aborted, true);
  release(); await pending;
  assert.equal(nextCalls, 0); assert.equal(worker.status().jobs[0].lastOutcome, 'cancelled');
  t.mock.timers.tick(100_000); await settle(); assert.equal(calls, 1);
});

test('failure does not stop other jobs, logs no thrown secrets, retries with delay, and recovers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let attempts = 0, other = 0;
  const reports: { event: Record<string, unknown>; failed: boolean }[] = [];
  const worker = createBackgroundScheduler([
    { name: 'retry', intervalMs: 300_000, run: async () => { if (++attempts === 1) throw new Error('secret SQL token'); return success(); } },
    { name: 'independent', intervalMs: 300_000, run: async () => { other++; return success(); } },
  ], (event, failed) => reports.push({ event, failed }));
  worker.start(); await settle();
  assert.equal(other, 1); assert.equal(worker.status().jobs[0].consecutiveFailures, 1);
  assert.ok(reports.some(entry => entry.failed)); assert.ok(!JSON.stringify(reports).includes('secret SQL'));
  t.mock.timers.tick(59_999); await settle(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(attempts, 2);
  assert.equal(worker.status().jobs[0].consecutiveFailures, 0);
  assert.equal(worker.status().jobs[0].lastSuccessAt, 61_000); await worker.stop();
});

test('a busy DB lock is skipped, never reported as successful, and retried after 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let attempts = 0;
  const worker = createBackgroundScheduler([{ name: 'busy', intervalMs: 900_000,
    run: async () => ++attempts === 1 ? { outcome: 'skipped' } : success(),
  }], () => {});
  worker.start(); await settle();
  assert.equal(worker.status().jobs[0].lastSuccessAt, null);
  assert.equal(worker.status().jobs[0].consecutiveFailures, 0);
  t.mock.timers.tick(29_999); await settle(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(attempts, 2); await worker.stop();
});

test('failed health results use error reports and never claim a successful scan', async () => {
  const errors: unknown[] = [];
  const worker = createBackgroundScheduler([{ name: 'health', intervalMs: 300_000, run: async () => ({
    outcome: 'completed', ok: false, details: { issues: ['Evidence deletion deadline exceeded'] },
  }) }], (event, failed) => { if (failed) errors.push(event); });
  worker.start(); await settle();
  assert.equal(worker.status().jobs[0].lastSuccessAt, null);
  assert.equal(worker.status().jobs[0].consecutiveFailures, 1);
  assert.equal(errors.length, 1); await worker.stop();
});

test('installer, unconfigured app and explicit disable never start jobs or connect to the DB', async t => {
  t.mock.method(console, 'log', () => {});
  const old = { configured: config.configured, installEnabled: config.installEnabled, backgroundJobsEnabled: config.backgroundJobsEnabled };
  try {
    for (const values of [
      { configured: false, installEnabled: false, backgroundJobsEnabled: true },
      { configured: true, installEnabled: true, backgroundJobsEnabled: true },
      { configured: true, installEnabled: false, backgroundJobsEnabled: false },
    ]) {
      Object.assign(config, values); const stop = startBackgroundJobs();
      assert.equal(getBackgroundJobsStatus().running, false); await stop();
    }
  } finally { Object.assign(config, old); }
});

test('credential cleanup bounds batches, filters expiry and never deletes audit/evidence/user records', async () => {
  const calls: string[] = [];
  const connection = { execute: async (sql: string) => {
    calls.push(sql); return [{ affectedRows: sql.includes('factor_challenges') ? 1000 : 0 }, []];
  } } as unknown as PoolConnection;
  const removed = await cleanupExpiredCredentials(connection);
  assert.equal(removed.factor_challenges, 100_000); assert.equal(calls.length, 107);
  assert.ok(calls.every(sql => /^DELETE FROM (factor_challenges|sessions|oauth_flows|otp_challenges|mfa_enrollments|authorization_codes|access_tokens|rate_limits) WHERE (expires_at|reset_at)<UTC_TIMESTAMP\(3\) LIMIT 1000$/.test(sql)));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(cleanupExpiredCredentials(connection, abort.signal)); assert.equal(calls.length, 107);
});

test('operations diagnostics redact raw grants and retain alerts for broad privileges, backlog and overdue evidence', async () => {
  const connection = { execute: async (sql: string) => {
    if (sql.includes('AS pending')) return [[{ pending: 10000, oldestAgeSeconds: 61 }], []];
    if (sql.includes('CURRENT_ROLE()')) return [[{ zone: '+00:00', role: null }], []];
    if (sql.startsWith('SHOW GRANTS')) return [[{ grants: `GRANT ALL PRIVILEGES ON \`${config.dbName}\`.* TO 'runtime'@'localhost' IDENTIFIED BY PASSWORD 'SENSITIVE-HASH'` }], []];
    if (sql.includes('COUNT(*) AS total')) return [[{ total: 1 }], []];
    return [[], []];
  } } as unknown as PoolConnection;
  const result = await checkOperations(connection);
  assert.equal(result.ok, false); assert.equal(result.issues.length, 3);
  assert.ok(!JSON.stringify(result).includes('SENSITIVE-HASH'));
});
