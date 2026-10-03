import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createSsoControllers } from '../src/controllers/ssoController.js';
import { pkceChallenge, SsoModelError, type SsoModel } from '../src/models/ssoModel.js';
import { hashToken } from '../src/services/crypto.js';
import type { Identity } from '../src/types.js';

const appId = 'b7ab297a-8903-4550-b3cc-c11daed7a824';
const redirectUri = 'https://portal.example.com/auth/callback';
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const apiKey = `cusa_${randomBytes(32).toString('base64url')}`;
const code = randomBytes(32).toString('base64url');
const identity: Identity = {
  userId: 'user-1', sessionId: 'session-1', email: 'person@example.com', name: 'Person', avatar: null,
  role: 'user', kind: 'full', csrfToken: 'csrf', totpEnabled: false, mfaMethod: 'email', authenticatedAt: new Date(),
};

function makeApp(overrides: Partial<SsoModel> = {}, actor?: Identity) {
  const model: SsoModel = {
    getApplication: async () => ({ id: appId, name: 'People Portal', redirectUri }),
    isRegisteredOrigin: async origin => origin === 'https://portal.example.com',
    issueAuthorizationCode: async () => code,
    exchangeAuthorizationCode: async () => ({ accessToken: 'new-access-token', expiresIn: 300 }),
    introspectToken: async () => ({ active: false }),
    getUserInfo: async () => ({ given_name: 'Person', family_name: '', department: 'IT', roles: ['viewer'], aud: appId, sub: 'user-1', email: identity.email, name: identity.name,
      email_verified: true, applicationOrigin: 'https://portal.example.com' }),
    ...overrides,
  };
  const controllers = createSsoControllers(model, async () => {});
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = actor; next(); });
  app.get('/api/sso/authorize', controllers.authorize);
  app.get('/api/sso/login-context', controllers.loginContext);
  app.post('/api/sso/token', controllers.token);
  app.post('/api/sso/introspect', controllers.introspect);
  app.get('/api/sso/userinfo', controllers.userinfo);
  app.options('/api/sso/userinfo', controllers.userinfoOptions);
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: error.message, code: error.code });
  };
  app.use(errorHandler);
  return app;
}

function authorizeParams(overrides: Record<string, string> = {}) {
  return { response_type: 'code', client_id: appId, redirect_uri: redirectUri, state,
    code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', ...overrides };
}

test('unknown or mismatched redirect is rejected before login routing', async () => {
  for (const destination of ['https://attacker.example/callback', `${redirectUri}/extra`, redirectUri.toUpperCase()]) {
    const response = await request(makeApp()).get('/api/sso/authorize').query(authorizeParams({ redirect_uri: destination }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.location, undefined);
  }
  const inactive = await request(makeApp({ getApplication: async () => null }))
    .get('/api/sso/authorize').query(authorizeParams());
  assert.equal(inactive.status, 400);
  assert.equal(inactive.headers.location, undefined);
});

test('unauthenticated and pending sessions resume only through a validated internal path', async () => {
  for (const actor of [undefined, { ...identity, kind: 'pending' as const }]) {
    let issued = false;
    const response = await request(makeApp({ issueAuthorizationCode: async () => { issued = true; return code; } }, actor))
      .get('/api/sso/authorize').query(authorizeParams());
    assert.equal(response.status, 303);
    assert.match(response.headers.location, /^\/login\?returnTo=/);
    const location = new URL(response.headers.location, 'https://identity.example.com');
    const returnTo = location.searchParams.get('returnTo')!;
    assert.ok(returnTo.startsWith('/api/sso/authorize?'));
    assert.equal(new URL(returnTo, location).searchParams.get('redirect_uri'), redirectUri);
    assert.equal(issued, false);
  }
});

test('rejects weak state, plain PKCE, malformed/noncanonical challenges and duplicate query parameters', async () => {
  const invalid = [
    { state: 'predictable' }, { code_challenge_method: 'plain' }, { code_challenge: 'A'.repeat(42) },
    { code_challenge: 'A'.repeat(42) + 'B' }, { response_type: 'token' },
  ];
  for (const input of invalid) {
    const response = await request(makeApp({}, identity)).get('/api/sso/authorize').query(authorizeParams(input));
    assert.equal(response.status, 400);
    assert.equal(response.headers.location, undefined);
  }
  const duplicate = await request(makeApp({}, identity)).get('/api/sso/authorize')
    .query(authorizeParams()).query({ redirect_uri: 'https://attacker.example' });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.headers.location, undefined);
});

test('full MFA session issues code only for its current user/session, returning state without caching', async () => {
  const response = await request(makeApp({ issueAuthorizationCode: async input => {
    assert.deepEqual(input, { applicationId: appId, redirectUri, challenge: pkceChallenge(verifier),
      userId: identity.userId, sessionId: identity.sessionId });
    return code;
  } }, identity)).get('/api/sso/authorize').query(authorizeParams());
  assert.equal(response.status, 303);
  const callback = new URL(response.headers.location);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('code'), code);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});

