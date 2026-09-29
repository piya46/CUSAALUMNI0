import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { config } from '../src/config.js';
import { execute, pool, query } from '../src/db.js';
import { createSsoModel, pkceChallenge, SsoModelError } from '../src/models/ssoModel.js';
import { hashToken, randomToken } from '../src/services/crypto.js';

test('MariaDB SSO enforces PKCE, one-use codes, application binding and live revocation', {
  skip: process.env.RUN_DB_TESTS !== '1',
}, async context => {
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.dbHost), 'Integration tests require a loopback database');
  assert.match(config.dbName, /_test$/, 'Integration tests require a database ending in _test');
  const model = createSsoModel();
  const userId = randomUUID();
  const emailId = randomUUID();
  const email = `${randomUUID()}@example.test`;
  const sessionId = randomUUID();
  const pendingId = randomUUID();
  const applicationId = randomUUID();
  const otherApplicationId = randomUUID();
  const keyId = randomUUID();
  const otherKeyId = randomUUID();
  const apiKeyHash = hashToken(randomToken());
  const otherKeyHash = hashToken(randomToken());
  const redirectUri = `https://portal-${applicationId}.example.test/callback`;
  const verifier = randomToken();
  const challenge = pkceChallenge(verifier);
  const validUntil = new Date(Date.now() + 60 * 60 * 1000);
  const expiredAt = new Date(Date.now() - 60 * 1000);
  const request = { applicationId, sessionId, userId, redirectUri, challenge };
  const errorCode = (code: string) => (error: unknown) => error instanceof SsoModelError && error.code === code;
  let accessToken = '';

  try {
    await execute('INSERT INTO allowed_emails (id,email,role) VALUES (?, ?, ?)', [emailId, email, 'user']);
    await execute('INSERT INTO users (id,google_sub,email,name) VALUES (?, ?, ?, ?)',
      [userId, `integration-${userId}`, email, 'SSO integration fixture']);
    await execute(`INSERT INTO sessions (id,token_hash,user_id,kind,csrf_token,mfa_method,authenticated_at,expires_at)
      VALUES (?, ?, ?, 'full', ?, 'totp', UTC_TIMESTAMP(3), ?)`,
    [sessionId, hashToken(randomToken()), userId, randomToken(), validUntil]);
    await execute(`INSERT INTO sessions (id,token_hash,user_id,kind,csrf_token,expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`, [pendingId, hashToken(randomToken()), userId, randomToken(), validUntil]);
    for (const id of [applicationId, otherApplicationId]) {
      await execute('INSERT INTO applications (id,name,description,redirect_uri) VALUES (?, ?, ?, ?)',
        [id, 'Isolated SSO test', 'Created and deleted by gated local test', redirectUri]);
      await execute('INSERT INTO application_memberships (application_id,user_id) VALUES (?,?)', [id,userId]);
      const roleId = randomUUID();
      await execute('INSERT INTO application_roles (id,application_id,code,name) VALUES (?,?,?,?)', [roleId,id,'viewer','Viewer']);
      await execute('INSERT INTO application_member_roles (application_id,user_id,role_id) VALUES (?,?,?)', [id,userId,roleId]);
    }
    for (const [id, appId, keyHash] of [[keyId, applicationId, apiKeyHash], [otherKeyId, otherApplicationId, otherKeyHash]]) {
      await execute(`INSERT INTO api_keys (id,application_id,name,prefix,key_hash,scopes,expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, appId, 'Integration-only key', 'test_only', keyHash, JSON.stringify(['identity:read', 'token:introspect']), validUntil]);
    }

    await context.test('pending MFA cannot obtain codes; PKCE, exact callback and application binding are enforced', async () => {
      await assert.rejects(model.issueAuthorizationCode({ ...request, sessionId: pendingId }), errorCode('access_denied'));
      const code = await model.issueAuthorizationCode(request);
      const input = { apiKeyHash, codeHash: hashToken(code), redirectUri, verifier };
      await assert.rejects(model.exchangeAuthorizationCode({ ...input, verifier: randomToken() }), errorCode('invalid_grant'));
      await assert.rejects(model.exchangeAuthorizationCode({ ...input, redirectUri: redirectUri.toUpperCase() }), errorCode('invalid_grant'));
      await assert.rejects(model.exchangeAuthorizationCode({ ...input, apiKeyHash: otherKeyHash }), errorCode('invalid_grant'));
      const [unconsumed] = await query<{ consumedAt: Date | null }>(
        'SELECT consumed_at AS consumedAt FROM authorization_codes WHERE code_hash = ?', [input.codeHash]);
      assert.equal(unconsumed.consumedAt, null, 'Rejected exchanges must not consume a valid grant');
      await execute('UPDATE authorization_codes SET expires_at = ? WHERE code_hash = ?', [expiredAt, input.codeHash]);
      await assert.rejects(model.exchangeAuthorizationCode(input), errorCode('invalid_grant'));
    });

    await context.test('concurrent valid exchanges produce exactly one token and reject replay', async () => {
      const code = await model.issueAuthorizationCode(request);
      const input = { apiKeyHash, codeHash: hashToken(code), redirectUri, verifier };
      const attempts = await Promise.allSettled([
        model.exchangeAuthorizationCode(input), model.exchangeAuthorizationCode(input),
      ]);
      const successes = attempts.filter(attempt => attempt.status === 'fulfilled');
      const failures = attempts.filter(attempt => attempt.status === 'rejected');
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.ok(failures[0].reason instanceof SsoModelError);
      assert.equal(failures[0].reason.code, 'invalid_grant');
      accessToken = successes[0].value.accessToken;
      assert.equal(successes[0].value.expiresIn, 300);
      const tokens = await query<{ tokenHash: string }>('SELECT token_hash AS tokenHash FROM access_tokens WHERE session_id = ?', [sessionId]);
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].tokenHash, hashToken(accessToken));
      await assert.rejects(model.exchangeAuthorizationCode(input), errorCode('invalid_grant'));
    });

    await context.test('introspection binds audience and API key scopes/expiry/revocation', async () => {
      const tokenHash = hashToken(accessToken);
      const active = await model.introspectToken(apiKeyHash, tokenHash);
      assert.equal(active.active, true);
      if (active.active) {
        assert.equal(active.sub, userId);
        assert.equal(active.email, email);
        assert.equal(active.aud, applicationId);
      }
      assert.deepEqual(await model.introspectToken(otherKeyHash, tokenHash), { active: false });
      await execute('UPDATE api_keys SET scopes = ? WHERE id = ?', [JSON.stringify(['identity:read']), keyId]);
      await assert.rejects(model.introspectToken(apiKeyHash, tokenHash), errorCode('insufficient_scope'));
      await execute('UPDATE api_keys SET scopes = ?, expires_at = ? WHERE id = ?',
        [JSON.stringify(['identity:read', 'token:introspect']), expiredAt, keyId]);
      await assert.rejects(model.introspectToken(apiKeyHash, tokenHash), errorCode('invalid_client'));
      await execute('UPDATE api_keys SET expires_at = ?, revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [validUntil, keyId]);
      await assert.rejects(model.introspectToken(apiKeyHash, tokenHash), errorCode('invalid_client'));
      await execute('UPDATE api_keys SET revoked_at = NULL WHERE id = ?', [keyId]);
    });

    await context.test('userinfo and introspection immediately observe user, allowlist, session and token changes', async () => {
      const tokenHash = hashToken(accessToken);
      const inactive = async () => {
        assert.deepEqual(await model.introspectToken(apiKeyHash, tokenHash), { active: false });
        assert.equal(await model.getUserInfo(tokenHash), null);
      };
      assert.equal((await model.getUserInfo(tokenHash))?.sub, userId);
      // Direct updates isolate each SQL predicate; production admin revocation additionally destroys sessions.
      await execute('UPDATE users SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?', [userId]);
      await inactive();
      await execute('UPDATE users SET deleted_at = NULL WHERE id = ?', [userId]);
      await execute('DELETE FROM allowed_emails WHERE id = ?', [emailId]);
      await inactive();
      await execute('INSERT INTO allowed_emails (id,email,role) VALUES (?, ?, ?)', [emailId, email, 'user']);
      await execute("UPDATE sessions SET kind = 'pending' WHERE id = ?", [sessionId]);
      await inactive();
      await execute("UPDATE sessions SET kind = 'full', expires_at = ? WHERE id = ?", [expiredAt, sessionId]);
      await inactive();
      await execute('UPDATE sessions SET expires_at = ? WHERE id = ?', [validUntil, sessionId]);
      await execute('UPDATE access_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ?', [tokenHash]);
      await inactive();
      await execute('UPDATE access_tokens SET revoked_at = NULL, expires_at = ? WHERE token_hash = ?', [expiredAt, tokenHash]);
      await inactive();
      await execute('UPDATE access_tokens SET expires_at = ? WHERE token_hash = ?', [validUntil, tokenHash]);
      await execute('UPDATE applications SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [applicationId]);
      await assert.rejects(model.introspectToken(apiKeyHash, tokenHash), errorCode('invalid_client'));
      assert.equal(await model.getUserInfo(tokenHash), null);
      await execute('UPDATE applications SET revoked_at = NULL WHERE id = ?', [applicationId]);
      await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
      await inactive();
    });
  } finally {
    // Local _test DB and UUID-scoped fixture cleanup only; no TRUNCATE or production host access.
    await execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await execute('DELETE FROM api_keys WHERE id IN (?, ?)', [keyId, otherKeyId]);
    await execute('DELETE FROM applications WHERE id IN (?, ?)', [applicationId, otherApplicationId]);
    await execute('DELETE FROM users WHERE id = ?', [userId]);
    await execute('DELETE FROM allowed_emails WHERE id = ?', [emailId]);
    await pool.end();
  }
});
