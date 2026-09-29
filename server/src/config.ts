import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { z } from 'zod';
import { permitsUnencryptedDatabase } from './services/databaseTransport.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true } as dotenv.DotenvConfigOptions);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  DB_HOST: z.string().default('203.170.190.137'), DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().default('cusa_identity'), DB_USER: z.string().default(''), DB_PASSWORD: z.string().default(''),
  DB_TLS: z.enum(['true', 'false']).default('true'), DB_CA_FILE: z.string().default(''),
  DB_CONNECTION_LIMIT:z.coerce.number().int().min(1).max(100).default(20),
  DB_QUEUE_LIMIT:z.coerce.number().int().min(1).max(1000).default(100),
  INTROSPECTION_CACHE_SECONDS:z.coerce.number().int().min(0).max(5).default(5),
  MFA_EVIDENCE_KEY:z.string().default(''),
  MFA_EVIDENCE_DIR:z.string().default(fileURLToPath(new URL('../../var/mfa-evidence',import.meta.url))),
  SESSION_SECRET: z.string().default(''), ENCRYPTION_KEY: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''), GOOGLE_CLIENT_SECRET: z.string().default(''),
  MAIL_MODE: z.enum(['gmail_oauth', 'workspace_service_account', 'disabled']).default('disabled'),
  GMAIL_SENDER: z.string().default(''), GMAIL_REFRESH_TOKEN: z.string().default(''),
  GMAIL_CLIENT_ID: z.string().default(''), GMAIL_CLIENT_SECRET: z.string().default(''),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().default(''), GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().default(''),
  SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  OTP_MINUTES: z.coerce.number().int().min(1).max(10).default(5),
  TRUST_PROXY: z.string().default('false').refine(value => ['false','loopback','1'].includes(value) || value.split(',').every(part=>{
    const [ip,bits,...extra]=part.trim().split('/'); const family=isIP(ip);
    return !extra.length && family>0 && (bits===undefined || (/^\d{1,3}$/.test(bits) && Number(bits)>0 && Number(bits)<=(family===4?32:128)));
  })),
  REDIS_URL: z.string().default(''),
  INSTALL_ENABLED: z.enum(['true', 'false']).default('false'),
  INSTALL_TOKEN: z.string().default(''),
  BOOTSTRAP_ADMIN_EMAIL: z.string().trim().toLowerCase().default(''),
});
const env = schema.parse(process.env);
const origin = new URL(env.APP_ORIGIN);
if (origin.origin !== env.APP_ORIGIN || origin.hostname.includes(',') || !['http:', 'https:'].includes(origin.protocol)) throw new Error('APP_ORIGIN must be one HTTP(S) origin without a trailing slash or path; do not combine multiple URLs');
const mailConfigured = env.MAIL_MODE !== 'disabled' && z.email().safeParse(env.GMAIL_SENDER).success && (env.MAIL_MODE === 'gmail_oauth' ? Boolean(env.GMAIL_REFRESH_TOKEN && (env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID) && (env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET)) : Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY));
if (env.MAIL_MODE === 'workspace_service_account' && /@(gmail|googlemail)\.com$/i.test(env.GMAIL_SENDER)) throw new Error('Personal Gmail requires MAIL_MODE=gmail_oauth; service account delegation requires Google Workspace');
const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const configured = Boolean(googleConfigured && mailConfigured && env.DB_USER && env.DB_PASSWORD && env.SESSION_SECRET.length >= 32 && Buffer.from(env.ENCRYPTION_KEY, 'base64').length === 32);
if (env.INSTALL_ENABLED === 'true' && (!/^[A-Za-z0-9_-]{43}$/.test(env.INSTALL_TOKEN) || !z.email().safeParse(env.BOOTSTRAP_ADMIN_EMAIL).success)) {
  throw new Error('Installation requires a random 32-byte base64url INSTALL_TOKEN and valid BOOTSTRAP_ADMIN_EMAIL');
}
export function assertServerConfiguration() {
  if (env.NODE_ENV !== 'production') return;
  if (!configured || origin.protocol !== 'https:') throw new Error('Production requires complete credentials, HTTPS APP_ORIGIN, 32-byte ENCRYPTION_KEY, and SESSION_SECRET >=32 characters');
  if (env.DB_TLS !== 'true' && !permitsUnencryptedDatabase(env.DB_HOST)) throw new Error('Production DB_TLS=false requires localhost, a loopback IP, or a private IP on a trusted internal network; use verified TLS for public database endpoints');
}
export const config = {
  mfaEvidenceKey:env.MFA_EVIDENCE_KEY,mfaEvidenceDir:resolve(fileURLToPath(new URL('../../',import.meta.url)),env.MFA_EVIDENCE_DIR),
  nodeEnv: env.NODE_ENV, port: env.PORT, appOrigin: env.APP_ORIGIN,
  dbHost: env.DB_HOST, dbPort: env.DB_PORT, dbName: env.DB_NAME, dbUser: env.DB_USER, dbPassword: env.DB_PASSWORD, dbTls: env.DB_TLS === 'true', dbCaFile: env.DB_CA_FILE,
  sessionSecret: env.SESSION_SECRET, encryptionKey: env.ENCRYPTION_KEY,
  googleClientId: env.GOOGLE_CLIENT_ID, googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  mailMode: env.MAIL_MODE, gmailSender: env.GMAIL_SENDER, gmailRefreshToken: env.GMAIL_REFRESH_TOKEN,
  gmailClientId: env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID, gmailClientSecret: env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET,
  googleServiceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, googleServiceAccountPrivateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
  sessionHours: env.SESSION_HOURS, otpMinutes: env.OTP_MINUTES, configured, googleConfigured, mailConfigured,
  trustProxy: env.TRUST_PROXY === '1' ? 1 : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY.split(',').map(s=>s.trim()),
  secureCookies: origin.protocol === 'https:',
  redisUrl: env.REDIS_URL,
  installEnabled: env.INSTALL_ENABLED === 'true', installToken: env.INSTALL_TOKEN, bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
  dbConnectionLimit:env.DB_CONNECTION_LIMIT,dbQueueLimit:env.DB_QUEUE_LIMIT,introspectionCacheSeconds:env.INTROSPECTION_CACHE_SECONDS,
};
