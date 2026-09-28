import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { createSsoModel, pkceChallenge, SsoModelError, type SsoDatabase } from '../src/models/ssoModel.js';
import { hashToken } from '../src/services/crypto.js';
import { IntrospectionCache } from '../src/services/introspectionCache.js';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const redirectUri = 'https://portal.example.com/callback';
const applicationId = 'application-1';
const codeHash = hashToken('opaque-code');

// In-memory transaction adapter: test SQL execution order/atomicity without touching a live DB.
// MariaDB integration still needs deployment credentials and is documented separately.
function fakeDatabase() {
  const state = { consumed: false, live: true, keyLive: true, codeLive: true,
    scopes: ['identity:read', 'token:introspect'], applicationId, tokens: [] as any[][],
    keyExpiresAt: 2_000_000_100 as number | string | null, tokenExpiresAt: 2_000_000_000,
    failInsert: false, statements: [] as string[] };
  let serial: Promise<unknown> = Promise.resolve();
  const connection = {} as PoolConnection;
  const db: SsoDatabase = {
    async transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
      const run = serial.then(async () => {
        const previous = { consumed: state.consumed, tokens: [...state.tokens] };
        try { return await fn(connection); }
        catch (error) { state.consumed = previous.consumed; state.tokens = previous.tokens; throw error; }
      });
      serial = run.catch(() => {});
      return run;
    },
    async query<T>(sql: string, params: any[] = [], tx?: PoolConnection): Promise<T[]> {
      state.statements.push(sql);
      if (sql.includes('FROM api_keys k')) {
        assert.equal(tx, connection);
        assert.match(sql, /FOR UPDATE/);
        return (state.keyLive ? [{ id: 'key-1', applicationId: state.applicationId,
          redirectUri, scopes: JSON.stringify(state.scopes), expiresAt: state.keyExpiresAt }] : []) as T[];
      }
      if (sql.includes('FROM authorization_codes c')) {
        assert.equal(tx, connection);
        assert.match(sql, /FOR UPDATE/);
        return (!state.consumed && state.codeLive && state.live && params[0] === codeHash && params[1] === applicationId
          ? [{ userId: 'user-1', sessionId: 'session-1', redirectUri, challenge: pkceChallenge(verifier) }] : []) as T[];
      }
      if (sql.includes('FROM access_tokens t')) {
        return (state.live && (!params[1] || params[1] === applicationId)
          ? [{ sub: 'user-1', email: 'user@example.com', name: 'User', aud: applicationId,
            exp: state.tokenExpiresAt, scope: 'identity:read', redirectUri }] : []) as T[];
      }
      if (sql.includes('FROM applications a')) return (state.live ? [{ id: applicationId }] : []) as T[];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql: string, params: any[] = [], tx?: PoolConnection): Promise<ResultSetHeader> {
      state.statements.push(sql);
      assert.equal(tx, connection);
      let affectedRows = 1;
      if (sql.includes('UPDATE authorization_codes')) {
        affectedRows = state.consumed ? 0 : 1;
        state.consumed = true;
      }
      if (sql.includes('INSERT INTO access_tokens')) {
        if (state.failInsert) throw new Error('storage failure');
        state.tokens.push(params);
      }
      return { affectedRows } as ResultSetHeader;
    },
  };
  return { db, state, model: createSsoModel(db) };
}

const exchange = { apiKeyHash: hashToken('server-key'), codeHash, redirectUri, verifier };
const isError = (code: string) => (error: unknown) => error instanceof SsoModelError && error.code === code;

