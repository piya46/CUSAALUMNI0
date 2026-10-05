import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import type { SsoDatabase, SsoAuditWriter, AuthorizationRequest } from './ssoModel.js';
import { SsoModelError } from '../services/ssoErrors.js';
import { hashToken, randomToken } from '../services/crypto.js';
import { consentNoticeVersion, scopesWithin, scopeDescriptions, type ClaimScope } from '../services/claimScopes.js';
import { serviceRequirementsSql, pendingMembershipSql } from '../services/servicePolicy.js';

type RequestPayload = { redirectUri: string; challenge: string; state: string };
type ConsentRow = {
  id: string; application_id: string; user_id: string; session_id: string; request_payload: string | RequestPayload;
  requested_scope: string; granted_scope: string | null; policy_version: number; notice_version: string;
  purpose: string; name: string; redirect_uri: string; allowed_claim_scopes: string; sharing_version: number;
  mfa_method: string; authenticated_at: Date; decided_at: Date | null; revoked_at: Date | null;
  required_scopes: string; enrollment: string; default_role_id: string|null;
};
const payload = (row: ConsentRow): RequestPayload => typeof row.request_payload === 'string' ? JSON.parse(row.request_payload) : row.request_payload;
// Both the displayed consent and the final approval must still belong to the
// current full session, account, membership, application and policy revision.
const liveConsent = `SELECT c.*, a.name, a.redirect_uri, a.allowed_claim_scopes, a.sharing_version,
 policy.required_scopes,policy.default_role_id,m.enrollment
 FROM sso_consents c JOIN applications a ON a.id=c.application_id AND a.revoked_at IS NULL
 JOIN application_access_policies policy ON policy.application_id=a.id
 JOIN sessions s ON s.id=c.session_id AND s.user_id=c.user_id
 JOIN users u ON u.id=c.user_id JOIN sso_login_accounts e ON e.email=u.email
 JOIN application_memberships m ON m.application_id=a.id AND m.user_id=u.id AND m.revoked_at IS NULL
 WHERE c.request_hash=? AND c.session_id=? AND c.user_id=? AND c.decided_at IS NULL
 AND c.expires_at>UTC_TIMESTAMP(3) AND c.revoked_at IS NULL AND c.policy_version=a.sharing_version
 AND s.kind='full' AND s.authenticated_at IS NOT NULL AND s.expires_at>UTC_TIMESTAMP(3) AND u.deleted_at IS NULL
 AND (u.phone_required=FALSE OR EXISTS(SELECT 1 FROM phone_identities p WHERE p.user_id=u.id))
 AND ${serviceRequirementsSql()}
 AND (${pendingMembershipSql()} OR (m.enrollment='active' AND EXISTS(SELECT 1 FROM application_member_roles mr JOIN application_roles r
 ON r.id=mr.role_id AND r.application_id=mr.application_id AND r.revoked_at IS NULL
 WHERE mr.application_id=a.id AND mr.user_id=u.id)))`;

