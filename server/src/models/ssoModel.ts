import { createHash } from 'node:crypto';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { execute, query, transaction } from '../db.js';
import { hashToken, randomToken, safeEqual } from '../services/crypto.js';

export type SsoErrorCode = 'invalid_client' | 'insufficient_scope' | 'invalid_grant' | 'access_denied';
export class SsoModelError extends Error {
  constructor(public readonly code: SsoErrorCode) { super(code); }
}

export interface SsoDatabase {
  query<T>(sql: string, params?: any[], connection?: PoolConnection): Promise<T[]>;
  execute(sql: string, params?: any[], connection?: PoolConnection): Promise<ResultSetHeader>;
  transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T>;
}

export interface Application { id: string; name: string; redirectUri: string }
export interface AuthorizationRequest {
  applicationId: string; sessionId: string; userId: string; redirectUri: string; challenge: string;
}
export interface ExchangeRequest {
  apiKeyHash: string; codeHash: string; redirectUri: string; verifier: string;
}
export interface TokenIdentity {
  sub: string; email: string; name: string; exp: number; aud: string; scope: string;
  given_name: string; family_name: string; department: string; roles: string[];
}
interface TokenRow extends Omit<TokenIdentity, 'roles'> { redirectUri: string; roles: string | string[] }
export type Introspection = { active: false } | ({ active: true } & TokenIdentity);
interface KeyRow { id: string; applicationId: string; scopes: string | string[]; redirectUri: string; expiresAt: number | string | null }
interface CodeRow { userId: string; sessionId: string; redirectUri: string; challenge: string }
export type SsoAuditWriter=(connection:PoolConnection,event:string,target:string,metadata?:unknown)=>Promise<void>;

