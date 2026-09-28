import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { createAuditModel, type AuditDatabase, type AuditPayload } from '../src/models/auditModel.js';
import { getAuditWorkerStatus, startAuditWorker } from '../src/services/auditWorker.js';
import { verifyArchive } from '../src/scripts/auditArchive.js';

function payload(): AuditPayload {
  return { id: randomUUID(), actorId: randomUUID(), actorEmail: 'person@example.com', sessionId: randomUUID(),
    event: 'auth.mfa.verified', status: 'success', target: null, ip: '127.0.0.1', userAgent: 'Test browser',
    metadata: { method: 'totp' }, createdAt: '2026-08-15T10:11:12.123Z' };
}

function storage(events: AuditPayload[]) {
  const state = {
    queue: events.map(data => ({ id: data.id, payload: JSON.stringify(data) })),
    logs: [] as any[][], failInsert: false, failDelete: false,
  };
  const connection = {} as PoolConnection;
  const db: AuditDatabase = {
    async transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
      const previous = { queue: [...state.queue], logs: [...state.logs] };
      try { return await fn(connection); }
      catch (error) { Object.assign(state, previous); throw error; }
    },
    async query<T>(sql: string, params: any[] = [], tx?: PoolConnection): Promise<T[]> {
      if (sql.includes('SELECT id, payload')) {
        assert.equal(tx, connection);
        assert.match(sql, /FOR UPDATE SKIP LOCKED/);
        return state.queue.slice(0, params[0]) as T[];
      }
      return [{ pending: String(state.queue.length), oldestAgeSeconds: state.queue.length ? '45' : null }] as T[];
    },
    async execute(sql: string, params: any[] = [], tx?: PoolConnection): Promise<ResultSetHeader> {
      assert.equal(tx, connection);
      if (sql.startsWith('INSERT INTO audit_logs')) {
        if (state.failInsert) throw new Error('insert failed');
        state.logs.push(params);
      } else if (sql.startsWith('DELETE FROM audit_outbox')) {
        if (state.failDelete) throw new Error('delete failed');
        state.queue = state.queue.filter(row => row.id !== params[0]);
      } else throw new Error('Unexpected mutation');
      return { affectedRows: 1 } as ResultSetHeader;
    },
  };
  return { state, model: createAuditModel(db) };
}

test('audit batch preserves original event identity/time and moves records atomically', async () => {
  const event = payload();
  const { state, model } = storage([event]);
  assert.deepEqual(await model.getAuditQueueHealth(), { pending: 1, oldestAgeSeconds: 45 });
  assert.equal(await model.drainAuditBatch(), 1);
  assert.equal(state.queue.length, 0);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0][0], event.id);
  assert.equal(state.logs[0][3], event.sessionId);
  assert.equal(state.logs[0][5], 'success');
  assert.equal(state.logs[0][10].toISOString(), event.createdAt);
  assert.equal(await model.drainAuditBatch(), 0);
  assert.deepEqual(await model.getAuditQueueHealth(), { pending: 0, oldestAgeSeconds: 0 });
});

test('insert/delete failures roll back the batch, retaining durable records for retry', async () => {
  for (const failure of ['failInsert', 'failDelete'] as const) {
    const { state, model } = storage([payload(), payload()]);
    state[failure] = true;
    await assert.rejects(model.drainAuditBatch(), /failed/);
    assert.equal(state.queue.length, 2);
    assert.equal(state.logs.length, 0);
    state[failure] = false;
    assert.equal(await model.drainAuditBatch(), 2);
    assert.equal(state.queue.length, 0);
    assert.equal(state.logs.length, 2);
  }
});

test('earlier queued events without metadata drain with an empty metadata object', async () => {
  const { state, model } = storage([payload()]);
  const earlier = JSON.parse(state.queue[0].payload);
  delete earlier.metadata;
  state.queue[0].payload = JSON.stringify(earlier);
  assert.equal(await model.drainAuditBatch(), 1);
  assert.equal(state.queue.length, 0);
  assert.deepEqual(JSON.parse(state.logs[0][9]), {});
});

