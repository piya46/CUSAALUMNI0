import type { Request, Response } from 'express';
import { z } from 'zod';
import { transaction, query, execute } from '../db.js';
import { hashToken } from '../services/crypto.js';
import { audit, HttpError } from '../middleware/security.js';

// Revoke this app's grants for the session identified by its own bearer token.
// Never accept a global session ID/user ID or terminate another app's session.
export async function revokeServiceSession(req: Request, res: Response) {
  const { token } = z.object({token:z.string().min(1).max(512)}).strict().parse(req.body);
  await transaction(async connection => {
    const [key] = await query<{scopes:string|string[]}>(`SELECT k.scopes FROM api_keys k
      JOIN applications a ON a.id=k.application_id WHERE k.id=? AND k.application_id=?
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>UTC_TIMESTAMP(3))
      AND a.revoked_at IS NULL FOR UPDATE`, [req.service!.apiKeyId, req.service!.applicationId], connection);
    const scopes = key && (typeof key.scopes==='string'?JSON.parse(key.scopes):key.scopes);
    if (!Array.isArray(scopes) || !scopes.includes('token:revoke')) throw new HttpError(401,'Invalid service credential','invalid_client');
    let [grant] = await query<{sessionId:string}>(`SELECT session_id AS sessionId FROM access_tokens
      WHERE token_hash=? AND application_id=? FOR UPDATE`, [hashToken(token),req.service!.applicationId], connection);
    if(!grant)[grant]=await query<{sessionId:string}>(`SELECT f.session_id AS sessionId FROM refresh_tokens r
      JOIN sso_refresh_families f ON f.id=r.family_id WHERE r.token_hash=? AND f.application_id=? FOR UPDATE`,
      [hashToken(token),req.service!.applicationId],connection);
    if (!grant) return;
    await execute('UPDATE sso_refresh_families SET revoked_at=UTC_TIMESTAMP(3) WHERE application_id=? AND session_id=? AND revoked_at IS NULL', [req.service!.applicationId,grant.sessionId], connection);
    await execute('UPDATE access_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE application_id=? AND session_id=? AND revoked_at IS NULL', [req.service!.applicationId,grant.sessionId], connection);
    await execute('DELETE FROM authorization_codes WHERE application_id=? AND session_id=?', [req.service!.applicationId,grant.sessionId], connection);
    await audit(req,'sso.session.revoked',req.service!.applicationId,{scope:'application_session'},connection);
  });
  // Unknown and cross-application tokens receive the same result; no token oracle.
  res.set('Cache-Control','no-store').json({ok:true});
}
