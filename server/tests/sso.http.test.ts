import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { createSsoControllers } from '../src/controllers/ssoController.js';
import { pkceChallenge, SsoModelError, type SsoModel } from '../src/models/ssoModel.js';
import { hashToken } from '../src/services/crypto.js';
import type { Identity } from '../src/types.js';
import { config } from '../src/config.js';
import { csrfProtection, requireAuth } from '../src/middleware/security.js';

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
    getApplication: async () => ({ id: appId, name: 'People Portal', redirectUri,allowedScope:'identity:read profile email' }),
    isRegisteredOrigin: async origin => origin === 'https://portal.example.com',
    enrollmentContext: async()=>({ready:true,application:{id:appId,name:'People Portal'},requirements:{phone:false,line:false,minimumMfa:'standard'},missing:[],enrolled:true,blocked:false,registration:'closed',policyVersion:1,pendingDays:14,inactiveDays:null,noticeDays:30,lifecycleMode:'preview',totpEnabled:true}),
    beginAuthorization: async () => code,
    exchangeAuthorizationCode: async () => ({ accessToken: 'new-access-token', expiresIn: 300,scope:'identity:read profile email' }),
    refreshAccessToken: async () => { throw new SsoModelError('invalid_grant'); },
    introspectToken: async () => ({ active: false }),
    getUserInfo: async () => ({ given_name: 'Person', family_name: '', department: 'IT', roles: ['viewer'], aud: appId, sub: 'user-1', email: identity.email, name: identity.name,
      scope:'identity:read profile email',email_verified: true, applicationOrigin: 'https://portal.example.com' }),
    consentContext:async()=>({application:{name:'People Portal',origin:'https://portal.example.com'},purpose:'Profile display',noticeVersion:'1.0',policyVersion:1,scopes:[]}),decideConsent:async()=>({redirectTo:redirectUri}),listConsents:async()=>[],revokeConsent:async()=>{},matchPhone:async()=>({status:'unverified',match:null,phone_number_verified:false}),
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
  app.get('/api/sso/consent',requireAuth,controllers.consentContext);
  app.post('/api/sso/consent',requireAuth,csrfProtection,controllers.consentDecision);
  app.delete('/api/sso/consents/:id',requireAuth,csrfProtection,controllers.revokeConsent);
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
    const response = await request(makeApp({ beginAuthorization: async () => { issued = true; return code; } }, actor))
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

test('full MFA session creates session-bound consent without issuing a code or disclosing state to the service', async () => {
  const response = await request(makeApp({ beginAuthorization: async input => {
    assert.deepEqual(input, { applicationId: appId, redirectUri, challenge: pkceChallenge(verifier),
      userId: identity.userId, sessionId: identity.sessionId, state, scope:'identity:read profile email' });
    return code;
  } }, identity)).get('/api/sso/authorize').query(authorizeParams());
  assert.equal(response.status, 303);
  const callback = new URL(response.headers.location,'https://sso.example.test');
  assert.equal(callback.pathname,'/consent');
  assert.equal(callback.searchParams.get('request'),code);
  assert.equal(callback.searchParams.has('code'),false);
  assert.equal(callback.searchParams.has('state'),false);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});

