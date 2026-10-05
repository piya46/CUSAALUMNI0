import type { Request, Response } from 'express';
import { z } from 'zod';
import { audit, HttpError } from '../middleware/security.js';
import { accessPolicySchema } from '../services/servicePolicy.js';
import { parseAuthorizationReturnTo } from '../services/authorizationRequest.js';
import { scopesWithin } from '../services/claimScopes.js';
import { ssoModel } from '../models/ssoModel.js';
import * as model from '../models/servicePolicyModel.js';
import type { AuditWriter } from '../models/adminModel.js';
const actor=(req:Request)=>({userId:req.identity!.userId,email:req.identity!.email,sessionId:req.identity!.sessionId});
const writer=(req:Request):AuditWriter=>(conn,event,target,metadata)=>audit(req,event,target,metadata,conn);
const appId=(req:Request)=>z.uuid().parse(req.params.applicationId);
export async function readPolicy(req:Request,res:Response){res.json(model.policyResponse(await model.readAccessPolicy(appId(req))));}
export async function savePolicy(req:Request,res:Response){
  const {expectedVersion,...input}=z.object({expectedVersion:z.number().int().min(1)}).passthrough().parse(req.body);
  res.json(await model.saveAccessPolicy(actor(req),appId(req),accessPolicySchema.parse(input),expectedVersion,writer(req)));
}
export async function invitations(req:Request,res:Response){
  const id=appId(req);
  const {page,limit}=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(req.query);
  res.json(await model.listInvitations(id,page,limit));
}
export async function invite(req:Request,res:Response){
  const {email,days}=z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),days:z.number().int().min(1).max(30)}).strict().parse(req.body);
  await model.saveInvitation(actor(req),appId(req),email,days,writer(req));res.status(201).json({ok:true});
}
export async function uninvite(req:Request,res:Response){
  const {email}=z.object({email:z.email().max(254).transform(v=>v.toLowerCase())}).strict().parse(req.body);
  await model.removeInvitation(actor(req),appId(req),email,writer(req));res.json({ok:true});
}
export async function preview(req:Request,res:Response){
  const {cursor,limit}=z.object({cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
  res.json(await model.lifecyclePreview(appId(req),cursor,limit));
}
async function enrollmentRequest(value:unknown){
  const {returnTo}=z.object({returnTo:z.string().max(3000)}).strict().parse(value);
  const parsed=parseAuthorizationReturnTo(returnTo),p=parsed.parameters,app=await ssoModel.getApplication(p.client_id);
  if(!app||app.redirectUri!==p.redirect_uri||!scopesWithin(p.scope,app.allowedScope)||!scopesWithin(app.requiredScope??'identity:read',p.scope))
    throw new HttpError(400,'คำขอ Service ไม่ถูกต้อง กรุณาเริ่มใหม่จากระบบปลายทาง','invalid_request');
  return parsed;
}
export async function enrollment(req:Request,res:Response){
  const {parameters,returnTo}=await enrollmentRequest(req.query);
  res.json({...await model.enrollmentContext(parameters.client_id,req.identity!.userId,req.identity!.sessionId),returnTo});
}
export async function enroll(req:Request,res:Response){
  const {parameters,returnTo}=await enrollmentRequest(req.body);
  await model.enroll(parameters.client_id,req.identity!.userId,req.identity!.sessionId,req.identity!.email,writer(req));
  res.json({...await model.enrollmentContext(parameters.client_id,req.identity!.userId,req.identity!.sessionId),returnTo});
}
export async function activity(req:Request,res:Response){
  const {sub,eventId}=z.object({sub:z.uuid(),eventId:z.uuid()}).strict().parse(req.body);
  res.json(await model.reportActivity(req.service!.applicationId,sub,eventId,req.service!.apiKeyId));
}