test('corrupted/mismatched payload is retained and valid earlier records roll back too', async () => {
  const { state, model } = storage([payload(), payload()]);
  state.queue[1].payload = JSON.stringify({ ...payload(), id: state.queue[1].id, status: 'unknown' });
  await assert.rejects(model.drainAuditBatch(), /AUDIT_PAYLOAD_INVALID/);
  assert.equal(state.queue.length, 2);
  assert.equal(state.logs.length, 0);
  state.queue[1].payload = JSON.stringify(payload());
  await assert.rejects(model.drainAuditBatch(), /AUDIT_PAYLOAD_INVALID/);
  assert.equal(state.queue.length, 2);
});

test('worker shutdown awaits its current batch and prevents a subsequent batch', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const stop = startAuditWorker({ pollMs: 10, drain: async () => { calls += 1; await held; return 100; } });
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(calls, 1);
  assert.equal(getAuditWorkerStatus().running, false);
  assert.ok(getAuditWorkerStatus().lastSuccessAt);
});

test('worker faults after three consecutive failures, stops retrying and emits sanitized critical output', async context => {
  const messages: unknown[][] = [];
  let notifyCritical!: () => void;
  const critical = new Promise<void>(resolve => { notifyCritical = resolve; });
  context.mock.method(console, 'error', (...args: unknown[]) => {
    messages.push(args);
    if (String(args[0]).startsWith('CRITICAL:')) notifyCritical();
  });
  let calls = 0;
  const stop = startAuditWorker({ retryDelayMs: 1, drain: async () => {
    calls += 1;
    throw new Error('secret-payload-and-SQL-must-never-be-logged');
  } });
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([critical, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Worker did not fault within the test deadline')), 1000);
    })]);
    assert.equal(calls, 3);
    assert.deepEqual(getAuditWorkerStatus(), { running: false, faulted: true,
      consecutiveFailures: 3, lastSuccessAt: null });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 3, 'Faulted worker must not attempt a fourth batch');
    assert.equal(messages.filter(args => String(args[0]).startsWith('CRITICAL:')).length, 1);
    assert.ok(!JSON.stringify(messages).includes('secret-payload'));
  } finally {
    if (deadline) clearTimeout(deadline);
    await stop();
  }
});

test('archive verification checks exact bytes, count, time interval and keyset order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cusa-audit-test-'));
  const output = join(directory, 'audit.jsonl');
  const rows = [payload(), payload()].sort((a, b) => a.id.localeCompare(b.id));
  const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const manifest = {
    version: 1, format: 'cusa-audit-jsonl', file: 'audit.jsonl', fromInclusive: '2026-08-01T00:00:00.000Z',
    toExclusive: '2026-09-01T00:00:00.000Z', exportedAt: new Date().toISOString(), rows: 2, expectedRows: 2,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  try {
    await writeFile(output, content);
    await writeFile(`${output}.manifest.json`, JSON.stringify(manifest));
    assert.equal((await verifyArchive(output)).rows, 2);
    await writeFile(output, content.replace('Test browser', 'Tampered browser'));
    await assert.rejects(verifyArchive(output), /checksum/);
    await writeFile(output, content);
    await writeFile(`${output}.manifest.json`, JSON.stringify({ ...manifest, rows: 3, expectedRows: 3 }));
    await assert.rejects(verifyArchive(output), /row-count/);
    const reversed = [...rows].reverse().map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(output, reversed);
    await writeFile(`${output}.manifest.json`, JSON.stringify({ ...manifest,
      sha256: createHash('sha256').update(reversed).digest('hex') }));
    await assert.rejects(verifyArchive(output), /keyset ordering/);
    await writeFile(output, content);
    await writeFile(`${output}.manifest.json`, JSON.stringify({ ...manifest, toExclusive: '2026-08-02T00:00:00.000Z' }));
    await assert.rejects(verifyArchive(output), /invalid interval/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
