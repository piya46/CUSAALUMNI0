import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { execute, pool, query } from '../src/db.js';
import * as admin from '../src/models/adminModel.js';
import { HttpError } from '../src/middleware/security.js';
import { hashToken, randomToken, seal } from '../src/services/crypto.js';

const enabled = process.env.RUN_DB_TESTS === '1';
if (enabled && !['127.0.0.1', 'localhost'].includes(config.dbHost)) {
  throw new Error('Admin integration tests may only run against local MariaDB.');
}
const run = randomUUID();
const ownedUsers = new Set<string>();
const ownedEmails = new Set<string>();
const ownedApps = new Set<string>();
let actor: { userId: string; email: string; allowedId: string };

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
const audit: admin.AuditWriter = async (connection, event, target, metadata) => {
  // Preserve append-only audit rows after cleanup; all snapshots identify this isolated run.
  await execute(`INSERT INTO audit_logs
    (id, actor_id, actor_email, event, target, ip, user_agent, metadata)
    VALUES (?, ?, ?, ?, ?, '127.0.0.1', 'admin-integration-test', ?)`,
  [randomUUID(), actor.userId, actor.email, event, target ?? null, JSON.stringify({ ...metadata, integrationRun: run })], connection);
};

async function seedUser(label: string, role: 'admin' | 'user' = 'user') {
  const userId = randomUUID();
  const allowedId = randomUUID();
  const email = `${label}-${run}@example.test`;
  ownedUsers.add(userId);
  ownedEmails.add(email);
  await execute('INSERT INTO allowed_emails (id, email, role) VALUES (?, ?, ?)', [allowedId, email, role]);
  await execute('INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)', [userId, `integration:${userId}`, email, `${label} ${run}`]);
  return { userId, allowedId, email };
}

async function createApplication(label: string) {
  const app = await admin.addApplication(actor, { name: `${label} ${run}`, description: `Fixture ${run}`, redirectUri: 'https://integration.example.test/callback' }, audit);
  ownedApps.add(app.id);
  return app;
}