export function createConsentModel(db: SsoDatabase) {
  async function pending(request: string, sessionId: string, userId: string, connection?: PoolConnection) {
    const [row] = await db.query<ConsentRow>(liveConsent + (connection ? ' FOR UPDATE' : ''),
      [hashToken(request), sessionId, userId], connection);
    if (!row || payload(row).redirectUri !== row.redirect_uri || !scopesWithin(row.requested_scope, row.allowed_claim_scopes))
      throw new SsoModelError('access_denied');
    return row;
  }
  return {
    async beginAuthorization(input: AuthorizationRequest & { state: string; scope: string }, record?: SsoAuditWriter) {
      return db.transaction(async connection => {
        const [app] = await db.query<{ id: string; allowed_claim_scopes: string; sharing_purpose: string; sharing_version: number;required_scopes:string }>(`
          SELECT a.id,a.allowed_claim_scopes,a.sharing_purpose,a.sharing_version,policy.required_scopes FROM applications a
          JOIN application_access_policies policy ON policy.application_id=a.id
          JOIN sessions s ON s.id=? AND s.user_id=? JOIN users u ON u.id=s.user_id
          JOIN sso_login_accounts e ON e.email=u.email
          JOIN application_memberships m ON m.application_id=a.id AND m.user_id=u.id AND m.revoked_at IS NULL
          WHERE a.id=? AND BINARY a.redirect_uri=BINARY ? AND a.revoked_at IS NULL
          AND s.kind='full' AND s.authenticated_at IS NOT NULL AND s.expires_at>UTC_TIMESTAMP(3) AND u.deleted_at IS NULL
          AND (u.phone_required=FALSE OR EXISTS(SELECT 1 FROM phone_identities p WHERE p.user_id=u.id))
          AND ${serviceRequirementsSql()}
          AND (${pendingMembershipSql()} OR (m.enrollment='active' AND EXISTS(SELECT 1 FROM application_member_roles mr JOIN application_roles r
            ON r.id=mr.role_id AND r.application_id=mr.application_id AND r.revoked_at IS NULL
            WHERE mr.application_id=a.id AND mr.user_id=u.id))) FOR UPDATE`,
          [input.sessionId,input.userId,input.applicationId,input.redirectUri],connection);
        if (!app) throw new SsoModelError('access_denied');
        if (!scopesWithin(input.scope,app.allowed_claim_scopes)) throw new SsoModelError('invalid_scope');
        if (!scopesWithin(app.required_scopes,input.scope)) throw new SsoModelError('invalid_scope');
        const request=randomToken(),id=randomUUID();
        await db.execute(`INSERT INTO sso_consents (id,request_hash,application_id,user_id,session_id,
          request_payload,requested_scope,policy_version,notice_version,purpose,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))`,
          [id,hashToken(request),input.applicationId,input.userId,input.sessionId,
            JSON.stringify({redirectUri:input.redirectUri,challenge:input.challenge,state:input.state}),
            input.scope,app.sharing_version,consentNoticeVersion,app.sharing_purpose],connection);
        await record?.(connection,'sso.consent.requested',input.applicationId,{consentId:id,scopes:input.scope.split(' '),noticeVersion:consentNoticeVersion});
        return request;
      });
    },
    async consentContext(request: string, sessionId: string, userId: string) {
      const row = await pending(request,sessionId,userId);
      return { application:{name:row.name,origin:new URL(row.redirect_uri).origin}, purpose:row.purpose,
        noticeVersion:row.notice_version, policyVersion:row.policy_version,
        scopes:row.requested_scope.split(' ').map(value=>({scope:value,required:row.required_scopes.split(' ').includes(value),...scopeDescriptions[value as ClaimScope]})) };
    },
    async decideConsent(request: string, sessionId: string, userId: string, approved: boolean, scopes: string[], record?: SsoAuditWriter) {
      return db.transaction(async connection => {
        const row = await pending(request,sessionId,userId,connection), saved=payload(row);
        const destination = new URL(saved.redirectUri);
        // Never preserve stale OAuth result parameters already present on a callback URL.
        destination.searchParams.delete('code'); destination.searchParams.delete('error');
        destination.searchParams.delete('error_description'); destination.searchParams.set('state',saved.state);
        if (!approved) {
          if (scopes.length) throw new SsoModelError('invalid_scope');
          await db.execute('UPDATE sso_consents SET decided_at=UTC_TIMESTAMP(3),revoked_at=UTC_TIMESTAMP(3),expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE id=?',[row.id],connection);
          await record?.(connection,'sso.consent.denied',row.application_id,{consentId:row.id,noticeVersion:row.notice_version});
          destination.searchParams.set('error','access_denied'); return {redirectTo:destination.toString()};
        }
        const granted=scopes.join(' ');
        if (!scopesWithin(granted,row.requested_scope)) throw new SsoModelError('invalid_scope');
        if (!scopesWithin(row.required_scopes,granted)) throw new SsoModelError('invalid_scope');
        if(row.enrollment==='pending'){
          const [role]=await db.query<{id:string;code:string}>('SELECT id,code FROM application_roles WHERE id=? AND application_id=? AND revoked_at IS NULL FOR UPDATE',[row.default_role_id,row.application_id],connection);
          if(!role||/^(admin|administrator|owner|superadmin|root)$/i.test(role.code))throw new SsoModelError('access_denied');
          await db.execute('INSERT INTO application_member_roles(application_id,user_id,role_id) VALUES (?,?,?)',[row.application_id,userId,role.id],connection);
          await db.execute("UPDATE application_memberships SET enrollment='active',pending_until=NULL WHERE application_id=? AND user_id=?",[row.application_id,userId],connection);
          await record?.(connection,'service.registration.completed',row.application_id,{userId});
        }
        await db.execute('UPDATE application_memberships SET last_activity_at=UTC_TIMESTAMP(3) WHERE application_id=? AND user_id=?',[row.application_id,userId],connection);
        const [session]=await db.query<{mfa_method:string;authenticated_at:Date}>(
          'SELECT mfa_method,authenticated_at FROM sessions WHERE id=? AND user_id=? FOR UPDATE',[sessionId,userId],connection);
        if(!session?.mfa_method || !session.authenticated_at)throw new SsoModelError('access_denied');
        // Once decided, expires_at becomes the indexed retention deadline. Pending
        // requests still expire in 10 minutes; approved grants cannot be reused.
        await db.execute(`UPDATE sso_consents SET granted_scope=?,mfa_method=?,authenticated_at=?,decided_at=UTC_TIMESTAMP(3),expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 90 DAY)
          WHERE id=? AND decided_at IS NULL`,[granted,session.mfa_method,session.authenticated_at,row.id],connection);
        const code=randomToken();
        await db.execute(`INSERT INTO authorization_codes
          (code_hash,application_id,user_id,session_id,redirect_uri,code_challenge,consent_id,expires_at)
          VALUES (?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 90 SECOND))`,
          [hashToken(code),row.application_id,userId,sessionId,saved.redirectUri,saved.challenge,row.id],connection);
        await record?.(connection,'sso.consent.approved',row.application_id,{consentId:row.id,scopes,
          noticeVersion:row.notice_version,policyVersion:row.policy_version});
        await record?.(connection,'sso.code.issue',row.application_id,{consentId:row.id,userId,sessionId});
        destination.searchParams.set('code',code);return {redirectTo:destination.toString()};
      });
    },
    async listConsents(userId: string) {
      return db.query<{id:string;name:string;scope:string;approvedAt:Date}>(`SELECT c.id,a.name,c.granted_scope AS scope,c.decided_at AS approvedAt
        FROM sso_consents c JOIN applications a ON a.id=c.application_id AND a.revoked_at IS NULL
        WHERE c.user_id=? AND c.granted_scope IS NOT NULL AND c.revoked_at IS NULL AND c.policy_version=a.sharing_version
        AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=c.session_id AND s.user_id=c.user_id AND s.expires_at>UTC_TIMESTAMP(3))
        ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,[userId]);
    },
    async revokeConsent(id: string, userId: string, record?: SsoAuditWriter) {
      await db.transaction(async connection=>{
        const [row]=await db.query<{application_id:string}>('SELECT application_id FROM sso_consents WHERE id=? AND user_id=? AND granted_scope IS NOT NULL FOR UPDATE',[id,userId],connection);
        if(!row)throw new SsoModelError('access_denied');
        await db.execute('UPDATE sso_consents SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?',[id],connection);
        await record?.(connection,'sso.consent.revoked',row.application_id,{consentId:id});
      });
    },
  };
}
