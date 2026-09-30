// Reference flow for an existing Express 5 BFF. See SSO-INTEGRATION.md prerequisites.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Express 5 + persistent server session store, HTTPS, CSRF & rate limits.
const SSO = process.env.SSO_ORIGIN;
const APP_ID = process.env.SSO_APPLICATION_ID;
const CALLBACK = process.env.SSO_REDIRECT_URI;
const KEY = process.env.SSO_API_KEY; // server only
const hash = value => createHash('sha256').update(value).digest();
const save = req => new Promise((ok, no) =>
  req.session.save(error => error ? no(error) : ok()));

app.get('/auth/login', async (req, res) => {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  req.session.sso = { stateHash: hash(state).toString('hex'),
    verifier, createdAt: Date.now() };
  await save(req); // persist BEFORE redirecting
  const query = new URLSearchParams({ client_id: APP_ID,
    redirect_uri: CALLBACK, response_type: 'code', state,
    code_challenge: hash(verifier).toString('base64url'),
    code_challenge_method: 'S256' });
  res.set('Cache-Control', 'no-store').redirect(303,
    SSO + '/api/sso/authorize?' + query);
});

async function callSso(path, body) {
  const response = await fetch(SSO + '/api/sso/' + path, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('SSO unavailable or rejected');
  return response.json(); // log status/request-id, never secrets
}

app.get('/auth/callback', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const { code, state } = req.query;
  const flow = req.session.sso;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)
    || typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)
    || !flow || Date.now() - flow.createdAt > 10 * 60 * 1000
    || !timingSafeEqual(hash(state), Buffer.from(flow.stateHash, 'hex')))
    return res.sendStatus(400);
  delete req.session.sso;
  await save(req);
  const token = await callSso('token', { grant_type: 'authorization_code',
    code, redirect_uri: CALLBACK, code_verifier: flow.verifier });
  const identity = await callSso('introspect', { token: token.access_token });
  if (!identity.active || identity.aud !== APP_ID ||
    identity.exp <= Math.floor(Date.now() / 1000)) return res.sendStatus(401);
  await new Promise((ok, no) => req.session.regenerate(e => e ? no(e) : ok()));
  req.session.ssoToken = token.access_token; // never returned to React
  await save(req);
  res.redirect(303, '/'); // remove code/state from the next page URL
});

async function requireIdentity(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.session.ssoToken) return res.sendStatus(401);
  const identity = await callSso('introspect', { token: req.session.ssoToken });
  if (!identity.active || identity.aud !== APP_ID ||
    identity.exp <= Math.floor(Date.now() / 1000)) {
    delete req.session.ssoToken; await save(req); return res.sendStatus(401);
  }
  req.identity = identity; next();
}

app.get('/api/approvals', requireIdentity, (req, res) => {
  if (!req.identity.roles.includes('approver')) return res.sendStatus(403);
  res.json({ userId: req.identity.sub });
});
// Add Origin + CSRF validation for portal writes/logout.
// Add a safe error handler; SSO timeout returns 503, never authenticated.
// Each browser session supports one outstanding login in this example.
