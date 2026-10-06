import { access, lstat, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { config as runtimeConfig } from '../config.js';
import { permitsUnencryptedDatabase } from './databaseTransport.js';
import { resolveEvidenceDirectory } from './evidenceDirectory.js';

type Settings = typeof runtimeConfig;
type Check = { code: string; status: 'pass' | 'fail' | 'warning'; message: string };

// Filesystem/configuration only: no database connections, outbound requests,
// migrations, key generation, chmod or storage writes.
export async function checkDeployment(config: Settings, root: string, nodeVersion = process.versions.node) {
  const checks: Check[] = [];
  const add = (code: string, ok: boolean, message: string) => checks.push({ code, status: ok ? 'pass' : 'fail', message });
  const warn = (code: string, message: string) => checks.push({ code, status: 'warning', message });
  const [major, minor] = nodeVersion.split('.').map(Number);
  add('NODE_VERSION', major > 22 || (major === 22 && minor >= 12), 'Node.js >= 22.12 is required.');
  add('NODE_ENV', config.nodeEnv === 'production', 'Use NODE_ENV=production on the deployment host.');
  add('APP_ORIGIN', config.secureCookies && config.appOrigin.startsWith('https://'), 'Production APP_ORIGIN must be a single HTTPS origin.');
  add('AUTH_CONFIGURATION', config.configured, 'Google, Gmail, database credentials and encryption keys must be configured.');
  add('INSTALL_DISABLED', !config.installEnabled && !config.installToken, 'For an existing installation, disable INSTALL_ENABLED and clear INSTALL_TOKEN.');
  add('DB_TRANSPORT', Boolean(config.dbSocketPath) || config.dbTls || permitsUnencryptedDatabase(config.dbHost), 'A public database endpoint requires verified TLS.');
  if (config.dbSocketPath) {
    const usable = await stat(config.dbSocketPath).then(async info => info.isSocket() && await access(config.dbSocketPath, constants.R_OK | constants.W_OK).then(() => true, () => false), () => false);
    add('DB_SOCKET_PATH', usable, 'The database Unix socket must exist and be accessible by the application user; TCP fallback is disabled.');
  }
  if (config.dbCaFile) {
    const readable = await access(config.dbCaFile, constants.R_OK).then(() => true, () => false);
    add('DB_CA_FILE', readable, 'The configured database CA file must be readable.');
  }
  if (config.redisUrl) {
    try {
      const redis = new URL(config.redisUrl);
      add('REDIS_URL', ['redis:', 'rediss:'].includes(redis.protocol), 'Use a Redis TCP URL, not an HTTPS REST endpoint.');
      if (redis.protocol === 'redis:') warn('REDIS_TRANSPORT', 'Unencrypted Redis TCP requires a verified private network.');
    } catch { add('REDIS_URL', false, 'REDIS_URL is not a valid Redis TCP URL.'); }
  }
  warn('PROXY_REVIEW', 'Verify TRUST_PROXY and forwarded-header sanitization against the actual hosting proxy chain.');
  if(config.lineMfaEnabled){
    warn('LINE_PROVIDER', 'Verify LINE Login callback and signed Messaging webhook on the same LINE Provider, OA friendship and message quota.');
    if(config.lineWebhookDestination)add('LINE_WEBHOOK_DESTINATION', /^U[0-9a-f]{32}$/.test(config.lineWebhookDestination), 'Pin the webhook destination to the Messaging API bot user ID.');
    else warn('LINE_WEBHOOK_DESTINATION', 'Set LINE_WEBHOOK_DESTINATION to pin the OA, especially when sharing a central webhook.');
    if(config.lineWebhookGatewayToken){
      add('LINE_WEBHOOK_GATEWAY', Boolean(config.lineWebhookDestination)&&/^[A-Za-z0-9_-]{43}$/.test(config.lineWebhookGatewayToken), 'Gateway authentication requires a pinned destination and a dedicated random 32-byte base64url token.');
      warn('LINE_WEBHOOK_FORWARDING', 'Central must forward unchanged raw bytes and the original LINE signature over HTTPS, add its own Authorization header, and reserve MFA replies for SSO.');
    }
  }
  if(config.firebasePhoneEnabled)warn('FIREBASE_PROVIDER', 'Verify Phone provider, authorized HTTPS domain, SMS region/quota policy and service-account permissions; remove test phone numbers from production.');
  if(config.firebasePhoneRequired)warn('PHONE_POLICY', 'Phone verification applies to new accounts; confirm the privacy basis and support path before enforcing.');

  for (const path of ['app.cjs', 'package-lock.json', 'server/dist/index.js', 'web/dist/index.html']) {
    const file = await stat(join(root, path)).catch(() => undefined);
    add(`FILE:${path}`, Boolean(file?.isFile()), `Required deployment file: ${path}`);
  }
  const publicFiles = await readdir(join(root, 'public')).catch(() => null);
  add('DOCUMENT_ROOT', Boolean(publicFiles && publicFiles.every(name => name === '.gitkeep')), 'Plesk Document Root must use the empty public directory.');
  const migrations: string[] = await readdir(join(root, 'server/migrations')).catch(() => []);
  add('MIGRATION_FILES', migrations.includes('004_security_hardening.sql') && migrations.includes('005_mfa_reset_evidence.sql') && migrations.includes('006_additional_factors.sql') && migrations.includes('007_waiting_room.sql') && migrations.includes('008_service_consent.sql') && migrations.includes('009_service_accounts.sql'), 'Include migrations through 009; this does not check the database migration state.');
  const envFile = await lstat(join(root, '.env')).catch(() => undefined);
  if (envFile && process.platform !== 'win32') add('ENV_FILE_MODE', envFile.isFile() && (envFile.mode & 0o077) === 0, 'The private .env file must not be group/world readable.');

  if (config.mfaEvidenceKey) {
    const key = Buffer.from(config.mfaEvidenceKey, 'base64');
    add('EVIDENCE_KEY', key.length === 32 && key.toString('base64') === config.mfaEvidenceKey, 'MFA_EVIDENCE_KEY must be a canonical base64-encoded 32-byte key.');
    add('EVIDENCE_KEY_SEPARATION', !key.equals(Buffer.from(config.encryptionKey, 'base64')), 'Evidence and TOTP encryption must use different keys.');
    key.fill(0);
    try {
      const folder = await resolveEvidenceDirectory(config.mfaEvidenceDir, root);
      const info = await stat(folder).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      add('EVIDENCE_PATH', true, 'Evidence path is outside the known public/build roots.');
      if (info) {
        const writable = await access(folder, constants.R_OK | constants.W_OK | constants.X_OK).then(() => true, () => false);
        add('EVIDENCE_ACCESS', info.isDirectory() && writable, 'The runtime user needs read/write/traverse access to the evidence directory.');
        if (process.platform !== 'win32') add('EVIDENCE_MODE', (info.mode & 0o077) === 0, 'Evidence directory must be private (0700).');
      } else warn('EVIDENCE_DIRECTORY_MISSING', 'Create a private persistent evidence directory as the runtime user before accepting documents.');
    } catch { add('EVIDENCE_PATH', false, 'Evidence path is unsafe or cannot be inspected; check symlinks and permissions.'); }
    warn('EVIDENCE_OPERATIONS', 'Verify purge scheduling, failure alerts and exclusion of evidence plus wrapped keys from backups/snapshots.');
  } else warn('EVIDENCE_DISABLED', 'MFA evidence uploads are disabled because MFA_EVIDENCE_KEY is empty.');
  return { ok: checks.every(check => check.status !== 'fail'), scope: 'offline configuration and files only', checks,
    remainingChecks: ['Database migrations and effective runtime grants (ops:check)', 'Host HTTPS/proxy and Google sign-in/Gmail delivery', 'Scheduled tasks, monitoring and backup exclusions'] };
}
