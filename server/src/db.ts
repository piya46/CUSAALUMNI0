import { readFileSync } from 'node:fs';
import mysql, { type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbName,
  user: config.dbUser,
  password: config.dbPassword,
  ...(config.dbTls ? { ssl: {
    rejectUnauthorized: true,
    verifyIdentity: true,
    ...(config.dbCaFile ? { ca: readFileSync(config.dbCaFile, 'utf8') } : {}),
    minVersion: 'TLSv1.2' as const,
  } } : {}),
  timezone: '+00:00',
  charset: 'utf8mb4_unicode_ci',
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectionLimit: config.dbConnectionLimit,
  waitForConnections: true,
  queueLimit: config.dbQueueLimit,
  maxIdle: config.dbConnectionLimit,
  idleTimeout: 60000,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  multipleStatements: false,
});

// This command is queued before the connection is handed to application queries.
pool.on('connection', connection => {
  connection.query("SET time_zone = '+00:00'");
});

export async function query<T>(sql: string, params: any[] = [], connection?: PoolConnection): Promise<T[]> {
  const [rows] = await (connection ?? pool).execute<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function execute(sql: string, params: any[] = [], connection?: PoolConnection): Promise<ResultSetHeader> {
  const [result] = await (connection ?? pool).execute<ResultSetHeader>(sql, params);
  return result;
}

export async function transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
