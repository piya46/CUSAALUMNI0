import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { execute, pool, query, transaction } from '../src/db.js';
import { createAuditModel } from '../src/models/auditModel.js';
import { archiveAudit, verifyArchive } from '../src/scripts/auditArchive.js';

test('MariaDB audit outbox commits valid batches and rolls back corrupted batches', {
  skip: process.env.RUN_DB_TESTS !== '1',
}, async () => {
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.dbHost), 'Integration tests require a loopback database');
  assert.match(config.dbName, /_test$/, 'Integration tests require a database ending in _test');
  const firstId = randomUUID();
  const badId = randomUUID();
  // Scope only the queue-selection query to this test's rows. Real SQL, locks,
  // transactions and insert/delete behavior remain unchanged for the fixture.
  const {drainAuditBatch}=createAuditModel({execute,transaction,query:async<T>(sql,params=[],connection)=>{
    if(sql.includes('SELECT id, payload FROM audit_outbox'))return query<T>(sql.replace('FROM audit_outbox','FROM audit_outbox WHERE id IN (?,?)'),[firstId,badId,...params],connection);
    return query<T>(sql,params,connection);
  }});
  const eventTime=new Date(Date.UTC(2001,0,1)+parseInt(firstId.slice(0,8),16));
  const directory = await mkdtemp(join(tmpdir(), 'cusa-audit-integration-'));
  const original = {
    id: firstId, actorId: null, actorEmail: 'integration@example.test', sessionId: null,
    event: 'test.audit.durable', status: 'success', target: null, ip: '127.0.0.1',
    userAgent: 'audit integration test', metadata: { isolated: true }, createdAt: eventTime.toISOString(),
  };
  try {
    await execute('INSERT INTO audit_outbox (id,payload,created_at) VALUES (?,?,?)',
      [firstId, JSON.stringify(original), new Date('2000-01-01T00:00:00.000Z')]);
    await execute('INSERT INTO audit_outbox (id,payload,created_at) VALUES (?,?,?)',
      [badId, JSON.stringify({ ...original, id: badId, status: 'invalid' }), new Date('2000-01-02T00:00:00.000Z')]);
    await assert.rejects(drainAuditBatch(), /AUDIT_PAYLOAD_INVALID/);
    const queueAfter = await query('SELECT id FROM audit_outbox WHERE id IN (?,?)', [firstId, badId]);
    const logsAfter = await query('SELECT id FROM audit_logs WHERE id IN (?,?)', [firstId, badId]);
    assert.equal(queueAfter.length, 2);
    assert.equal(logsAfter.length, 0);
    await execute('DELETE FROM audit_outbox WHERE id = ?', [badId]);
    assert.equal(await drainAuditBatch(), 1);
    const [stored] = await query<{ id: string; status: string; createdAt: Date }>(
      'SELECT id,status,created_at AS createdAt FROM audit_logs WHERE id = ?', [firstId]);
    assert.equal(stored.id, firstId);
    assert.equal(stored.status, 'success');
    assert.equal(stored.createdAt.toISOString(), original.createdAt);
    assert.equal((await query('SELECT id FROM audit_outbox WHERE id = ?', [firstId])).length, 0);
    const output = join(directory, 'audit.jsonl');
    const instant = Date.parse(original.createdAt);
    const manifest = await archiveAudit(new Date(instant - 1), new Date(instant + 1), output);
    assert.ok(manifest.rows >= 1);
    assert.deepEqual(await verifyArchive(output), manifest);
    assert.match(await readFile(output, 'utf8'), new RegExp(firstId));
    assert.equal((await query('SELECT id FROM audit_logs WHERE id = ?', [firstId])).length, 1,
      'Export must preserve source audit rows');
  } finally {
    // These deletes are restricted to the explicitly gated isolated test database and test UUIDs.
    await execute('DELETE FROM audit_outbox WHERE id IN (?,?)', [firstId, badId]);
    // Append-only audit evidence is retained, including test-generated records.
    await rm(directory, { recursive: true, force: true });
    await pool.end();
  }
});
