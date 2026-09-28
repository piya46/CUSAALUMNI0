import { randomInt } from 'node:crypto';
import type { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { config } from '../config.js';
import * as model from '../models/authModel.js';
import { randomToken, safeEqual } from '../services/crypto.js';
import { createHash } from 'node:crypto';
import { sendOtp } from '../services/mail.js';
import { makeTotp } from '../services/totp.js';
import { HttpError, audit, sessionCookie, flowCookie, cookieOptions } from '../middleware/security.js';

const google = () => new OAuth2Client(config.googleClientId,config.googleClientSecret,`${config.appOrigin}/api/auth/google/callback`);
const record=(req:Request):model.AuthAudit=>(conn,event,target,metadata)=>audit(req,event,target,metadata,conn);
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/api/sso/authorize?') && value.length <= 3000 && !/[\r\n]/.test(value) ? value : '';
}
export function status(_req: Request, res: Response) { res.json({configured:config.configured,googleConfigured:config.googleConfigured,mailConfigured:config.mailConfigured}); }
export async function me(req: Request, res: Response) {
  const s = req.identity!;
  res.json({ user:{id:s.userId,email:s.email,name:s.name,firstName:s.firstName??'',lastName:s.lastName??'',avatar:s.avatar,role:s.role,totpEnabled:s.totpEnabled},csrfToken:s.csrfToken,requiresMfa:s.kind==='pending',status:s.kind==='pending'?'mfa_required':'authenticated',mfaMethod:s.kind==='pending'?(s.totpEnabled?'totp':'email'):s.mfaMethod,recoveryCodesRemaining:s.kind==='full'?await model.recoveryCodesRemaining(s.userId):undefined });
}
export async function googleStart(req: Request, res: Response) {
  const state=randomToken(),browser=randomToken(),nonce=randomToken(),verifier=randomToken(48);
  await model.createFlow(state,browser,nonce,verifier,safeReturnTo(req.query.returnTo));
  res.cookie(flowCookie,browser,{...cookieOptions,maxAge:10*60*1000});
  const url = google().generateAuthUrl({scope:['openid','email','profile'],state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256' as any,prompt:'select_account'});
  res.redirect(url);
}
export async function googleCallback(req: Request, res: Response) {
  res.clearCookie(flowCookie,cookieOptions);
  let returnTo = '';
  try {
    const state=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.query.state);
    const browser=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.cookies?.[flowCookie]);
    const flow=await model.takeFlow(state,browser);
    if (!flow) throw new Error('Invalid OAuth state');
    returnTo=safeReturnTo(flow.returnTo);
    const code=z.string().min(1).max(4096).parse(req.query.code);
    const client=google();
    const {tokens}=await client.getToken({code,codeVerifier:flow.verifier});
    if (!tokens.id_token) throw new Error('Missing identity token');
    const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:config.googleClientId});
    const p=ticket.getPayload();
    const nonce=(p as (typeof p & {nonce?:string}))?.nonce;
    if (!p?.sub || !p.email || p.email_verified!==true || !nonce || !safeEqual(nonce,flow.nonce)) throw new Error('Invalid Google identity');
    const email=z.email().max(254).parse(p.email.toLowerCase());
    const session=await model.startGoogleSession({sub:p.sub,email,name:(p.name || email).slice(0,255),firstName:(p.given_name??'').slice(0,100),lastName:(p.family_name??'').slice(0,100),avatar:p.picture?.startsWith('https://')?p.picture.slice(0,2048):null},req.cookies?.[sessionCookie],(conn,userId,sessionId)=>model.recordAudit({actorId:userId,actorEmail:email,sessionId,status:'success',userAgent:(req.get('user-agent')??'').slice(0,512),event:'auth.google.success',target:userId,ip:req.ip??'unknown',metadata:{}},conn));
    if (!session) throw new Error('Account not allowed');
    res.cookie(sessionCookie,session.token,{...cookieOptions,maxAge:10*60*1000});
    const params=new URLSearchParams({auth:'success',status:'mfa_required'});
    if (returnTo) params.set('returnTo',returnTo);
    res.redirect(`/login?${params}`);
  } catch {
    await audit(req,'auth.google.failed').catch(()=>{});
    const params=new URLSearchParams({auth:'error'});
    if (returnTo) params.set('returnTo',returnTo);
    res.redirect(`/login?${params}`);
  }
}
export async function otpSend(req: Request,res: Response) {
  if (req.identity!.kind!=='pending' || req.identity!.totpEnabled) throw new HttpError(403,'ขั้นตอนนี้ไม่รองรับการส่ง Email OTP');
  const code=String(randomInt(0,1000000)).padStart(6,'0');
  const id=await model.createOtp(req.identity!.sessionId,code,record(req));
  if (!id) throw new HttpError(401,'กรุณาเริ่มเข้าสู่ระบบใหม่');
  try { await sendOtp(req.identity!.email,code); }
  catch { await model.discardOtp(id); throw new HttpError(503,'ส่งอีเมลไม่สำเร็จ กรุณาตรวจสอบการตั้งค่า Gmail','MAIL_UNAVAILABLE'); }
  await audit(req,'auth.otp.sent'); res.json({ok:true,expiresIn:config.otpMinutes*60});
}
async function completeVerification(req: Request,res: Response,token: string | null,event: string) {
  if (!token) { await audit(req,`${event}.failed`); throw new HttpError(401,'รหัสไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว','INVALID_CODE'); }
  res.cookie(sessionCookie,token,{...cookieOptions,maxAge:config.sessionHours*60*60*1000});
  res.json({ok:true});
}
export async function otpVerify(req: Request,res: Response) { await completeVerification(req,res,await model.verifyEmailOtp(req.identity!.sessionId,req.body.code,record(req)),'auth.email'); }
export async function totpVerify(req: Request,res: Response) { const token=await model.verifyTotp(req.identity!.sessionId,req.body.code,'login',record(req)); await completeVerification(req,res,typeof token==='string'?token:null,'auth.totp'); }
export async function recoveryVerify(req: Request,res: Response) { await completeVerification(req,res,await model.verifyRecovery(req.identity!.sessionId,req.body.code,record(req)),'auth.recovery'); }
export async function totpSetup(req: Request,res: Response) {
  if (req.identity!.totpEnabled && req.identity!.mfaMethod!=='recovery') throw new HttpError(409,'Authenticator เปิดใช้งานอยู่แล้ว');
  const totp=makeTotp(req.identity!.email); const recoveryCodes=model.generateRecoveryCodes();
  await model.saveEnrollment(req.identity!.sessionId,totp.secret.base32,recoveryCodes,record(req));
  res.json({secret:totp.secret.base32,uri:totp.toString(),recoveryCodes});
}
export async function totpEnable(req: Request,res: Response) {
  if (!await model.enableTotp(req.identity!.sessionId,req.body.code,record(req))) throw new HttpError(400,'รหัสไม่ถูกต้อง หรือการตั้งค่าหมดอายุ','INVALID_CODE');
  res.json({ok:true});
}
export async function totpDisable(req: Request,res: Response) {
  if (!await model.verifyTotp(req.identity!.sessionId,req.body.code,'disable',record(req))) throw new HttpError(400,'รหัสไม่ถูกต้องหรือถูกใช้แล้ว','INVALID_CODE');
  res.json({ok:true});
}
export async function recoveryRegenerate(req: Request,res: Response) {
  const codes=await model.regenerateRecovery(req.identity!.sessionId,req.body.code,record(req));
  if (!codes) throw new HttpError(400,'รหัสไม่ถูกต้องหรือถูกใช้แล้ว','INVALID_CODE');
  res.json({recoveryCodes:codes});
}
export async function logout(req: Request,res: Response) {
  await model.deleteSession(req.identity!.sessionId,req.identity!.userId,(conn)=>audit(req,'auth.logout',undefined,undefined,conn));
  res.clearCookie(sessionCookie,cookieOptions); res.json({ok:true});
}
export async function sessions(req: Request,res: Response) {
  const rows=await model.listSessions(req.identity!.userId);
  res.json({sessions:rows.map(r=>({id:r.id,createdAt:r.created_at,expiresAt:r.expires_at,mfaMethod:r.mfa_method,current:r.id===req.identity!.sessionId}))});
}
export async function revokeSession(req: Request,res: Response) {
  const id=z.uuid().parse(req.params.id);
  const result=await model.deleteSession(id,req.identity!.userId,record(req));
  if (!result.affectedRows) throw new HttpError(404,'ไม่พบเซสชัน');
  if (id===req.identity!.sessionId) res.clearCookie(sessionCookie,cookieOptions);
  res.json({ok:true});
}
