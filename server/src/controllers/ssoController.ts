import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { audit, HttpError } from '../middleware/security.js';
import { hashToken } from '../services/crypto.js';
import { ssoModel, SsoModelError, type SsoModel } from '../models/ssoModel.js';
import { config } from '../config.js';
import { IntrospectionCache } from '../services/introspectionCache.js';

const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const authorizationSchema = z.object({
  client_id: z.string().regex(uuid), redirect_uri: z.string().min(1).max(2048),
  response_type: z.literal('code'), state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  code_challenge_method: z.literal('S256'), code_challenge: z.string().regex(opaqueToken)
    .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value),
});
const exchangeSchema = z.object({
  grant_type: z.literal('authorization_code'), code: z.string().regex(opaqueToken),
  redirect_uri: z.string().min(1).max(2048), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict();
const introspectionSchema = z.object({ token: z.string().min(1).max(512) }).strict();
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Invalid request parameters', 'invalid_request');
  return parsed.data;
}

function noStore(res: Response): void {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
}

function apiKey(req: Request): string {
  const key = req.get('X-API-Key');
  if (!key || !/^[A-Za-z0-9_.~-]{32,256}$/.test(key)) {
    throw new HttpError(401, 'Valid server-side API key required', 'invalid_client');
  }
  return hashToken(key);
}

function callbackUrl(value: string): URL {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.hash) throw new Error('Unsafe callback');
    return url;
  } catch { throw new HttpError(400, 'Invalid registered callback URL', 'invalid_request'); }
}

function action(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res) => {
    noStore(res);
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof SsoModelError) {
        const status = error.code === 'invalid_client' ? 401
          : ['access_denied', 'insufficient_scope'].includes(error.code) ? 403 : 400;
        const message = error.code === 'invalid_client' ? 'Invalid or expired API key'
          : error.code === 'insufficient_scope' ? 'API key does not permit this operation'
            : error.code === 'access_denied' ? 'Account or session is no longer authorized'
              : 'Authorization code is invalid, expired, used, or does not match this request';
        throw new HttpError(status, message, error.code);
      }
      throw error;
    }
  };
}

export function createSsoControllers(model: SsoModel = ssoModel, recordAudit: typeof audit = audit, cache=new IntrospectionCache(config.introspectionCacheSeconds*1000)) {
  async function authorizationContext(query: unknown) {
    const parameters = parse(authorizationSchema, query);
    const app = await model.getApplication(parameters.client_id);
    if (!app || app.redirectUri !== parameters.redirect_uri) {
      throw new HttpError(400, 'Callback does not exactly match an active application', 'invalid_client');
    }
    const destination = callbackUrl(parameters.redirect_uri);
    const returnTo = `/api/sso/authorize?${new URLSearchParams(parameters)}`;
    return { parameters, app, destination, returnTo };
  }
  return {
    // Public display context contains only the registered name/origin, never client-supplied branding.
    loginContext: action(async (req, res) => {
      const { app, destination, returnTo } = await authorizationContext(req.query);
      res.json({ application: { name: app.name, origin: destination.origin }, returnTo });
    }),
    authorize: action(async (req, res) => {
      // Never redirect before validating the exact registered callback, even for login/errors.
      const { parameters, destination, returnTo } = await authorizationContext(req.query);
      const { client_id: applicationId, redirect_uri: redirectUri, state, code_challenge: challenge } = parameters;
      if (!req.identity || req.identity.kind !== 'full' || req.identity.phoneRequired) {
        res.redirect(303, `/login?${new URLSearchParams({ returnTo })}`);
        return;
      }
      let code: string;
      try {
        code = await model.issueAuthorizationCode({ applicationId, redirectUri, challenge,
          sessionId: req.identity.sessionId, userId: req.identity.userId },(conn,event,target,metadata)=>recordAudit(req,event,target,metadata,conn));
      } catch (error) {
        if (!(error instanceof SsoModelError) || error.code !== 'access_denied') throw error;
        await recordAudit(req, 'sso.authorization.failure', applicationId, { failure_reason: 'access_denied' });
        res.redirect(303, `/login?${new URLSearchParams({ returnTo, auth: 'access_denied' })}`);
        return;
      }
      destination.searchParams.set('code', code);
      destination.searchParams.set('state', state);
      res.redirect(303, destination.toString());
    }),

    token: action(async (req, res) => {
      const apiKeyHash = apiKey(req);
      if (req.body?.grant_type !== 'authorization_code') {
        throw new HttpError(400, 'Only the authorization_code grant is supported', 'unsupported_grant_type');
      }
      const { code, redirect_uri: redirectUri, code_verifier: verifier } = parse(exchangeSchema, req.body);
      const token = await model.exchangeAuthorizationCode({ apiKeyHash, codeHash: hashToken(code), redirectUri, verifier },(conn,event,target,metadata)=>recordAudit(req,event,target,metadata,conn));
      res.json({ access_token: token.accessToken, token_type: 'Bearer', expires_in: token.expiresIn, scope: 'identity:read' });
    }),

    introspect: action(async (req, res) => {
      const apiKeyHash = apiKey(req);
      const { token } = parse(introspectionSchema, req.body);
      const tokenHash=hashToken(token);
      res.json(await cache.get(apiKeyHash,tokenHash,()=>model.introspectToken(apiKeyHash,tokenHash)));
    }),

    userinfoOptions: action(async (req, res) => {
      res.vary('Origin');
      res.vary('Access-Control-Request-Method');
      res.vary('Access-Control-Request-Headers');
      const origin = req.get('Origin');
      const requestedHeaders = (req.get('Access-Control-Request-Headers') ?? '')
        .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!origin || req.get('Access-Control-Request-Method') !== 'GET'
        || requestedHeaders.some(header => header !== 'authorization')
        || !await model.isRegisteredOrigin(origin)) {
        throw new HttpError(403, 'Origin or requested operation is not permitted', 'cors_denied');
      }
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization' });
      res.sendStatus(204);
    }),

    userinfo: action(async (req, res) => {
      res.vary('Origin');
      const header = req.get('Authorization');
      const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
      const identity = match ? await model.getUserInfo(hashToken(match[1])) : null;
      if (!identity) {
        res.set('WWW-Authenticate', 'Bearer realm="cusa-sso", error="invalid_token"');
        throw new HttpError(401, 'Valid, active bearer access token required', 'invalid_token');
      }
      const origin = req.get('Origin');
      if (origin && origin !== identity.applicationOrigin) {
        throw new HttpError(403, 'Origin does not match this token application', 'cors_denied');
      }
      if (origin) res.set('Access-Control-Allow-Origin', origin);
      const { applicationOrigin: _applicationOrigin, ...profile } = identity;
      res.json(profile);
    }),
  };
}

export const ssoController = createSsoControllers();
