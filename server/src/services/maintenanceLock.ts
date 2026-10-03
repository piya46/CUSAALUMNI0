import { createHash } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { pool, query } from '../db.js';
import { config } from '../config.js';

export type MaintenanceTask = 'evidence_purge' | 'operations_check' | 'expired_credentials';
export const maintenanceLockName = (task: MaintenanceTask) =>
  `cusa-job:${createHash('sha256').update(`${config.dbName}\0${task}`).digest('hex').slice(0, 40)}`;

export async function withMaintenanceLock<T>(task: MaintenanceTask, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection();
  let locked = false, reusable = false;
  const name = maintenanceLockName(task);
  try {
    const [result] = await query<{ acquired: number | null }>('SELECT GET_LOCK(?, 0) AS acquired', [name], connection);
    if (result?.acquired === 0) { reusable = true; return { acquired: false as const }; }
    if (result?.acquired !== 1) throw new Error('Maintenance lock unavailable');
    locked = true;
    return { acquired: true as const, value: await work(connection) };
  } finally {
    try {
      if (locked) {
        const [result] = await query<{ released: number | null }>('SELECT RELEASE_LOCK(?) AS released', [name], connection);
        if (result?.released !== 1) throw new Error('Maintenance lock lost');
        reusable = true;
      }
    } finally {
      // Do not reuse a session with unknown advisory-lock state.
      if (reusable) connection.release(); else connection.destroy();
    }
  }
}
