import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { config } from '../src/config.js';
import { execute, pool, query } from '../src/db.js';
import { consentedCode } from './consent-fixture.js';
import { pkceChallenge, ssoModel } from '../src/models/ssoModel.js';
import { hashToken, randomToken } from '../src/services/crypto.js';

const enabled = process.env.RUN_DB_TESTS === '1';
if (enabled && !['127.0.0.1', 'localhost'].includes(config.dbHost)) {
  throw new Error('SSO expiry integration tests may only run against local MariaDB.');
}
const userId = randomUUID();
const allowedId = randomUUID();
const sessionId = randomUUID();
const applicationId = randomUUID();
const apiKeyId = randomUUID();
const email = `sso-expiry-${userId}@example.test`;
const apiKeyHash = hashToken(randomToken());
const tokenHash = hashToken(randomToken());

after(async () => {
  try {
    if (enabled) {
      await execute('DELETE FROM applications WHERE id = ?', [applicationId]);
      await execute('DELETE FROM users WHERE id = ?', [userId]);
      await execute('DELETE FROM allowed_emails WHERE id = ?', [allowedId]);
    }
  } finally { await pool.end(); }
});

test('MariaDB introspection exp is the earliest session, token or API key expiry', { skip: !enabled }, async () => {
  const base = Math.floor(Date.now() / 1000) + 60;
  const date = (seconds: number) => new Date(seconds * 1000 + 500);
  await execute("INSERT INTO allowed_emails (id, email, role) VALUES (?, ?, 'user')", [allowedId, email]);
  await execute('INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)', [userId, `expiry-test:${userId}`, email, 'SSO expiry integration']);
  await execute(`INSERT INTO sessions (id, token_hash, user_id, kind, csrf_token, mfa_method, authenticated_at, expires_at)
    VALUES (?, ?, ?, 'full', ?, 'email', UTC_TIMESTAMP(3), ?)`, [sessionId, hashToken(randomToken()), userId, randomToken(), date(base + 300)]);
  await execute('INSERT INTO applications (id, name, redirect_uri) VALUES (?, ?, ?)',
    [applicationId, `Expiry fixture ${applicationId}`, 'https://expiry.example.test/callback']);
  await execute('INSERT INTO application_access_policies(application_id) VALUES (?)',[applicationId]);
  await execute('INSERT INTO application_memberships (application_id,user_id) VALUES (?,?)', [applicationId,userId]);
  const roleId=randomUUID();
  await execute('INSERT INTO application_roles (id,application_id,code,name) VALUES (?,?,?,?)', [roleId,applicationId,'viewer','Viewer']);
  await execute('INSERT INTO application_member_roles (application_id,user_id,role_id) VALUES (?,?,?)', [applicationId,userId,roleId]);
  await execute('INSERT INTO api_keys (id, application_id, name, prefix, key_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [apiKeyId, applicationId, 'Expiry test key', 'cusa_test', apiKeyHash, JSON.stringify(['token:introspect']), date(base + 300)]);
  const verifier=randomToken();
  const code=await consentedCode(ssoModel,{userId,sessionId,applicationId,redirectUri:'https://expiry.example.test/callback',challenge:pkceChallenge(verifier)},'identity:read');
  const [{consentId}]=await query<{consentId:string}>('SELECT consent_id AS consentId FROM authorization_codes WHERE code_hash=?',[hashToken(code)]);
  await execute("INSERT INTO access_tokens (token_hash, application_id, user_id, session_id, scope, consent_id, expires_at) VALUES (?, ?, ?, ?, 'identity:read', ?, ?)",
    [tokenHash, applicationId, userId, sessionId, consentId, date(base + 300)]);

  for (const earliest of ['session', 'token', 'key']) {
    await execute('UPDATE sessions SET expires_at = ? WHERE id = ?', [date(base + (earliest === 'session' ? 1 : 300)), sessionId]);
    await execute('UPDATE access_tokens SET expires_at = ? WHERE token_hash = ?', [date(base + (earliest === 'token' ? 1 : 300)), tokenHash]);
    await execute('UPDATE api_keys SET expires_at = ? WHERE id = ?', [date(base + (earliest === 'key' ? 1 : 300)), apiKeyId]);
    const result = await ssoModel.introspectToken(apiKeyHash, tokenHash);
    assert.equal(result.active, true, earliest);
    if (result.active) assert.equal(result.exp, base + 1, earliest);
  }
});
