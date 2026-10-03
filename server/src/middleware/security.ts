import type { Request, Response, NextFunction } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { config } from '../config.js';
import { hashToken, safeEqual } from '../services/crypto.js';
import { findSession, recordAudit, isMfaLocked } from '../models/authModel.js';
import { auditContext, rateIp } from './requestContext.js';
import { sharedRateLimit } from '../services/rateLimitStore.js';
import { hasAdminMfa, isFreshStrongMfa } from '../services/mfaPolicy.js';

export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export const sessionCookie = config.secureCookies ? '__Host-cusa_session' : 'cusa_session';
export const flowCookie = config.secureCookies ? '__Host-cusa_flow' : 'cusa_flow';
export const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/' };
export async function attachIdentity(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookie];
  if (config.configured && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) req.identity = await findSession(token);
  next();
}
export function requireConfigured(_req: Request, _res: Response, next: NextFunction) {
  if (!config.configured) throw new HttpError(503, 'ตั้งค่า Google Login, Gmail, ฐานข้อมูล และ encryption keys ก่อนใช้งาน', 'SETUP_REQUIRED');
  next();
}
export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (!req.identity) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED'); next();
}
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.identity) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED');
  if (req.identity.phoneRequired && req.identity.kind === 'full') throw new HttpError(403, 'Please verify your phone number', 'PHONE_REQUIRED');
  if (req.identity.kind !== 'full') throw new HttpError(403, 'กรุณายืนยันรหัส OTP หรือ Authenticator', 'MFA_REQUIRED'); next();
}
export function requireFullSession(req:Request,_res:Response,next:NextFunction){
  if(!req.identity || req.identity.kind!=='full')throw new HttpError(403,'กรุณายืนยัน MFA ก่อนดำเนินการ','MFA_REQUIRED');
  next();
}
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.identity?.kind !== 'full' || req.identity.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ', 'FORBIDDEN');
  if (!hasAdminMfa(req.identity)) throw new HttpError(403,'ผู้ดูแลต้องตั้งค่า MFA และยืนยันด้วย Passkey หรือ Authenticator ก่อนใช้งาน','ADMIN_MFA_REQUIRED');
  next();
}
export function requireRecentAdminMfa(req:Request,res:Response,next:NextFunction) {
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  return requireFreshMfa(req,res,next);
}
export function requireFreshMfa(req:Request,_res:Response,next:NextFunction) {
  if (req.identity?.kind !== 'full' || !isFreshStrongMfa(req.identity.mfaMethod,req.identity.authenticatedAt)) {
    throw new HttpError(403,'กรุณายืนยัน Passkey หรือ Authenticator อีกครั้งก่อนดำเนินรายการสำคัญ','MFA_REAUTH_REQUIRED');
  }
  next();
}
export async function requireUnlocked(req:Request,_res:Response,next:NextFunction) {
  if (req.identity && await isMfaLocked(req.identity.userId)) throw new HttpError(429,'บัญชีถูกพักการยืนยันชั่วคราว กรุณารอ 15 นาที','ACCOUNT_LOCKED'); next();
}
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  if (['/sso/token','/sso/introspect','/sso/revoke'].includes(req.path)) return next();
  const token = req.get('X-CSRF-Token');
  if (req.get('Origin') !== config.appOrigin || !req.identity || !token || !safeEqual(token,req.identity.csrfToken)) throw new HttpError(403, 'คำขอไม่ผ่านการตรวจสอบ CSRF', 'CSRF_REJECTED');
  next();
}
export function rateLimit(bucket: string, limit: number, seconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!config.configured) return next();
    const keys = [`${bucket}:ip:${rateIp(req)}`];
    if (req.identity) keys.push(`${bucket}:user:${req.identity.userId}`);
    for (const key of keys) {
      let allowed: boolean;
      try { allowed = await sharedRateLimit(hashToken(key),limit,seconds); }
      catch { throw new HttpError(503,'ระบบจำกัดคำขอไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง','RATE_LIMIT_UNAVAILABLE'); }
      if (!allowed) {
        res.setHeader('Retry-After',seconds); throw new HttpError(429,'ทำรายการบ่อยเกินไป กรุณารอสักครู่','RATE_LIMITED');
      }
    }
    next();
  };
}
export async function audit(req: Request, event: string, target?: string, metadata?: unknown, connection?: PoolConnection) {
  event=event.replace(/\.failed$/,'.failure');
  const status=event.endsWith('.failure')?'failure':'success';
  await recordAudit({actorId:req.identity?.userId ?? null,actorEmail:req.identity?.email ?? null,sessionId:req.identity?.sessionId ?? null,userAgent:(req.get('user-agent') ?? '').slice(0,512),status,event,target:target ?? null,...auditContext(req),metadata},connection);
  req.auditRecorded=true;
}
