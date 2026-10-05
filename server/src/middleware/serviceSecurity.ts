import type { RequestHandler } from 'express';
import { findServiceCredential } from '../models/serviceCredentialModel.js';
import { hashToken } from '../services/crypto.js';
import { sharedRateLimit } from '../services/rateLimitStore.js';
import { HttpError } from './security.js';

export function requireService(scope:'identity:read'|'token:introspect'|'token:revoke'|'member:activity'):RequestHandler {
  return async(req,res,next)=>{
    const raw=req.get('X-API-Key');
    if(!raw || !/^[A-Za-z0-9_.~-]{32,256}$/.test(raw)) throw new HttpError(401,'Valid API key required','invalid_client');
    const key=await findServiceCredential(hashToken(raw));
    if(!key) throw new HttpError(401,'Invalid API key','invalid_client');
    const scopes=typeof key.scopes==='string'?JSON.parse(key.scopes):key.scopes;
    if(!Array.isArray(scopes)||!scopes.includes(scope)) throw new HttpError(403,'Insufficient scope','insufficient_scope');
    req.service={applicationId:key.applicationId,apiKeyId:key.id};
    for(const [bucket,limit] of [[`service:app:${key.applicationId}`,3000],[`service:key:${key.id}`,1500]] as const) {
      let allowed:boolean;
      try { allowed=await sharedRateLimit(hashToken(bucket),limit,60); }
      catch { throw new HttpError(503,'Rate limit store unavailable','RATE_LIMIT_UNAVAILABLE'); }
      if(!allowed) {res.setHeader('Retry-After',60);throw new HttpError(429,'Service request quota exceeded','RATE_LIMITED');}
    }
    next();
  };
}
