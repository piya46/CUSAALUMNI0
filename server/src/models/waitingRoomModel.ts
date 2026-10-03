import { z } from 'zod';
import { query, execute, transaction } from '../db.js';
import { HttpError } from '../middleware/security.js';
import { lockAdministrators, type Actor, type AuditWriter } from './adminModel.js';

export const queueSettingsSchema = z.object({
  enabled: z.boolean(), rate: z.number().int().min(1).max(100),
  capacity: z.number().int().min(100).max(20000), ipLimit: z.number().int().min(1).max(100),
}).strict();
export type QueueSettings = z.infer<typeof queueSettingsSchema>;
export interface QueueApplication extends QueueSettings { id: string; name: string; redirectUri: string }
const select = `SELECT id,name,redirect_uri AS redirectUri,queue_enabled AS enabled,
  queue_rate AS rate,queue_capacity AS capacity,queue_ip_limit AS ipLimit
  FROM applications WHERE id=? AND revoked_at IS NULL`;
const cache = new Map<string, { app: QueueApplication; until: number }>();
const pending = new Map<string, Promise<QueueApplication>>();

// Only display/polling uses this short cache. Authorization always reads live policy.
export async function queueApplication(id: string, cached = false): Promise<QueueApplication> {
  const hit = cached ? cache.get(id) : undefined;
  if (hit && hit.until > Date.now()) return hit.app;
  if (cached && pending.has(id)) return pending.get(id)!;
  const read = async () => {
    const [row] = await query<QueueApplication>(select, [id]);
    if (!row) throw new HttpError(400, 'ไม่พบ Service ที่เปิดใช้งาน', 'invalid_client');
    const app = { ...row, ...queueSettingsSchema.parse({ enabled: Boolean(row.enabled), rate: row.rate, capacity: row.capacity, ipLimit: row.ipLimit }) };
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(id, { app, until: Date.now() + 5000 });
    return app;
  };
  if (!cached) return read();
  const result = read().finally(() => pending.delete(id));
  pending.set(id, result); return result;
}
export async function updateQueueSettings(actor: Actor, id: string, settings: QueueSettings, record: AuditWriter) {
  await transaction(async connection => {
    await lockAdministrators(actor, connection);
    const [app] = await query(select + ' FOR UPDATE', [id], connection);
    if (!app) throw new HttpError(404, 'ไม่พบ Service', 'NOT_FOUND');
    await execute('UPDATE applications SET queue_enabled=?,queue_rate=?,queue_capacity=?,queue_ip_limit=? WHERE id=?',
      [settings.enabled, settings.rate, settings.capacity, settings.ipLimit, id], connection);
    await record(connection, 'application.queue.updated', id, settings);
  });
  cache.delete(id);
}