test('token endpoint requires server API key and hashes opaque credentials before model calls', async () => {
  const body = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier };
  assert.equal((await request(makeApp()).post('/api/sso/token').send(body)).status, 401);
  const response = await request(makeApp({ exchangeAuthorizationCode: async input => {
    assert.deepEqual(input, { apiKeyHash: hashToken(apiKey), codeHash: hashToken(code), redirectUri, verifier });
    return { accessToken: code, expiresIn: 300,scope:'identity:read profile email' };
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

test('refresh is opt-in at code exchange and uses only hashed backend credentials',async()=>{
  const refresh=randomBytes(32).toString('base64url');
  const pair={accessToken:code,expiresIn:120,scope:'identity:read',refreshToken:refresh,refreshExpiresIn:120};
  const app=makeApp({exchangeAuthorizationCode:async input=>{
    assert.equal(input.requestRefreshToken,true);return pair;
  },refreshAccessToken:async input=>{
    assert.deepEqual(input,{apiKeyHash:hashToken(apiKey),refreshTokenHash:hashToken(refresh)});return pair;
  }});
  const first=await request(app).post('/api/sso/token').set('X-API-Key',apiKey).send({
    grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:verifier,request_refresh_token:true,
  }).expect(200);
  assert.equal(first.body.refresh_token,refresh);
  const renewed=await request(app).post('/api/sso/token').set('X-API-Key',apiKey)
    .send({grant_type:'refresh_token',refresh_token:refresh}).expect(200);
  assert.deepEqual(renewed.body,{access_token:code,token_type:'Bearer',expires_in:120,scope:'identity:read',
    refresh_token:refresh,refresh_expires_in:120});
  assert.equal(renewed.headers['cache-control'],'no-store');
  assert.equal(renewed.headers.pragma,'no-cache');
  await request(app).post('/api/sso/token').send({grant_type:'refresh_token',refresh_token:refresh}).expect(401);
});

test('refresh requests reject scope escalation, extra fields and malformed credentials before issuance',async()=>{
  const app=makeApp({refreshAccessToken:async()=>{throw new Error('Invalid input reached model');}});
  for(const extra of [{scope:'identity:read phone'},{client_id:appId},{redirect_uri:redirectUri},{code},
    {refresh_token:'short'},{refresh_token:[code]},{refresh_token:null}]){
    const response=await request(app).post('/api/sso/token').set('X-API-Key',apiKey)
      .send({grant_type:'refresh_token',refresh_token:code,...extra}).expect(400);
    assert.equal(response.body.code,'invalid_request');
  }
  await request(app).post('/api/sso/token').set('X-API-Key',apiKey).send({grant_type:'authorization_code',
    code,redirect_uri:redirectUri,code_verifier:verifier,request_refresh_token:'true'}).expect(400);
  const replay=await request(makeApp()).post('/api/sso/token').set('X-API-Key',apiKey)
    .send({grant_type:'refresh_token',refresh_token:code}).expect(400);
  assert.equal(replay.body.code,'invalid_grant');
  assert.equal(replay.headers['cache-control'],'no-store');
  const unsupported=await request(app).post('/api/sso/token').set('X-API-Key',apiKey)
    .send({grant_type:'password'}).expect(400);
  assert.equal(unsupported.body.code,'unsupported_grant_type');
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
  const app = makeApp({ beginAuthorization: async () => { issued = true; return code; } });
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
  const response = await request(makeApp({ beginAuthorization: async () => { throw new SsoModelError('access_denied'); } }, identity))
    .get('/api/sso/authorize').query(authorizeParams());
  assert.equal(response.status, 303);
  const location = new URL(response.headers.location, 'https://identity.example.com');
  assert.equal(location.pathname, '/login'); assert.equal(location.searchParams.get('auth'), 'access_denied');
  assert.equal(location.searchParams.has('code'), false);
});

test('consent requires full session, exact Origin and CSRF; client cannot inject user/session/redirect fields',async()=>{
  let decisions=0;
  const overrides:Partial<SsoModel>={decideConsent:async(request,session,user,approved,scopes)=>{
    decisions++;assert.equal(request,code);assert.equal(session,identity.sessionId);assert.equal(user,identity.userId);
    assert.equal(approved,true);assert.deepEqual(scopes,['identity:read']);return {redirectTo:redirectUri};
  }};
  const body={request:code,approved:true,scopes:['identity:read']};
  for(const actor of [undefined,{...identity,kind:'pending' as const},{...identity,phoneRequired:true}]){
    const response=await request(makeApp(overrides,actor)).post('/api/sso/consent').set('Origin',config.appOrigin).set('X-CSRF-Token','csrf').send(body);
    assert.ok([401,403].includes(response.status));
  }
  const app=makeApp(overrides,identity);
  for(const [origin,csrf] of [['https://attacker.example','csrf'],[config.appOrigin,'wrong'],['','']]){
    await request(app).post('/api/sso/consent').set('Origin',origin).set('X-CSRF-Token',csrf).send(body).expect(403);
  }
  for(const extra of [{userId:'other-user'},{sessionId:'other-session'},{redirectTo:'https://attacker.example'},{approved:'true'}]){
    await request(app).post('/api/sso/consent').set('Origin',config.appOrigin).set('X-CSRF-Token','csrf').send({...body,...extra}).expect(400);
  }
  assert.equal(decisions,0);
  const accepted=await request(app).post('/api/sso/consent').set('Origin',config.appOrigin).set('X-CSRF-Token','csrf').send(body).expect(200);
  assert.equal(accepted.headers['cache-control'],'no-store');assert.equal(decisions,1);
});

test('requested scope cannot exceed the registered policy even before login',async()=>{
  const app=makeApp({},identity);
  for(const scope of ['identity:read phone','identity:read line','identity:read unknown','identity:read email email','email']){
    await request(app).get('/api/sso/authorize').query(authorizeParams({scope})).expect(400);
  }
  const accepted=await request(app).get('/api/sso/authorize').query(authorizeParams({scope:'identity:read'})).expect(303);
  assert.match(accepted.headers.location,/^\/consent\?/);
});

test('withdrawing consent is a CSRF-protected owner operation, never a GET side effect',async()=>{
  let calls=0;
  const app=makeApp({revokeConsent:async(id,user)=>{assert.equal(id,appId);assert.equal(user,identity.userId);calls++;}},identity);
  await request(app).delete(`/api/sso/consents/${appId}`).expect(403);
  await request(app).get(`/api/sso/consents/${appId}`).expect(404);
  await request(app).delete(`/api/sso/consents/${appId}`).set('Origin',config.appOrigin).set('X-CSRF-Token','csrf').expect(200);
  assert.equal(calls,1);
});
