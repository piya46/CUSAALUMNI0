import type { Request,Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import * as model from '../models/mfaResetModel.js';
import { storeEvidence,watermarkEvidence } from '../services/mfaEvidence.js';
import { audit,HttpError } from '../middleware/security.js';
import type { AuditWriter } from '../models/adminModel.js';
const writer=(req:Request):AuditWriter=>(conn,event,target,metadata)=>audit(req,event,target,metadata,conn);
const actor=(req:Request)=>({userId:req.identity!.userId,email:req.identity!.email,sessionId:req.identity!.sessionId});
export async function submit(req:Request,res:Response){
  let id:string|undefined;
  try{
    const input=z.object({reason:z.enum(['lost','replaced','damaged']),noticeVersion:z.literal(model.resetNoticeVersion),acknowledged:z.literal('true')}).strict().parse(req.body);
    if(!req.file)throw new HttpError(400,'แนบภาพ JPEG หรือ PNG ขนาดไม่เกิน 5 MB','EVIDENCE_REQUIRED');
    id=await model.reserveReset(req.identity!.userId,input.reason,writer(req));
    try{
      const watermarked=await watermarkEvidence(req.file.buffer,id);
      try{await storeEvidence(id,watermarked);}finally{watermarked.fill(0);}
      await model.finishResetUpload(id,writer(req));
    }catch(error){
      await model.cancelFailedUpload(id);
      await audit(req,'mfa.reset.upload.failure',req.identity!.userId,{requestId:id,failure_reason:'EVIDENCE_PROCESSING_FAILED'});
      if(error instanceof HttpError)throw error;
      throw new HttpError(400,'ประมวลผลภาพไม่สำเร็จ ใช้ JPEG/PNG ไม่เกิน 5 MB และ 20 ล้านพิกเซล หรือติดต่อผู้ดูแล','EVIDENCE_REJECTED');
    }
    res.status(201).json({id,status:'pending'});
  }finally{req.file?.buffer.fill(0);req.releaseEvidenceCapacity?.();}
}
export async function own(req:Request,res:Response){res.json({request:await model.ownReset(req.identity!.userId),enabled:Buffer.from(config.mfaEvidenceKey,'base64').length===32,noticeVersion:model.resetNoticeVersion});}
export async function list(req:Request,res:Response){
  const {status,cursor}=z.object({status:z.enum(['all','pending','pending_second','approved','rejected','expired','cancelled']).default('pending'),cursor:z.string().regex(/^[A-Za-z0-9_-]+$/).max(256).optional()}).strict().parse(req.query);
  let after:{createdAt:Date;id:string}|undefined;
  if(cursor){
    try{after=z.object({createdAt:z.iso.datetime().transform(v=>new Date(v)),id:z.uuid()}).strict().parse(JSON.parse(Buffer.from(cursor,'base64url').toString()));}
    catch{throw new HttpError(400,'Cursor ไม่ถูกต้อง','VALIDATION_ERROR');}
  }
  res.json(await model.listResets(status,after));
}
export async function evidence(req:Request,res:Response){
  const image=await model.viewResetEvidence(actor(req),z.uuid().parse(req.params.id),writer(req));
  res.set({'Cache-Control':'no-store, private','Pragma':'no-cache','Content-Type':'image/jpeg','Content-Disposition':'inline; filename="cusa-mfa-evidence.jpg"','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.once('finish',()=>image.fill(0));res.once('close',()=>image.fill(0));res.send(image);
}
export async function decide(req:Request,res:Response){
  const input=z.discriminatedUnion('decision',[
    z.object({decision:z.literal('approve'),verified:z.literal(true),reason:z.literal('identity_verified')}).strict(),
    z.object({decision:z.literal('reject'),reason:z.enum(['unreadable','identity_mismatch','insufficient_evidence','withdrawn'])}).strict(),
  ]).parse(req.body);
  res.json(await model.decideReset(actor(req),z.uuid().parse(req.params.id),input.decision,input.reason,writer(req)));
}
