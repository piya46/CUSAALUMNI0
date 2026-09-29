import { config } from '../config.js';
import { pool, query } from '../db.js';
import { bootstrapAdmin } from '../models/adminModel.js';
import { installationState, completeInstallation } from '../models/installationModel.js';
import { applyMigrations, withMigrationLock } from './migrations.js';
import { checkRateLimitStore } from './rateLimitStore.js';
import type { PoolConnection } from 'mysql2/promise';

export class InstallationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
async function verifyEnvironment(connection: PoolConnection) {
  if (!config.configured) throw new InstallationError(503, 'SETUP_REQUIRED', 'กรอก DB, Google, Gmail และ encryption keys ใน .env ให้ครบ แล้ว Restart App');
  const state = await installationState(connection);
  if (state !== 'empty') throw new InstallationError(409, 'INSTALL_LOCKED', 'ฐานข้อมูลนี้ติดตั้งแล้วหรือมีข้อมูลอยู่ จึงปิดการติดตั้งซ้ำ');
  const [server] = await query<{ version: string; zone: string }>('SELECT VERSION() AS version, @@session.time_zone AS zone', [], connection);
  const match = server?.version.match(/^(\d+)\.(\d+).*MariaDB/i);
  if (!match || +match[1] < 10 || (+match[1] === 10 && +match[2] < 6) || server.zone !== '+00:00') {
    throw new InstallationError(503, 'DATABASE_UNSUPPORTED', 'ต้องใช้ MariaDB 10.6 ขึ้นไป และ connection timezone เป็น UTC');
  }
  await checkRateLimitStore();
  return { database: config.dbName, host: config.dbHost, adminEmail: config.bootstrapAdminEmail, databaseVersion: server.version };
}

export const installationService = {
  async check() {
    const connection = await pool.getConnection();
    try { return await verifyEnvironment(connection); }
    finally { connection.release(); }
  },
  async run() {
    return withMigrationLock(async connection => {
      const details = await verifyEnvironment(connection);
      // DDL is restartable, not transactional. The admin, audit event, and final lock ARE atomic.
      const migrations = await applyMigrations(connection);
      await connection.beginTransaction();
      try {
        await bootstrapAdmin(config.bootstrapAdminEmail, connection, 'web_install');
        await completeInstallation(connection);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      return { ...details, migrations, restartRequired: true as const };
    }, 0);
  },
};
export type InstallationService = typeof installationService;
