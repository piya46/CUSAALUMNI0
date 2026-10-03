import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { cookieOptions, HttpError, audit } from '../middleware/security.js';
import { rateIp } from '../middleware/requestContext.js';
import { queueApplication, queueSettingsSchema, updateQueueSettings } from '../models/waitingRoomModel.js';
import { randomToken } from '../services/crypto.js';
import { parseAuthorizationReturnTo } from '../services/authorizationRequest.js';
import { visitQueue } from '../services/waitingRoom.js';
import { queueRedis } from '../services/queueRedis.js';

export const queueCookie = config.secureCookies ? '__Host-cusa_queue' : 'cusa_queue';
function browserId(req: Request): string | null {
  const value = req.cookies?.[queueCookie];
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export const prepareQueuePage: RequestHandler = (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  if (!browserId(req)) res.cookie(queueCookie, randomToken(), { ...cookieOptions, maxAge: 2*60*60*1000 });
  next();
};
async function context(value: unknown, cached = false) {
  let parsed: ReturnType<typeof parseAuthorizationReturnTo>;
  try { parsed = parseAuthorizationReturnTo(value); }
  catch { throw new HttpError(400, 'คำขอเข้า Service ไม่ถูกต้อง กรุณาเริ่มจากระบบปลายทาง', 'invalid_request'); }
  let app;
  try { app = await queueApplication(parsed.parameters.client_id, cached); }
  catch(error) { if(error instanceof HttpError)throw error;throw unavailable(); }
  if (app.redirectUri !== parsed.parameters.redirect_uri) throw new HttpError(400, 'Callback ไม่ตรงกับที่ลงทะเบียน', 'invalid_client');
  return { app, returnTo: parsed.returnTo };
}
const unavailable = () => new HttpError(503, 'ห้องรอคิวยังไม่พร้อม กรุณาลองใหม่ โดยระบบจะไม่ข้ามคิว', 'QUEUE_UNAVAILABLE');
export async function queueVisit(req: Request, res: Response) {
  res.set({ 'Cache-Control': 'no-store', 'Retry-After': '10' });
  // Pre-authentication endpoint: exact Origin + non-simple header + JSON. No
  // session query or CSRF exemption on the authenticated API is necessary.
  if (req.get('Origin') !== config.appOrigin || req.get('X-CUSA-Queue') !== '1' || !req.is('application/json'))
    throw new HttpError(403, 'คำขอไม่ผ่านการตรวจสอบที่มา', 'CSRF_REJECTED');
  const { returnTo: requested } = z.object({ returnTo: z.string().max(3000) }).strict().parse(req.body);
  const { app, returnTo } = await context(requested, true);
  if (!app.enabled) return res.json({ status: 'disabled', next: returnTo });
  const browser = browserId(req);
  if (!browser) throw new HttpError(428, 'กรุณาเปิดคุกกี้และโหลดหน้ารอคิวใหม่', 'QUEUE_COOKIE_REQUIRED');
  let result;
  try { result = await visitQueue(app, browser, rateIp(req), returnTo, 'join'); }
  catch { throw unavailable(); }
  if (result.status === 'full' || result.status === 'ip_limit')
    return res.status(429).json({ error: result.status==='full'?'ห้องรอคิวเต็มชั่วคราว กรุณารอแล้วลองใหม่':'เครือข่ายนี้ขอคิวถึงจำนวนที่กำหนด กรุณารอสักครู่',code:'QUEUE_LIMITED',retryAfter:10 });
  res.json({ ...result, application: { name: app.name, origin: new URL(app.redirectUri).origin },
    pollAfter: 10, ...(result.status === 'admitted' ? { next: returnTo } : {}) });
}
export async function queueGate(req: Request, res: Response, requested: unknown, consume = false): Promise<boolean> {
  const { app, returnTo } = await context(requested);
  if (!app.enabled) return true;
  res.set('Retry-After', '10');
  const browser = browserId(req);
  if (browser) {
    let result;
    try { result = await visitQueue(app, browser, rateIp(req), returnTo, consume?'consume':'check', consume?req.identity!.userId:''); }
    catch { throw unavailable(); }
    if (result.status === 'duplicate_account') {
      res.set('Retry-After','60');
      throw new HttpError(429, 'บัญชีนี้เพิ่งผ่านคิวของ Service นี้ กรุณารอ 1 นาทีก่อนเริ่มใหม่', 'QUEUE_ACCOUNT_LIMIT');
    }
    if (result.status === (consume ? 'consumed' : 'admitted')) return true;
  }
  res.redirect(303, `/waiting?${new URLSearchParams({ returnTo })}`); return false;
}
export const authorizeQueueGate: RequestHandler = async (req, res, next) => {
  if (await queueGate(req, res, req.originalUrl, req.identity?.kind==='full' && !req.identity.phoneRequired)) next();
};
export const googleQueueGate: RequestHandler = async (req, res, next) => {
  if (req.query.returnTo && !await queueGate(req, res, req.query.returnTo)) return;
  next();
};
export async function readQueueSettings(req: Request, res: Response) {
  const { enabled, rate, capacity, ipLimit } = await queueApplication(z.uuid().parse(req.params.id));
  res.json({ enabled, rate, capacity, ipLimit });
}
export async function saveQueueSettings(req: Request, res: Response) {
  const id = z.uuid().parse(req.params.id), settings = queueSettingsSchema.parse(req.body);
  if (settings.enabled) {
    try { await (await queueRedis()).withCommandOptions({ timeout: 3000 }).ping(); }
    catch { throw unavailable(); }
  }
  await updateQueueSettings({userId:req.identity!.userId,email:req.identity!.email,sessionId:req.identity!.sessionId}, id, settings,
    (conn,event,target,metadata) => audit(req,event,target,metadata,conn));
  res.json({ ok: true, ...settings });
}
