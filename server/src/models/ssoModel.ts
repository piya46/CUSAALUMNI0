import { createHash } from 'node:crypto';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { execute, query, transaction } from '../db.js';
import { hashToken, randomToken, safeEqual, unseal } from '../services/crypto.js';

import { createConsentModel } from './consentModel.js';
import { config } from '../config.js';
import { normalizePhone, scopesWithin } from '../services/claimScopes.js';
import { SsoModelError } from '../services/ssoErrors.js';
export { SsoModelError, type SsoErrorCode } from '../services/ssoErrors.js';

export interface SsoDatabase {
  query<T>(sql: string, params?: any[], connection?: PoolConnection): Promise<T[]>;
  execute(sql: string, params?: any[], connection?: PoolConnection): Promise<ResultSetHeader>;
  transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T>;
}

export interface Application { id: string; name: string; redirectUri: string; allowedScope: string }
export interface AuthorizationRequest {
  applicationId: string; sessionId: string; userId: string; redirectUri: string; challenge: string;
}
export interface ExchangeRequest {
  apiKeyHash: string; codeHash: string; redirectUri: string; verifier: string;
}
export interface TokenIdentity {
  sub: string; aud: string; roles: string[]; scope: string; exp: number;
  email?: string; email_verified?: true; name?: string; given_name?: string; family_name?: string;
  department?: string; picture?: string | null;
  phone_number?: string; phone_number_verified?: boolean; phone_number_verified_at?: number;
  line?: { linked: boolean; user_id?: string; login_channel_id?: string };
  authentication?: { primary_method: 'google'; second_step_method: string; verified_at: number;
    assurance: string; phishing_resistant: boolean };
}
interface TokenRow {
  sub: string; aud: string; roles: string | string[]; scope: string; exp: number;
  email: string; name: string; given_name: string; family_name: string; department: string; picture: string | null;
  redirectUri: string; allowedScope: string; phoneEncrypted: string | null; phoneHash: string | null;
  phoneVerifiedAt: number | null; lineEncrypted: string | null; mfaMethod: string; authTime: number;
}
export type Introspection = { active: false } | ({ active: true } & TokenIdentity);
interface KeyRow { id: string; applicationId: string; scopes: string | string[]; redirectUri: string; expiresAt: number | string | null }
interface CodeRow { userId: string; sessionId: string; redirectUri: string; challenge: string; consentId: string; scope: string; allowedScope: string }
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
         u.first_name AS given_name, u.last_name AS family_name, m.department, u.avatar AS picture,
         p.phone_encrypted AS phoneEncrypted, p.phone_hash AS phoneHash, UNIX_TIMESTAMP(p.verified_at) AS phoneVerifiedAt,
         l.subject_encrypted AS lineEncrypted, consent.mfa_method AS mfaMethod,
         UNIX_TIMESTAMP(consent.authenticated_at) AS authTime, a.allowed_claim_scopes AS allowedScope,
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
    JOIN sso_consents consent ON consent.id=t.consent_id AND consent.application_id=t.application_id
      AND consent.user_id=t.user_id AND consent.session_id=t.session_id AND consent.revoked_at IS NULL
      AND consent.decided_at IS NOT NULL AND consent.granted_scope=t.scope AND consent.policy_version=a.sharing_version
    LEFT JOIN phone_identities p ON p.user_id=u.id
    LEFT JOIN line_identities l ON l.user_id=u.id
    JOIN application_memberships m ON m.application_id=t.application_id AND m.user_id=t.user_id AND m.revoked_at IS NULL
   WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > UTC_TIMESTAMP(3)
     AND s.kind = 'full' AND s.expires_at > UTC_TIMESTAMP(3)
     AND s.authenticated_at IS NOT NULL AND u.deleted_at IS NULL AND (u.phone_required=FALSE OR EXISTS(SELECT 1 FROM phone_identities p WHERE p.user_id=u.id)) AND a.revoked_at IS NULL
     AND ${hasAssignedRole('t.application_id', 't.user_id')}`;

// Shared projection makes userinfo and introspection obey exactly the same consent.
function profileClaims(row: TokenRow): Omit<TokenIdentity,'exp'|'scope'> {
  const scopes=row.scope.split(' ');
  const result:Omit<TokenIdentity,'exp'|'scope'>={sub:row.sub,aud:row.aud,
    roles:typeof row.roles==='string'?JSON.parse(row.roles):row.roles};
  if(scopes.includes('profile'))Object.assign(result,{name:row.name,given_name:row.given_name,family_name:row.family_name,
    department:row.department,picture:row.picture?.startsWith('https://')?row.picture:null});
  if(scopes.includes('email'))Object.assign(result,{email:row.email,email_verified:true});
  if(scopes.includes('phone'))Object.assign(result,row.phoneEncrypted?{phone_number:unseal(row.phoneEncrypted),
    phone_number_verified:true,phone_number_verified_at:Math.floor(Number(row.phoneVerifiedAt))}:{phone_number_verified:false});
  if(scopes.includes('line'))result.line=row.lineEncrypted?{linked:true,user_id:unseal(row.lineEncrypted),login_channel_id:config.lineLoginChannelId}:{linked:false};
  if(scopes.includes('assurance'))result.authentication={primary_method:'google',second_step_method:row.mfaMethod,
    verified_at:Math.floor(Number(row.authTime)),phishing_resistant:row.mfaMethod==='passkey',
    assurance:['totp','passkey'].includes(row.mfaMethod)?'cusa:strong':row.mfaMethod==='recovery'?'cusa:recovery':'cusa:standard'};
  return result;
}

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
    ...createConsentModel(db),
    async getApplication(id: string): Promise<Application | null> {
      const [app] = await db.query<Application>(
        'SELECT id, name, redirect_uri AS redirectUri, allowed_claim_scopes AS allowedScope FROM applications WHERE id = ? AND revoked_at IS NULL', [id]);
      return app ?? null;
    },

    async isRegisteredOrigin(origin: string): Promise<boolean> {
      const apps = await db.query<{ redirectUri: string }>(
        'SELECT redirect_uri AS redirectUri FROM applications WHERE revoked_at IS NULL');
      return apps.some(app => {
        try { return new URL(app.redirectUri).origin === origin; } catch { return false; }
      });
    },

    async exchangeAuthorizationCode(input: ExchangeRequest,record?:SsoAuditWriter): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
      return db.transaction(async (connection) => {
        const key = await lockApiKey(input.apiKeyHash, 'identity:read', connection);
        const [code] = await db.query<CodeRow>(`
          SELECT c.user_id AS userId, c.session_id AS sessionId,
                 c.redirect_uri AS redirectUri, c.code_challenge AS challenge, consent.id AS consentId,
                 consent.granted_scope AS scope, a.allowed_claim_scopes AS allowedScope
            FROM authorization_codes c
            JOIN applications a ON a.id=c.application_id AND a.revoked_at IS NULL
            JOIN sso_consents consent ON consent.id=c.consent_id AND consent.application_id=c.application_id
              AND consent.user_id=c.user_id AND consent.session_id=c.session_id AND consent.revoked_at IS NULL
              AND consent.decided_at IS NOT NULL AND consent.granted_scope IS NOT NULL AND consent.policy_version=a.sharing_version
            JOIN sessions s ON s.id = c.session_id AND s.user_id = c.user_id
            JOIN users u ON u.id = c.user_id
            JOIN allowed_emails e ON e.email = u.email
            JOIN application_memberships m ON m.application_id=c.application_id AND m.user_id=u.id AND m.revoked_at IS NULL
           WHERE c.code_hash = ? AND c.application_id = ?
             AND c.consumed_at IS NULL AND c.expires_at > UTC_TIMESTAMP(3)
             AND s.kind = 'full' AND s.authenticated_at IS NOT NULL
             AND s.expires_at > UTC_TIMESTAMP(3) AND u.deleted_at IS NULL AND (u.phone_required=FALSE OR EXISTS(SELECT 1 FROM phone_identities p WHERE p.user_id=u.id))
             AND ${hasAssignedRole('c.application_id', 'c.user_id')}
           FOR UPDATE`, [input.codeHash, key.applicationId], connection);
        if (!code || !scopesWithin(code.scope,code.allowedScope) || code.redirectUri !== input.redirectUri || key.redirectUri !== input.redirectUri
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
            (token_hash, application_id, user_id, session_id, scope, consent_id, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 300 SECOND))`,
        [hashToken(token), key.applicationId, code.userId, code.sessionId, code.scope, code.consentId], connection);
        await db.execute('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP(3) WHERE id = ?', [key.id], connection);
        await record?.(connection,'sso.token.issue',key.applicationId,{userId:code.userId,sessionId:code.sessionId,apiKeyId:key.id});
        return { accessToken: token, expiresIn: 300, scope: code.scope };
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
      if(!row.sub || !scopesWithin(row.scope,row.allowedScope)) return {active:false};
      return {active:true,...profileClaims(row),scope:row.scope,
        exp:Math.floor(Math.min(Number(row.exp),row.keyExpiresAt===null?Infinity:Number(row.keyExpiresAt)))};
    },

    async getUserInfo(tokenHash: string): Promise<(Omit<TokenIdentity, 'exp'> & { applicationOrigin: string }) | null> {
      const [token] = await db.query<TokenRow>(liveTokenSelect, [tokenHash]);
      if (!token || !scopesWithin(token.scope,token.allowedScope)) return null;
      return { ...profileClaims(token), scope: token.scope, applicationOrigin: new URL(token.redirectUri).origin };
    },

    async matchPhone(apiKeyHash: string, tokenHash: string, phone: string) {
      // No profile/phone disclosure to other applications, and no introspection cache.
      const [row]=await db.query<TokenRow & {keyScopes:string|string[]}>(`
        SELECT identity.*,k.scopes AS keyScopes FROM api_keys k JOIN applications a ON a.id=k.application_id
        LEFT JOIN (${liveTokenSelect}) identity ON identity.aud=k.application_id
        WHERE k.key_hash=? AND k.revoked_at IS NULL AND a.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>UTC_TIMESTAMP(3))`,[tokenHash,apiKeyHash]);
      if(!row)throw new SsoModelError('invalid_client');
      if(!hasScope(row.keyScopes,'identity:read'))throw new SsoModelError('insufficient_scope');
      if(!row.sub || !scopesWithin(row.scope,row.allowedScope))throw new SsoModelError('invalid_grant');
      if(!row.scope.split(' ').includes('phone:match'))throw new SsoModelError('insufficient_scope');
      const normalized=normalizePhone(phone);
      if(!normalized)throw new SsoModelError('invalid_grant');
      if(!row.phoneHash)return {status:'unverified' as const,match:null,phone_number_verified:false};
      return {status:safeEqual(row.phoneHash,hashToken(`phone:${normalized}`))?'matched' as const:'mismatch' as const,
        match:safeEqual(row.phoneHash,hashToken(`phone:${normalized}`)),phone_number_verified:true,
        phone_number_verified_at:Math.floor(Number(row.phoneVerifiedAt))};
    },
  };
}

export const ssoModel = createSsoModel();
export type SsoModel = ReturnType<typeof createSsoModel>;
