import { parseAuthorizationReturnTo } from '../services/authorizationRequest.js';
import type { Request,Response } from 'express';
import type { RegistrationResponseJSON,AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { audit,HttpError,sessionCookie,cookieOptions } from '../middleware/security.js';
import { OtpCooldownError,type AuthAudit } from '../models/authModel.js';
import * as passkey from '../models/passkeyModel.js';
import * as line from '../models/lineModel.js';
import * as phone from '../models/phoneModel.js';
import { firebaseWebConfig,verifyFirebasePhoneToken } from '../services/firebasePhone.js';
import { replyLineDecision,showLineLoading } from '../services/line.js';
import { readLineWebhook,lineMfaPostback } from '../services/lineWebhook.js';
const record=(req:Request):AuthAudit=>(conn,event,target,metadata)=>audit(req,event,target,metadata,conn);
const id=z.uuid();
const responseSchema=z.object({id:z.string().regex(/^[A-Za-z0-9_-]+$/).max(2048),rawId:z.string().max(2048),type:z.literal('public-key'),response:z.record(z.string(),z.unknown()),clientExtensionResults:z.record(z.string(),z.unknown())}).passthrough();
const registerProof=responseSchema.extend({response:z.object({clientDataJSON:z.string(),attestationObject:z.string(),transports:z.array(z.enum(['ble','cable','hybrid','internal','nfc','smart-card','usb'])).optional()}).passthrough()});
const authenticateProof=responseSchema.extend({response:z.object({clientDataJSON:z.string(),authenticatorData:z.string(),signature:z.string(),userHandle:z.string().optional()}).passthrough()});
const proofSchema=z.object({challengeId:id,response:registerProof});
function complete(res:Response,token:string|null){if(!token)throw new HttpError(401,'การยืนยันไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว','INVALID_PROOF');res.cookie(sessionCookie,token,{...cookieOptions,maxAge:config.sessionHours*3600000});res.json({ok:true});}
async function cooldown<T>(res:Response,work:()=>Promise<T>){try{return await work();}catch(error){if(error instanceof OtpCooldownError){res.setHeader('Retry-After',error.retryAfter);throw new HttpError(429,'กรุณารอครบ 60 วินาทีก่อนขอใหม่','OTP_COOLDOWN');}throw error;}}
export async function factorStatus(userId:string){
  const [row]=await query<Record<string,any>>('SELECT EXISTS(SELECT 1 FROM passkeys WHERE user_id=?) AS passkey,EXISTS(SELECT 1 FROM line_identities WHERE user_id=?) AS line,EXISTS(SELECT 1 FROM phone_identities WHERE user_id=?) AS phone',[userId,userId,userId]);
  return {passkey:config.passkeyEnabled&&Boolean(row.passkey),line:config.lineMfaEnabled&&Boolean(row.line),phoneEnabled:config.firebasePhoneEnabled,phoneVerified:Boolean(row.phone)};
}
export async function settings(req:Request,res:Response){res.json({...(await factorStatus(req.identity!.userId)),passkeyEnabled:config.passkeyEnabled,lineEnabled:config.lineMfaEnabled,phoneEnabled:config.firebasePhoneEnabled,passkeys:await passkey.listPasskeys(req.identity!.userId),...(config.firebasePhoneEnabled?{firebase:firebaseWebConfig()}:{})});}
export async function registerOptions(req:Request,res:Response){res.json(await passkey.registrationOptions(req.identity!.sessionId,record(req)));}
export async function registerVerify(req:Request,res:Response){const b=proofSchema.extend({name:z.string().trim().min(1).max(80)}).strict().parse(req.body);if(!await passkey.registerPasskey(req.identity!.sessionId,b.challengeId,b.name,b.response as RegistrationResponseJSON,record(req)))throw new HttpError(400,'ลงทะเบียน Passkey ไม่สำเร็จ กรุณาเริ่มใหม่','INVALID_PROOF');res.status(201).json({ok:true});}
export async function authenticateOptions(req:Request,res:Response){res.json(await passkey.authenticationOptions(req.identity!.sessionId));}
export async function authenticateVerify(req:Request,res:Response){const b=z.object({challengeId:id,response:authenticateProof}).strict().parse(req.body);complete(res,await passkey.authenticatePasskey(req.identity!.sessionId,b.challengeId,b.response as AuthenticationResponseJSON,record(req)));}
export async function reauthenticateOptions(req:Request,res:Response){res.json(await passkey.authenticationOptions(req.identity!.sessionId,'reauth'));}
export async function reauthenticateVerify(req:Request,res:Response){
  const b=z.object({challengeId:id,response:authenticateProof}).strict().parse(req.body);
  if(!await passkey.reauthenticatePasskey(req.identity!.sessionId,b.challengeId,b.response as AuthenticationResponseJSON,record(req)))throw new HttpError(401,'การยืนยันไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว','INVALID_PROOF');
  res.json({ok:true});
}
export async function deletePasskey(req:Request,res:Response){await passkey.deletePasskey(req.identity!.sessionId,id.parse(req.params.id),record(req));res.json({ok:true});}
export async function lineStart(req:Request,res:Response){
  const body=z.object({returnTo:z.string().max(3000).optional()}).strict().parse(req.body);
  const returnTo=body.returnTo?parseAuthorizationReturnTo(body.returnTo).returnTo:undefined;
  res.json(await line.lineLinkStart(req.identity!.sessionId,record(req),returnTo));
}
export async function lineCallback(req:Request,res:Response){
  try{const state=z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/).parse(req.query.state),code=z.string().min(1).max(2048).parse(req.query.code);const returnTo=await line.lineLinkFinish(req.identity!.sessionId,state,code,record(req));res.redirect(returnTo?`/login?${new URLSearchParams({line:'linked',manage:'security',returnTo})}`:'/login?line=linked');}
  catch{await audit(req,'mfa.line.link.failure',req.identity?.userId,{failure_reason:'LINE_LINK_REJECTED'});res.redirect('/login?line=error');}
}
export async function unlinkLine(req:Request,res:Response){await line.unlinkLine(req.identity!.sessionId,record(req));res.json({ok:true});}
export async function lineSend(req:Request,res:Response){res.json(await cooldown(res,()=>line.startLineChallenge(req.identity!.sessionId,record(req))));}
export async function lineStatus(req:Request,res:Response){res.json(await line.lineChallengeStatus(req.identity!.sessionId,id.parse(req.params.id)));}
export async function lineVerify(req:Request,res:Response){const b=z.object({challengeId:id}).strict().parse(req.body);complete(res,await line.finishLineChallenge(req.identity!.sessionId,b.challengeId,record(req)));}
export async function lineWebhook(req:Request,res:Response){
  const input=readLineWebhook(req.body,req.get('x-line-signature'),req.get('authorization'));
  for(const item of input.events){
    const event=lineMfaPostback(item);if(!event)continue;
    const decision=await line.applyLineChoice(event.challengeId,event.subject,event.choice,record(req));
    // Reply only after the one-time decision and its audit record commit. A delivery
    // failure must never undo MFA, promote the browser, or replay an old choice.
    if(decision&&event.replyToken){
      // Settle loading before the reply so a late indicator does not follow the result card.
      try{await showLineLoading(event.subject);}
      catch{console.warn(JSON.stringify({event:'auth.line.loading.failure',reason:'LINE_LOADING_UNAVAILABLE'}));}
      try{await replyLineDecision(event.replyToken,event.challengeId,decision);}
      catch{console.warn(JSON.stringify({event:'auth.line.reply.failure',reason:'LINE_REPLY_UNAVAILABLE'}));}
    }
  }
  res.json({ok:true});
}
export async function phoneStart(req:Request,res:Response){const b=z.object({phone:z.string().regex(/^\+[1-9]\d{7,14}$/),acknowledged:z.literal(true),noticeVersion:z.literal('1.2')}).strict().parse(req.body);res.json(await cooldown(res,()=>phone.startPhoneVerification(req.identity!.sessionId,b.phone,record(req))));}
export async function phoneVerify(req:Request,res:Response){
  const b=z.object({challengeId:id,idToken:z.string().min(100).max(10000)}).strict().parse(req.body);
  const proof=await verifyFirebasePhoneToken(b.idToken);
  if(!await phone.finishPhoneVerification(req.identity!.sessionId,b.challengeId,proof,record(req)))throw new HttpError(409,'ไม่สามารถยืนยันหรือผูกเบอร์นี้ได้ หากเคยผูกแล้วให้ใช้บัญชีเดิม หรือติดต่อผู้ดูแล','PHONE_UNAVAILABLE');
  res.json({ok:true});
}