function hasScope(value: unknown, required: string): boolean {
  try {
    const scopes: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(scopes) && scopes.includes(required);
  } catch { return false; }
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// Column expressions are fixed internally, never supplied by an HTTP request.
function hasAssignedRole(application: string, user: string): string {
  return `EXISTS (SELECT 1 FROM application_member_roles mr JOIN application_roles r
    ON r.id=mr.role_id AND r.application_id=mr.application_id AND r.revoked_at IS NULL
    WHERE mr.application_id=${application} AND mr.user_id=${user})`;
}

// Every token lookup rechecks current account, allowlist, application and MFA session state.
// A deleted session/account and an expired or revoked token therefore fail immediately.
const liveTokenSelect = `
  SELECT u.id AS sub, u.email, COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.name) AS name,
         u.first_name AS given_name, u.last_name AS family_name, m.department,
         COALESCE((SELECT JSON_ARRAYAGG(r.code) FROM application_member_roles mr
           JOIN application_roles r ON r.id=mr.role_id AND r.application_id=mr.application_id AND r.revoked_at IS NULL
           WHERE mr.application_id=t.application_id AND mr.user_id=t.user_id), JSON_ARRAY()) AS roles,
         UNIX_TIMESTAMP(LEAST(t.expires_at, s.expires_at)) AS exp,
         t.application_id AS aud, t.scope, a.redirect_uri AS redirectUri
    FROM access_tokens t
    JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
    JOIN users u ON u.id = t.user_id
    JOIN allowed_emails e ON e.email = u.email
    JOIN applications a ON a.id = t.application_id
    JOIN application_memberships m ON m.application_id=t.application_id AND m.user_id=t.user_id AND m.revoked_at IS NULL
   WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > UTC_TIMESTAMP(3)
     AND s.kind = 'full' AND s.expires_at > UTC_TIMESTAMP(3)
     AND s.authenticated_at IS NOT NULL AND u.deleted_at IS NULL AND a.revoked_at IS NULL
     AND ${hasAssignedRole('t.application_id', 't.user_id')}`;

export function createSsoModel(db: SsoDatabase = { query, execute, transaction }) {
  async function lockApiKey(apiKeyHash: string, scope: string, connection: PoolConnection): Promise<KeyRow> {
    const [key] = await db.query<KeyRow>(`
      SELECT k.id, k.application_id AS applicationId, k.scopes, a.redirect_uri AS redirectUri,
             UNIX_TIMESTAMP(k.expires_at) AS expiresAt
        FROM api_keys k JOIN applications a ON a.id = k.application_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > UTC_TIMESTAMP(3))
         AND a.revoked_at IS NULL
       FOR UPDATE`, [apiKeyHash], connection);
    if (!key) throw new SsoModelError('invalid_client');
    if (!hasScope(key.scopes, scope)) throw new SsoModelError('insufficient_scope');
    return key;
  }

  return {
    async getApplication(id: string): Promise<Application | null> {
      const [app] = await db.query<Application>(
        'SELECT id, name, redirect_uri AS redirectUri FROM applications WHERE id = ? AND revoked_at IS NULL', [id]);
      return app ?? null;
    },

    async isRegisteredOrigin(origin: string): Promise<boolean> {
      const apps = await db.query<{ redirectUri: string }>(
        'SELECT redirect_uri AS redirectUri FROM applications WHERE revoked_at IS NULL');
      return apps.some(app => {
        try { return new URL(app.redirectUri).origin === origin; } catch { return false; }
      });
    },

    async issueAuthorizationCode(input: AuthorizationRequest,record?:SsoAuditWriter): Promise<string> {
      return db.transaction(async (connection) => {
        // Revalidate inside the transaction, including the identity supplied by middleware.
        const [live] = await db.query<{ id: string }>(`
          SELECT a.id FROM applications a
          JOIN sessions s ON s.id = ? AND s.user_id = ?
          JOIN users u ON u.id = s.user_id
          JOIN allowed_emails e ON e.email = u.email
          JOIN application_memberships m ON m.application_id=a.id AND m.user_id=u.id AND m.revoked_at IS NULL
          WHERE a.id = ? AND BINARY a.redirect_uri = BINARY ? AND a.revoked_at IS NULL
            AND s.kind = 'full' AND s.authenticated_at IS NOT NULL
            AND s.expires_at > UTC_TIMESTAMP(3) AND u.deleted_at IS NULL
            AND ${hasAssignedRole('a.id', 'u.id')}
          FOR UPDATE`, [input.sessionId, input.userId, input.applicationId, input.redirectUri], connection);
        if (!live) throw new SsoModelError('access_denied');
        const code = randomToken();
        await db.execute(`
          INSERT INTO authorization_codes
            (code_hash, application_id, user_id, session_id, redirect_uri, code_challenge, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 90 SECOND))`,
        [hashToken(code), input.applicationId, input.userId, input.sessionId, input.redirectUri, input.challenge], connection);
        await record?.(connection,'sso.code.issue',input.applicationId,{userId:input.userId,sessionId:input.sessionId});
        return code;
      });
    },

    async exchangeAuthorizationCode(input: ExchangeRequest,record?:SsoAuditWriter): Promise<{ accessToken: string; expiresIn: number }> {
      return db.transaction(async (connection) => {
        const key = await lockApiKey(input.apiKeyHash, 'identity:read', connection);
        const [code] = await db.query<CodeRow>(`
          SELECT c.user_id AS userId, c.session_id AS sessionId,
                 c.redirect_uri AS redirectUri, c.code_challenge AS challenge
            FROM authorization_codes c
            JOIN sessions s ON s.id = c.session_id AND s.user_id = c.user_id
            JOIN users u ON u.id = c.user_id
            JOIN allowed_emails e ON e.email = u.email
            JOIN application_memberships m ON m.application_id=c.application_id AND m.user_id=u.id AND m.revoked_at IS NULL
           WHERE c.code_hash = ? AND c.application_id = ?
             AND c.consumed_at IS NULL AND c.expires_at > UTC_TIMESTAMP(3)
             AND s.kind = 'full' AND s.authenticated_at IS NOT NULL
             AND s.expires_at > UTC_TIMESTAMP(3) AND u.deleted_at IS NULL
             AND ${hasAssignedRole('c.application_id', 'c.user_id')}
           FOR UPDATE`, [input.codeHash, key.applicationId], connection);
        if (!code || code.redirectUri !== input.redirectUri || key.redirectUri !== input.redirectUri
          || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)
          || !safeEqual(pkceChallenge(input.verifier), code.challenge)) {
          throw new SsoModelError('invalid_grant');
        }
        const consumed = await db.execute(`
          UPDATE authorization_codes SET consumed_at = UTC_TIMESTAMP(3)
          WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`, [input.codeHash], connection);
        if (consumed.affectedRows !== 1) throw new SsoModelError('invalid_grant');
        const token = randomToken();
        await db.execute(`
          INSERT INTO access_tokens
            (token_hash, application_id, user_id, session_id, scope, expires_at)
          VALUES (?, ?, ?, ?, 'identity:read', DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 300 SECOND))`,
        [hashToken(token), key.applicationId, code.userId, code.sessionId], connection);
        await db.execute('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP(3) WHERE id = ?', [key.id], connection);
        await record?.(connection,'sso.token.issue',key.applicationId,{userId:code.userId,sessionId:code.sessionId,apiKeyId:key.id});
        return { accessToken: token, expiresIn: 300 };
      });
    },

    async introspectToken(apiKeyHash: string, tokenHash: string): Promise<Introspection> {
      // One consistent statement; no row locks or last_used_at writes on this hot path.
      const [row] = await db.query<TokenRow & {keyScopes:string|string[];keyExpiresAt:number|null}>(`
        SELECT identity.*, k.scopes AS keyScopes, UNIX_TIMESTAMP(k.expires_at) AS keyExpiresAt
        FROM api_keys k JOIN applications app ON app.id=k.application_id
        LEFT JOIN (${liveTokenSelect}) identity ON identity.aud=k.application_id
        WHERE k.key_hash=? AND k.revoked_at IS NULL AND app.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>UTC_TIMESTAMP(3))`,[tokenHash,apiKeyHash]);
      if(!row) throw new SsoModelError('invalid_client');
      if(!hasScope(row.keyScopes,'token:introspect')) throw new SsoModelError('insufficient_scope');
      if(!row.sub || !row.scope.split(' ').includes('identity:read')) return {active:false};
      return {active:true,sub:row.sub,email:row.email,name:row.name,
        given_name:row.given_name,family_name:row.family_name,department:row.department,
        roles:typeof row.roles==='string'?JSON.parse(row.roles) as string[]:row.roles,
        aud:row.aud,scope:row.scope,exp:Math.floor(Math.min(Number(row.exp),row.keyExpiresAt===null?Infinity:Number(row.keyExpiresAt)))};
    },

    async getUserInfo(tokenHash: string): Promise<(Omit<TokenIdentity, 'exp' | 'scope'> & { email_verified: true; applicationOrigin: string }) | null> {
      const [token] = await db.query<TokenRow>(liveTokenSelect, [tokenHash]);
      if (!token || !token.scope.split(' ').includes('identity:read')) return null;
      return { sub: token.sub, email: token.email, name: token.name, email_verified: true,
        given_name: token.given_name, family_name: token.family_name, department: token.department, aud: token.aud,
        roles: typeof token.roles === 'string' ? JSON.parse(token.roles) as string[] : token.roles,
        applicationOrigin: new URL(token.redirectUri).origin };
    },
  };
}

export const ssoModel = createSsoModel();
export type SsoModel = ReturnType<typeof createSsoModel>;
