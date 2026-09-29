import { query } from '../db.js';
export async function findServiceCredential(keyHash:string) {
  const [key]=await query<{id:string;applicationId:string;scopes:string|string[]}>(`SELECT k.id,k.application_id AS applicationId,k.scopes
    FROM api_keys k JOIN applications a ON a.id=k.application_id WHERE k.key_hash=?
    AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>UTC_TIMESTAMP(3)) AND a.revoked_at IS NULL`,[keyHash]);
  return key;
}
