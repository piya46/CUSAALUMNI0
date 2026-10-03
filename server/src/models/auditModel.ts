import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import { execute, pool, query, transaction } from '../db.js';

const auditPayload = z.object({
  requestId:z.uuid().nullable().optional(), peerIp:z.string().max(64).nullable().optional(), ipSource:z.string().max(32).optional(), actorType:z.string().max(16).optional(), applicationId:z.uuid().nullable().optional(), apiKeyId:z.uuid().nullable().optional(),
  id: z.uuid(), actorId: z.uuid().nullable(), actorEmail: z.string().max(254).nullable(),
  sessionId: z.uuid().nullable(), event: z.string().min(1).max(100), status: z.enum(['success', 'failure']),
  target: z.string().max(255).nullable(), ip: z.string().max(64).nullable(),
  userAgent: z.string().max(512).nullable(), metadata: z.unknown().default({}), createdAt: z.iso.datetime(),
});
export type AuditPayload = z.infer<typeof auditPayload>;
export interface AuditDatabase {
  query<T>(sql: string, params?: any[], connection?: PoolConnection): Promise<T[]>;
  execute(sql: string, params?: any[], connection?: PoolConnection): Promise<ResultSetHeader>;
  transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T>;
}
interface OutboxRow { id: string; payload: string | AuditPayload }
export interface AuditQueueHealth { pending: number; oldestAgeSeconds: number }

export function createAuditModel(db: AuditDatabase = { query, execute, transaction }) {
  return {
    async drainAuditBatch(batchSize = 100): Promise<number> {
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Invalid audit batch size');
      return db.transaction(async connection => {
        const rows = await db.query<OutboxRow>(`
          SELECT id, payload FROM audit_outbox ORDER BY created_at, id LIMIT ?
          FOR UPDATE SKIP LOCKED`, [batchSize], connection);
        for (const row of rows) {
          const parsed = auditPayload.safeParse(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);
          if (!parsed.success || parsed.data.id !== row.id) throw new Error('AUDIT_PAYLOAD_INVALID');
          const data = parsed.data;
          await db.execute(`INSERT INTO audit_logs
            (id, actor_id, actor_email, session_id, event, status, target, ip, user_agent, metadata, created_at, request_id, peer_ip, ip_source, actor_type, application_id, api_key_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [data.id, data.actorId, data.actorEmail, data.sessionId, data.event, data.status, data.target,
            data.ip, data.userAgent, JSON.stringify(data.metadata ?? {}), new Date(data.createdAt),data.requestId??null,data.peerIp??null,data.ipSource??null,data.actorType??(data.actorId?'user':'system'),data.applicationId??null,data.apiKeyId??null], connection);
          const removed = await db.execute('DELETE FROM audit_outbox WHERE id = ?', [row.id], connection);
          if (removed.affectedRows !== 1) throw new Error('AUDIT_OUTBOX_CONFLICT');
        }
        return rows.length;
      });
    },

    async getAuditQueueHealth(connection?: PoolConnection): Promise<AuditQueueHealth> {
      const [row] = await db.query<{ pending: string | number; oldestAgeSeconds: string | number | null }>(`
        SELECT COUNT(*) AS pending,
               GREATEST(0, TIMESTAMPDIFF(SECOND, MIN(created_at), UTC_TIMESTAMP(3))) AS oldestAgeSeconds
          FROM audit_outbox`, [], connection);
      return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Number(row?.oldestAgeSeconds ?? 0) };
    },
  };
}

const auditModel = createAuditModel();
export const drainAuditBatch = auditModel.drainAuditBatch;
export const getAuditQueueHealth = auditModel.getAuditQueueHealth;

export interface ArchivedAuditRow {
  id: string; actorId: string | null; actorEmail: string | null; sessionId: string | null;
  event: string; status: 'success' | 'failure'; target: string | null; ip: string | null;
  userAgent: string | null; metadata: unknown; createdAt: Date;
}

/** Read-only, consistent snapshot with bounded keyset pages. No log/outbox mutation. */
export async function exportAuditSnapshot(from: Date, to: Date, consume: (rows: ArchivedAuditRow[]) => Promise<void>) {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('Invalid archive interval');
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [pending] = await query<{ total: string | number }>(`
      SELECT COUNT(*) AS total FROM audit_outbox
       WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.createdAt')) >= ?
         AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.createdAt')) < ?`, [from.toISOString(), to.toISOString()], connection);
    if (Number(pending.total)) throw new Error('Audit outbox still contains events in the requested interval; drain it before archiving');
    const [count] = await query<{ total: string | number }>(
      'SELECT COUNT(*) AS total FROM audit_logs WHERE created_at >= ? AND created_at < ?', [from, to], connection);
    const expected = Number(count.total);
    let cursor: { createdAt: Date; id: string } | undefined;
    let exported = 0;
    while (true) {
      const cursorClause = cursor ? 'AND (created_at > ? OR (created_at = ? AND id > ?))' : '';
      const rows = await query<ArchivedAuditRow>(`
        SELECT id, actor_id AS actorId, actor_email AS actorEmail, session_id AS sessionId,
               event, status, target, ip, user_agent AS userAgent, metadata, request_id AS requestId, peer_ip AS peerIp, ip_source AS ipSource, actor_type AS actorType, application_id AS applicationId, api_key_id AS apiKeyId, created_at AS createdAt
          FROM audit_logs WHERE created_at >= ? AND created_at < ? ${cursorClause}
         ORDER BY created_at, id LIMIT 1000`,
      [from, to, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [])], connection);
      if (!rows.length) break;
      for (const row of rows) {
        if (typeof row.metadata === 'string') row.metadata = JSON.parse(row.metadata);
      }
      await consume(rows);
      exported += rows.length;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    if (exported !== expected) throw new Error('Archive row count does not match its database snapshot');
    await connection.commit();
    return { rows: exported, expectedRows: expected };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
