import type { Request,Response } from 'express';
import { config } from '../config.js';
import { safeEqual } from '../services/crypto.js';
import { HttpError } from '../middleware/security.js';
import { getAuditWorkerStatus } from '../services/auditWorker.js';
import { getBackgroundJobsStatus } from '../services/backgroundJobs.js';
export function metrics(req:Request,res:Response){
  if(!config.metricsToken)throw new HttpError(404,'Not found','NOT_FOUND');
  if(!safeEqual(req.get('Authorization')??'',`Bearer ${config.metricsToken}`))throw new HttpError(401,'Unauthorized','UNAUTHENTICATED');
  const memory=process.memoryUsage(),cpu=process.cpuUsage(),worker=getAuditWorkerStatus();
  const values:[string,string,string,number][]=[
    ['process_cpu_user_seconds_total','counter','Process user CPU seconds',cpu.user/1e6],
    ['process_cpu_system_seconds_total','counter','Process system CPU seconds',cpu.system/1e6],
    ['process_resident_memory_bytes','gauge','Process resident memory',memory.rss],
    ['nodejs_heap_used_bytes','gauge','Used Node.js heap',memory.heapUsed],
    ['process_uptime_seconds','gauge','Seconds since this worker started',process.uptime()],
    ['cusa_audit_worker_running','gauge','Audit worker running',Number(worker.running)],
    ['cusa_audit_consecutive_failures','gauge','Consecutive audit worker failures',worker.consecutiveFailures],
  ];
  res.set({'Cache-Control':'no-store','Content-Type':'text/plain; version=0.0.4; charset=utf-8'});
  const background=getBackgroundJobsStatus();
  const jobValues=[`# TYPE cusa_background_scheduler_running gauge`,`cusa_background_scheduler_running ${Number(background.running)}`];
  for(const [metric,field] of [['running','running'],['last_success_timestamp_seconds','lastSuccessAt'],['consecutive_failures','consecutiveFailures']] as const){
    jobValues.push(`# TYPE cusa_background_job_${metric} gauge`);
    for(const job of background.jobs){
      const value=field==='lastSuccessAt'?(job[field]??0)/1000:Number(job[field]);
      jobValues.push(`cusa_background_job_${metric}{job="${job.name}"} ${value}`);
    }
  }
  res.send(values.map(([name,type,help,value])=>`# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`).concat(jobValues).join('\n')+'\n');
}
