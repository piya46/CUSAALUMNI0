import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { authenticationOptions, authenticatePasskey, reauthenticatePasskey } from '../src/models/passkeyModel.js';
import { lockFactorSession } from '../src/models/factorModel.js';
import { hashToken, seal, unseal } from '../src/services/crypto.js';
import { me } from '../src/controllers/authController.js';

// Verify real P-256 WebAuthn signatures through the production library and model.
// Only MariaDB transport is replaced; no live users, provider or DB is touched.
test('Passkey reauthentication binds one-use proofs and commits assurance with audit atomically', async t => {
  const previous = { passkeyEnabled: config.passkeyEnabled, appOrigin: config.appOrigin };
  config.passkeyEnabled = true; config.appOrigin = 'https://sso.example.test';
  const sessionId = '00000000-0000-4000-8000-000000000001', userId = '00000000-0000-4000-8000-000000000002';
  const credentialId = randomBytes(32).toString('base64url');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  const originalAt = '2026-01-01T00:00:00.000Z';
  let state = { challengeId: '', payload: '', status: 'pending', counter: 1, method: 'line', at: originalAt, failures: 0, audits: [] as string[] };
  let snapshot = structuredClone(state), failAudit = false, expired = false, keyOwned = true, sessionExists = true, factor = 'synthetic-enrolled-factor', kind = 'full', locked = false;
  const row = () => ({ id: sessionId, user_id: userId, kind, totp_secret: factor, mfa_method: state.method, authenticated_at: state.at, locked });
  const connection = {
    beginTransaction: async () => { snapshot = structuredClone(state); },
    commit: async () => {}, rollback: async () => { state = snapshot; }, release: () => {},
    execute: async (sql: string, params: any[]) => {
      if (sql.includes('SELECT s.*')) return [[...(sessionExists && params[0] === sessionId ? [row()] : [])]];
      if (sql.startsWith('SELECT credential_id')) return [[{ credential_id: credentialId, transports: '["internal"]' }]];
      if (sql.startsWith('DELETE FROM factor_challenges')) { state.challengeId = ''; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO factor_challenges')) { state.challengeId = params[0]; state.payload = params[3]; state.status = 'pending'; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT * FROM factor_challenges')) return [[...(!expired && state.status === 'pending' && params[0] === state.challengeId && params[1] === sessionId && params[2] === 'passkey_auth' ? [{ payload: state.payload }] : [])]];
      if (sql.startsWith('UPDATE factor_challenges')) { state.status = 'used'; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT * FROM passkeys')) return [[...(keyOwned && params[0] === hashToken(credentialId) && params[1] === userId ? [{ id: 'credential-row', credential_id: credentialId, public_key: cose, counter: state.counter, transports: '[]' }] : [])]];
      if (sql.startsWith('UPDATE passkeys SET counter=')) { state.counter = params[0]; return [{ affectedRows: 1 }]; }
      if (sql === "UPDATE sessions SET mfa_method='passkey',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?") { state.method = 'passkey'; state.at = new Date().toISOString(); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE users SET mfa_failed_attempts=IF')) { state.failures++; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE users SET mfa_failed_attempts=0')) { state.failures = 0; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected SQL (session/token/expiry must not rotate on reauth): ${sql}`);
    },
  };
  t.mock.method(pool, 'getConnection', async () => connection as any);
  const audit = async (_conn: unknown, event: string) => { if (failAudit) throw new Error('audit unavailable'); state.audits.push(event); };
  function assertion(challenge: string, overrides: { origin?: string; rp?: string; flags?: number; counter?: number; signature?: string; userHandle?: string } = {}): AuthenticationResponseJSON {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: overrides.origin ?? config.appOrigin, crossOrigin: false }));
    const authData = Buffer.alloc(37); createHash('sha256').update(overrides.rp ?? 'sso.example.test').digest().copy(authData);
    authData[32] = overrides.flags ?? 5; // UP + UV, both required
    authData.writeUInt32BE(overrides.counter ?? state.counter + 1, 33);
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'),
      signature: overrides.signature ?? sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), privateKey).toString('base64url'),
      userHandle: overrides.userHandle ?? Buffer.from(userId).toString('base64url'),
    } };
  }
  async function options() { return authenticationOptions(sessionId, 'reauth'); }
  try {
    const first = await options();
    assert.equal(first.options.userVerification, 'required'); assert.equal(first.options.rpId, 'sso.example.test');
    assert.equal(JSON.parse(unseal(state.payload)).purpose, 'reauth');
    const proof = assertion(first.options.challenge);
    assert.equal(await reauthenticatePasskey(sessionId, first.challengeId, proof, audit), true);
    assert.equal(state.method, 'passkey'); assert.notEqual(state.at, originalAt); assert.equal(state.counter, 2);
    assert.deepEqual(state.audits, ['auth.reauth.success']);
    assert.equal(await reauthenticatePasskey(sessionId, first.challengeId, proof, audit), false); // replay
    await lockFactorSession(sessionId, connection as any, 'manage'); // fresh Passkey may manage factors

    for (const [label, overrides] of Object.entries({
      wrongOrigin: { origin: 'https://evil.example.test' }, wrongRP: { rp: 'evil.example.test' },
      noUV: { flags: 1 }, noUP: { flags: 4 }, staleCounter: { counter: 2 },
      invalidSignature: { signature: randomBytes(64).toString('base64url') },
      otherUser: { userHandle: Buffer.from('other-user').toString('base64url') },
    })) {
      const challenge = await options(), beforeAt = state.at;
      assert.equal(await reauthenticatePasskey(sessionId, challenge.challengeId, assertion(challenge.options.challenge, overrides), audit), false, label);
      assert.equal(state.counter, 2); assert.equal(state.at, beforeAt); assert.equal(state.status, 'used');
    }
    for (const scenario of ['purpose', 'differentChallenge', 'missingPurpose', 'factorChanged', 'otherCredential', 'expired', 'otherSession', 'replacedChallenge']) {
      const challenge = await options(), beforeAt = state.at, valid = assertion(challenge.options.challenge);
      const data = JSON.parse(unseal(state.payload));
      if (scenario === 'purpose') { data.purpose = 'login'; state.payload = seal(JSON.stringify(data)); }
      if (scenario === 'missingPurpose') { delete data.purpose; state.payload = seal(JSON.stringify(data)); }
      if (scenario === 'differentChallenge') valid.response.clientDataJSON = assertion('another-challenge').response.clientDataJSON;
      if (scenario === 'factorChanged') factor += '-changed';
      if (scenario === 'otherCredential') keyOwned = false;
      if (scenario === 'expired') expired = true;
      if (scenario === 'replacedChallenge') await options();
      if (scenario === 'otherSession') await assert.rejects(reauthenticatePasskey('another-session', challenge.challengeId, valid, audit), { code: 'UNAUTHENTICATED' });
      else assert.equal(await reauthenticatePasskey(sessionId, challenge.challengeId, valid, audit), false, scenario);
      assert.equal(state.counter, 2); assert.equal(state.at, beforeAt); keyOwned = true; expired = false;
    }
    // A login endpoint cannot upgrade an existing full session with a reauth assertion.
    const latest = await options();
    await assert.rejects(authenticatePasskey(sessionId, latest.challengeId, assertion(latest.options.challenge), audit), { code: 'MFA_REQUIRED' });
    // Nor can a pending session enter the reauth endpoint.
    kind = 'pending'; await assert.rejects(options(), { code: 'TOTP_ENROLLMENT_REQUIRED' }); kind = 'full';
    state.method = 'recovery'; await assert.rejects(options(), { code: 'MFA_ENROLLMENT_REQUIRED' }); state.method = 'line';
    locked = true; await assert.rejects(options(), { code: 'ACCOUNT_LOCKED' }); locked = false;
    sessionExists = false; await assert.rejects(options(), { code: 'UNAUTHENTICATED' }); sessionExists = true;

    const transactionTest = await options(), before = structuredClone(state), valid = assertion(transactionTest.options.challenge);
    failAudit = true;
    await assert.rejects(reauthenticatePasskey(sessionId, transactionTest.challengeId, valid, audit), { message: 'audit unavailable' });
    assert.deepEqual(state, before); // includes challenge, counter, assurance and failure counters
    failAudit = false;
    assert.equal(await reauthenticatePasskey(sessionId, transactionTest.challengeId, valid, audit), true);
    config.passkeyEnabled = false; await assert.rejects(options(), { code: 'NOT_FOUND' });
  } finally { Object.assign(config, previous); }
});

test('/auth/me reports the same admin assurance policy and whether phone verification is enabled', async t => {
  const previous = config.firebasePhoneEnabled;
  t.mock.method(pool, 'execute', async (sql: string) => {
    if (sql.startsWith('SELECT EXISTS')) return [[{ passkey: 1, line: 1, phone: 0 }]] as any;
    if (sql.startsWith('SELECT COUNT(*)')) return [[{ count: 5 }]] as any;
    throw new Error(sql);
  });
  try {
    for (const method of ['passkey', 'totp', 'line', 'recovery', 'email']) for (const enabled of [false, true]) {
      config.firebasePhoneEnabled = enabled;
      let response: any;
      await me({ identity: { userId: 'test-user', kind: 'full', role: 'admin', totpEnabled: true, mfaMethod: method } } as any, { json: (value: unknown) => { response = value; } } as any);
      assert.equal(response.adminMfaRequired, !['passkey', 'totp'].includes(method));
      assert.equal(response.factors.phoneEnabled, enabled); assert.equal(response.factors.phoneVerified, false);
    }
  } finally { config.firebasePhoneEnabled = previous; }
});
