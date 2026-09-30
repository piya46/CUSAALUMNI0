import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { getAuditQueueHealth } from '../models/auditModel.js';
import { getAuditWorkerStatus } from '../services/auditWorker.js';
import { HttpError } from './security.js';

let snapshot:{at:number;healthy:boolean}|undefined;
let pending:Promise<boolean>|undefined;
async function available() {
  const worker=getAuditWorkerStatus();
  if(!worker.running||worker.faulted)return false;
  if(snapshot&&Date.now()-snapshot.at<5000)return snapshot.healthy;
  if(!pending) pending=getAuditQueueHealth().then(q=>q.pending<10000&&q.oldestAgeSeconds<300).catch(()=>false)
    .then(healthy=>{snapshot={at:Date.now(),healthy};return healthy;}).finally(()=>{pending=undefined;});
  return pending;
}
export const auditAvailability:RequestHandler=async(_req,res,next)=>{
  if(config.nodeEnv==='production'&&config.configured&&!await available()) {
    res.setHeader('Retry-After',30);throw new HttpError(503,'ระบบบันทึกกิจกรรมไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง','AUDIT_UNAVAILABLE');
  }
  next();
};
