import multer from 'multer';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { HttpError } from './security.js';
let active=0;
// Bound decoding/multipart buffers before receiving them. No on-disk plaintext temp files.
export const evidenceCapacity:RequestHandler=(req,res,next)=>{
  if(Buffer.from(config.mfaEvidenceKey,'base64').length!==32)throw new HttpError(503,'ยังไม่เปิดระบบเก็บหลักฐาน กรุณาติดต่อผู้ดูแล','EVIDENCE_NOT_CONFIGURED');if(active>=2){res.setHeader('Retry-After',30);throw new HttpError(503,'กำลังประมวลผลหลักฐาน กรุณาลองใหม่','UPLOAD_BUSY');}
  active++;let released=false;const release=()=>{if(!released){active--;released=true;}};req.releaseEvidenceCapacity=release;
  res.once('close',()=>{if(!req.evidenceProcessing)release();});next();
};
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:3,parts:4,fieldSize:100},
  fileFilter:(_req,file,done)=>{if(!['image/jpeg','image/png'].includes(file.mimetype))return done(new HttpError(400,'ใช้ไฟล์ JPEG หรือ PNG เท่านั้น','EVIDENCE_REJECTED'));done(null,true);},
}).single('evidence');
export const evidenceUpload:RequestHandler=(req,res,next)=>upload(req,res,error=>{
  if(error){req.file?.buffer.fill(0);req.releaseEvidenceCapacity?.();}
  else if(res.destroyed){req.file?.buffer.fill(0);req.releaseEvidenceCapacity?.();return;}
  else req.evidenceProcessing=true;
  if(error instanceof multer.MulterError)return next(new HttpError(error.code==='LIMIT_FILE_SIZE'?413:400,'ภาพต้องเป็น JPEG/PNG ไม่เกิน 5 MB และแนบได้ครั้งละ 1 ไฟล์','UPLOAD_LIMIT'));
  next(error);
});