async function seedCredentials(userId: string, applicationId: string) {
  const sessionId = randomUUID();
  const accessHash = hashToken(randomToken());
  const codeHash = hashToken(randomToken());
  await execute(`INSERT INTO sessions (id, token_hash, user_id, kind, csrf_token, mfa_method, authenticated_at, expires_at)
    VALUES (?, ?, ?, 'full', ?, 'email', UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`,
  [sessionId, hashToken(randomToken()), userId, randomToken()]);
  await execute(`INSERT INTO access_tokens (token_hash, application_id, user_id, session_id, scope, expires_at)
    VALUES (?, ?, ?, ?, 'identity:read', DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
  [accessHash, applicationId, userId, sessionId]);
  await execute(`INSERT INTO authorization_codes
    (code_hash, application_id, user_id, session_id, redirect_uri, code_challenge, expires_at)
    VALUES (?, ?, ?, ?, 'https://integration.example.test/callback', ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE))`,
  [codeHash, applicationId, userId, sessionId, 'x'.repeat(43)]);
  return { sessionId, accessHash, codeHash };
}

after(async () => {
  try {
    if (enabled) {
      // Delete only UUIDs/emails created by this file. Cascades remove their credentials.
      for (const id of ownedApps) await execute('DELETE FROM applications WHERE id = ?', [id]);
      for (const id of ownedUsers) await execute('DELETE FROM users WHERE id = ?', [id]);
      for (const email of ownedEmails) await execute('DELETE FROM allowed_emails WHERE email = ?', [email]);
    }
  } finally { await pool.end(); }
});

describe('admin MariaDB integration', { skip: !enabled, concurrency: false }, () => {
  before(async () => { actor = await seedUser('admin', 'admin'); });

  test('duplicate email is friendly and list pagination/search are accurate', async () => {
    const search = `page-${run}`;
    for (let index = 1; index <= 3; index++) {
      const email = `${search}-${index}@example.test`;
      ownedEmails.add(email);
      await admin.addAllowedEmail(actor, { email, role: 'user' }, audit);
    }
    await assert.rejects(admin.addAllowedEmail(actor, { email: `${search}-1@example.test`, role: 'admin' }, audit), hasCode('EMAIL_EXISTS'));
    const first = await admin.listAllowedEmails({ page: 1, limit: 2, search });
    const second = await admin.listAllowedEmails({ page: 2, limit: 2, search });
    assert.deepEqual(first.meta, { total: 3, totalPages: 2, currentPage: 1, limit: 2 });
    assert.equal(first.emails.length, 2);
    assert.equal(second.emails.length, 1);
    assert.equal(new Set([...first.emails, ...second.emails].map(item => item.id)).size, 3);
    const wildcardEmail = `literal%_${run}@example.test`;
    ownedEmails.add(wildcardEmail);
    await admin.addAllowedEmail(actor, { email: wildcardEmail, role: 'user' }, audit);
    const escaped = await admin.listAllowedEmails({ page: 1, limit: 20, search: `literal%_${run}` });
    assert.equal(escaped.meta.total, 1);
    assert.equal(escaped.emails[0].email, wildcardEmail);
  });

  test('soft deletion revokes credentials, hides the account, and explicit re-add restores it with audit', async () => {
    const user = await seedUser('soft-delete');
    const secret = seal('TEST-TOTP-SECRET');
    await execute('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, user.userId]);
    const app = await createApplication('Soft-delete portal');
    const credentials = await seedCredentials(user.userId, app.id);
    await admin.removeUser(actor, user.userId, audit);
    const [deleted] = await query<{ deleted_at: Date | null; totp_secret: string }>('SELECT deleted_at, totp_secret FROM users WHERE id = ?', [user.userId]);
    assert.ok(deleted.deleted_at instanceof Date);
    assert.equal(deleted.totp_secret, secret);
    assert.equal((await query('SELECT id FROM allowed_emails WHERE email = ?', [user.email])).length, 0);
    assert.equal((await query('SELECT id FROM sessions WHERE id = ?', [credentials.sessionId])).length, 0);
    assert.equal((await query('SELECT token_hash FROM access_tokens WHERE token_hash = ?', [credentials.accessHash])).length, 0);
    assert.equal((await query('SELECT code_hash FROM authorization_codes WHERE code_hash = ?', [credentials.codeHash])).length, 0);
    assert.equal((await admin.listUsers({ page: 1, limit: 20, search: user.email })).meta.total, 0);
    await admin.addAllowedEmail(actor, { email: user.email, role: 'user' }, audit);
    const restored = await admin.listUsers({ page: 1, limit: 20, search: user.email });
    assert.equal(restored.users[0].id, user.userId);
    assert.equal(restored.users[0].totpEnabled, true);
    const events = await admin.listAudit({ page: 1, limit: 100, search: user.email, email: actor.email, event: 'allowlist.created' });
    assert.ok(events.events.some(event => event.metadata?.restoredUser === true));
  });

  test('allowlist removal immediately revokes existing sessions without deleting account history', async () => {
    const user = await seedUser('allowlist-revoke');
    const app = await createApplication('Allowlist portal');
    const credentials = await seedCredentials(user.userId, app.id);
    await admin.removeAllowedEmail(actor, user.allowedId, audit);
    assert.equal((await query('SELECT id FROM sessions WHERE id = ?', [credentials.sessionId])).length, 0);
    assert.equal((await query('SELECT id FROM users WHERE id = ?', [user.userId])).length, 1);
    assert.equal((await admin.listUsers({ page: 1, limit: 20, search: user.email })).users.length, 0);
  });

  test('API key raw value is revealed once, stored hashed, scoped and revocable', async () => {
    const app = await createApplication('Key portal');
    const created = await admin.addApiKey(actor, { applicationId: app.id, name: `key ${run}`, scopes: ['identity:read'], expiresInDays: 30 }, audit);
    assert.match(created.key, /^cusa_[A-Za-z0-9_-]{43}$/);
    const [stored] = await query<Record<string, unknown>>('SELECT * FROM api_keys WHERE id = ?', [created.apiKey.id]);
    assert.equal(stored.key_hash, hashToken(created.key));
    assert.ok(!Object.values(stored).includes(created.key));
    assert.equal(stored.application_id, app.id);
    assert.ok(stored.expires_at instanceof Date);
    assert.ok(Math.abs(stored.expires_at.getTime() - Date.now() - 30 * 86_400_000) < 10_000);
    const listed = await admin.listApiKeys({ page: 1, limit: 20, search: `key ${run}` });
    const dto = listed.apiKeys.find(item => item.id === created.apiKey.id)!;
    assert.deepEqual(dto.scopes, ['identity:read']);
    assert.equal('key_hash' in dto, false);
    assert.equal('key' in dto, false);
    await admin.revokeApiKey(actor, created.apiKey.id, audit);
    await admin.revokeApiKey(actor, created.apiKey.id, audit);
    const [revoked] = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM api_keys WHERE id = ?', [created.apiKey.id]);
    assert.ok(revoked.revoked_at instanceof Date);
  });

  test('application revocation invalidates its keys, authorization codes and access tokens', async () => {
    const app = await createApplication('Revocation portal');
    const key = await admin.addApiKey(actor, { applicationId: app.id, name: 'Revoke with app', scopes: ['identity:read', 'token:introspect'], expiresInDays: 30 }, audit);
    const credentials = await seedCredentials(actor.userId, app.id);
    await admin.revokeApplication(actor, app.id, audit);
    const [storedApp] = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM applications WHERE id = ?', [app.id]);
    const [storedKey] = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM api_keys WHERE id = ?', [key.apiKey.id]);
    const [storedToken] = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM access_tokens WHERE token_hash = ?', [credentials.accessHash]);
    assert.ok(storedApp.revoked_at instanceof Date);
    assert.ok(storedKey.revoked_at instanceof Date);
    assert.ok(storedToken.revoked_at instanceof Date);
    assert.equal((await query('SELECT code_hash FROM authorization_codes WHERE code_hash = ?', [credentials.codeHash])).length, 0);
    await assert.rejects(admin.addApiKey(actor, { applicationId: app.id, name: 'Must reject', scopes: ['identity:read'], expiresInDays: 30 }, audit), hasCode('APPLICATION_UNAVAILABLE'));
    const applications = await admin.listApplications({ page: 1, limit: 20, search: `Revocation portal ${run}` });
    assert.equal(applications.meta.total, 1);
    assert.ok(applications.applications[0].revokedAt instanceof Date);
  });

  test('audit filters combine exact event/email/status with date range and parse JSON metadata', async () => {
    const event = `integration.filter.${run}`;
    const fixtures = [
      { status: 'failure', createdAt: new Date('2026-01-02T10:00:00Z') },
      { status: 'success', createdAt: new Date('2026-01-02T11:00:00Z') },
      { status: 'failure', createdAt: new Date('2026-01-03T10:00:00Z') },
    ];
    for (const item of fixtures) await execute(`INSERT INTO audit_logs
      (id, actor_email, event, status, session_id, user_agent, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, 'admin-integration-test', ?, ?)`,
    [randomUUID(), actor.email, event, item.status, actor.userId, JSON.stringify({ integrationRun: run }), item.createdAt]);
    const filtered = await admin.listAudit({ page: 1, limit: 1, search: run, event, email: actor.email, status: 'failure',
      startAt: new Date('2026-01-02T00:00:00Z'), endBefore: new Date('2026-01-03T00:00:00Z') });
    assert.equal(filtered.meta.hasMore,false);assert.equal(filtered.meta.nextCursor,null);assert.equal(filtered.meta.limit,1);
    assert.equal(filtered.events[0].status, 'failure');
    assert.equal(filtered.events[0].sessionId, actor.userId);
    assert.equal(filtered.events[0].userAgent, 'admin-integration-test');
    assert.deepEqual(filtered.events[0].metadata, { integrationRun: run });
  });

  test('self-removal and concurrent administrator cross-removal cannot eliminate all acting administrators', async () => {
    await assert.rejects(admin.removeUser(actor, actor.userId, audit), hasCode('SELF_REMOVAL'));
    await assert.rejects(admin.removeAllowedEmail(actor, actor.allowedId, audit), hasCode('SELF_REMOVAL'));
    const first = await seedUser('race-admin-a', 'admin');
    const second = await seedUser('race-admin-b', 'admin');
    const outcomes = await Promise.allSettled([
      admin.removeAllowedEmail(first, second.allowedId, audit),
      admin.removeAllowedEmail(second, first.allowedId, audit),
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
    assert.ok(hasCode('ADMIN_REVOKED')(rejected.reason));
    const remaining = await query<{ id: string }>('SELECT id FROM allowed_emails WHERE id IN (?, ?)', [first.allowedId, second.allowedId]);
    assert.equal(remaining.length, 1);
    const survivor = remaining[0].id === first.allowedId ? first : second;
    const removed = remaining[0].id === first.allowedId ? second : first;
    await assert.rejects(admin.removeAllowedEmail(survivor, survivor.allowedId, audit), hasCode('SELF_REMOVAL'));
    await assert.rejects(admin.removeAllowedEmail(removed, survivor.allowedId, audit), hasCode('ADMIN_REVOKED'));
  });
});