test('token endpoint requires server API key and hashes opaque credentials before model calls', async () => {
  const body = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier };
  assert.equal((await request(makeApp()).post('/api/sso/token').send(body)).status, 401);
  const response = await request(makeApp({ exchangeAuthorizationCode: async input => {
    assert.deepEqual(input, { apiKeyHash: hashToken(apiKey), codeHash: hashToken(code), redirectUri, verifier });
    return { accessToken: code, expiresIn: 300 };
  } })).post('/api/sso/token').set('X-API-Key', apiKey).send(body);
  assert.equal(response.status, 200);
  assert.equal(response.body.access_token, code);
  assert.equal(response.body.expires_in, 300);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('malformed verifier and replayed/expired/mismatched grant never issue a token', async () => {
  let called = false;
  const bad = await request(makeApp({ exchangeAuthorizationCode: async () => {
    called = true; throw new Error('should not run');
  } })).post('/api/sso/token').set('X-API-Key', apiKey)
    .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(called, false);
  const replay = await request(makeApp({ exchangeAuthorizationCode: async () => { throw new SsoModelError('invalid_grant'); } }))
    .post('/api/sso/token').set('X-API-Key', apiKey)
    .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'invalid_grant');
});

test('introspection authenticates API keys, enforces scope errors and returns inactive without identity disclosure', async () => {
  const missing = await request(makeApp()).post('/api/sso/introspect').send({ token: code });
  assert.equal(missing.status, 401);
  const denied = await request(makeApp({ introspectToken: async () => { throw new SsoModelError('insufficient_scope'); } }))
    .post('/api/sso/introspect').set('X-API-Key', apiKey).send({ token: code });
  assert.equal(denied.status, 403);
  const inactive = await request(makeApp()).post('/api/sso/introspect').set('X-API-Key', apiKey).send({ token: code });
  assert.equal(inactive.status, 200);
  assert.deepEqual(inactive.body, { active: false });
});

test('userinfo accepts bearer tokens only and reflects immediate session/account revocation', async () => {
  const app = makeApp({}, identity);
  assert.equal((await request(app).get('/api/sso/userinfo')).status, 401);
  assert.equal((await request(app).get('/api/sso/userinfo').query({ access_token: code })).status, 401);
  const ok = await request(app).get('/api/sso/userinfo').set('Authorization', `Bearer ${code}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email_verified, true);
  const revoked = await request(makeApp({ getUserInfo: async () => null }))
    .get('/api/sso/userinfo').set('Authorization', `Bearer ${code}`);
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers['www-authenticate'], /invalid_token/);
});

test('userinfo CORS preflight permits only active registered origins, GET, and Authorization', async () => {
  const app = makeApp();
  const allowed = await request(app).options('/api/sso/userinfo')
    .set('Origin', 'https://portal.example.com').set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'authorization');
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://portal.example.com');
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  assert.match(allowed.headers.vary, /Origin/);
  for (const [origin, method, header] of [
    ['https://attacker.example', 'GET', 'authorization'], ['null', 'GET', 'authorization'],
    ['https://portal.example.com', 'POST', 'authorization'], ['https://portal.example.com', 'GET', 'x-api-key'],
  ]) {
    const rejected = await request(app).options('/api/sso/userinfo').set('Origin', origin)
      .set('Access-Control-Request-Method', method).set('Access-Control-Request-Headers', header);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  }
});

test('userinfo actual CORS origin must match the token application, even for another registered application', async () => {
  const app = makeApp({ isRegisteredOrigin: async () => true });
  const allowed = await request(app).get('/api/sso/userinfo').set('Authorization', `Bearer ${code}`)
    .set('Origin', 'https://portal.example.com');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://portal.example.com');
  assert.equal(allowed.body.applicationOrigin, undefined);
  const denied = await request(app).get('/api/sso/userinfo').set('Authorization', `Bearer ${code}`)
    .set('Origin', 'https://other-registered-app.example.com');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const introspect = await request(app).post('/api/sso/introspect').set('X-API-Key', apiKey)
    .set('Origin', 'https://portal.example.com').send({ token: code });
  assert.equal(introspect.headers['access-control-allow-origin'], undefined);
});

test('login context shows registered branding only, validates PKCE/callback and does not issue credentials', async () => {
  let issued = false;
  const app = makeApp({ issueAuthorizationCode: async () => { issued = true; return code; } });
  await request(app).get('/api/sso/login-context').query(authorizeParams({ name: 'Spoofed service' })).expect(400);
  const response = await request(app).get('/api/sso/login-context').query(authorizeParams());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.application, { name: 'People Portal', origin: 'https://portal.example.com' });
  assert.equal(new URL(response.body.returnTo, 'https://sso.example.com').pathname, '/api/sso/authorize');
  assert.equal(response.body.returnTo.includes('Spoofed'), false);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(issued, false);
  for (const input of [{ redirect_uri: 'https://attacker.example/callback' }, { code_challenge_method: 'plain' }, { state: 'short' }]) {
    const denied = await request(app).get('/api/sso/login-context').query(authorizeParams(input));
    assert.equal(denied.status, 400); assert.equal(denied.body.application, undefined);
  }
  assert.equal((await request(makeApp({ getApplication: async () => null })).get('/api/sso/login-context').query(authorizeParams())).status, 400);
});

test('missing service membership returns to central login with a safe denial state', async () => {
  const response = await request(makeApp({ issueAuthorizationCode: async () => { throw new SsoModelError('access_denied'); } }, identity))
    .get('/api/sso/authorize').query(authorizeParams());
  assert.equal(response.status, 303);
  const location = new URL(response.headers.location, 'https://identity.example.com');
  assert.equal(location.pathname, '/login'); assert.equal(location.searchParams.get('auth'), 'access_denied');
  assert.equal(location.searchParams.has('code'), false);
});