test('S256 matches RFC 7636 test vector', () => {
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('concurrent exchange consumes one code exactly once and stores only hashed token', async () => {
  const { state, model } = fakeDatabase();
  const outcomes = await Promise.allSettled([
    model.exchangeAuthorizationCode(exchange), model.exchangeAuthorizationCode(exchange),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  const result = outcomes.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<{ accessToken: string; expiresIn: number }>;
  assert.equal(result.value.expiresIn, 300);
  assert.match(result.value.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(state.tokens.length, 1);
  assert.equal(state.tokens[0][0], hashToken(result.value.accessToken));
  assert.ok(!state.tokens[0].includes(result.value.accessToken));
});

test('bad PKCE/redirect/application, expired code, and revoked session cannot consume a code', async () => {
  for (const update of [
    { verifier: 'x'.repeat(43) }, { redirectUri: `${redirectUri}/extra` },
    { verifier: 'x'.repeat(42) }, { verifier: `${'x'.repeat(42)}!` },
  ]) {
    const { model, state } = fakeDatabase();
    await assert.rejects(model.exchangeAuthorizationCode({ ...exchange, ...update }), isError('invalid_grant'));
    assert.equal(state.consumed, false);
    assert.equal(state.tokens.length, 0);
  }
  for (const cause of ['application', 'code', 'session']) {
    const { model, state } = fakeDatabase();
    if (cause === 'application') state.applicationId = 'another-application';
    if (cause === 'code') state.codeLive = false;
    if (cause === 'session') state.live = false;
    await assert.rejects(model.exchangeAuthorizationCode(exchange), isError('invalid_grant'));
    assert.equal(state.consumed, false);
  }
});

test('revoked/expired API keys and missing scopes cannot exchange or introspect', async () => {
  const { model, state } = fakeDatabase();
  state.keyLive = false;
  await assert.rejects(model.exchangeAuthorizationCode(exchange), isError('invalid_client'));
  await assert.rejects(model.introspectToken('key-hash', 'token-hash'), isError('invalid_client'));
  state.keyLive = true;
  state.scopes = ['token:introspect'];
  await assert.rejects(model.exchangeAuthorizationCode(exchange), isError('insufficient_scope'));
  state.scopes = ['identity:read'];
  await assert.rejects(model.introspectToken('key-hash', 'token-hash'), isError('insufficient_scope'));
});

test('token insertion failure rolls back code consumption', async () => {
  const { model, state } = fakeDatabase();
  state.failInsert = true;
  await assert.rejects(model.exchangeAuthorizationCode(exchange), /storage failure/);
  assert.equal(state.consumed, false);
  assert.equal(state.tokens.length, 0);
  state.failInsert = false;
  assert.equal((await model.exchangeAuthorizationCode(exchange)).expiresIn, 300);
});

test('audit enqueue failure rolls back token issuance and code consumption',async()=>{
  const {model,state}=fakeDatabase();
  await assert.rejects(model.exchangeAuthorizationCode(exchange,async()=>{throw new Error('audit unavailable');}),/audit unavailable/);
  assert.equal(state.consumed,false);assert.equal(state.tokens.length,0);
  let audited=false;
  await model.exchangeAuthorizationCode(exchange,async(_conn,event,target,metadata)=>{
    assert.equal(event,'sso.token.issue');assert.equal(target,applicationId);
    assert.deepEqual(metadata,{userId:'user-1',sessionId:'session-1',apiKeyId:'key-1'});audited=true;
  });
  assert.equal(audited,true);
});

test('introspection binds application and both identity endpoints observe revocation immediately', async () => {
  const { model, state } = fakeDatabase();
  assert.equal((await model.introspectToken('key', 'token')).active, true);
  assert.equal((await model.getUserInfo('token'))?.email_verified, true);
  state.applicationId = 'another-application';
  assert.deepEqual(await model.introspectToken('key', 'token'), { active: false });
  state.applicationId = applicationId;
  state.live = false;
  assert.deepEqual(await model.introspectToken('key', 'token'), { active: false });
  assert.equal(await model.getUserInfo('token'), null);
  await assert.rejects(model.issueAuthorizationCode({ applicationId, userId: 'user-1', sessionId: 'session-1',
    redirectUri, challenge: pkceChallenge(verifier) }), isError('access_denied'));
});

test('introspection effective expiry is bounded by the authenticating API key and token/session result', async () => {
  const { model, state } = fakeDatabase();
  for (const [keyExpiresAt, tokenExpiresAt, expected] of [
    ['1999999900.900', 2_000_000_000, 1_999_999_900],
    [2_000_000_100, 1_999_999_800.5, 1_999_999_800],
    [null, 2_000_000_000, 2_000_000_000],
  ] as const) {
    state.keyExpiresAt = keyExpiresAt;
    state.tokenExpiresAt = tokenExpiresAt;
    const result = await model.introspectToken('key', 'token');
    assert.equal(result.active, true);
    if (result.active) assert.equal(result.exp, expected);
  }
});

test('five-second cache reloads at an earlier key or session/token effective expiry', async () => {
  for (const source of ['key', 'session/token']) {
    const { model, state } = fakeDatabase();
    const deadline = 1_999_999_990;
    if (source === 'key') state.keyExpiresAt = deadline;
    else state.tokenExpiresAt = deadline;
    let now = deadline * 1000 - 1000;
    let calls = 0;
    const cache = new IntrospectionCache(5000, 10, () => now);
    const load = () => { calls++; return model.introspectToken('key', 'token'); };
    assert.equal((await cache.get('key', 'token', load)).active, true);
    if (source === 'key') state.keyLive = false;
    else state.live = false;
    now = deadline * 1000;
    if (source === 'key') await assert.rejects(cache.get('key', 'token', load), isError('invalid_client'));
    else assert.deepEqual(await cache.get('key', 'token', load), { active: false });
    assert.equal(calls, 2);
  }
});
