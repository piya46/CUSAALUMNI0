import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit as localRateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config,assertServerConfiguration } from './config.js';
import { attachIdentity, csrfProtection, HttpError, requireConfigured, audit } from './middleware/security.js';
import { authRouter } from './routes/authRoutes.js';
import { adminRouter } from './routes/adminRoutes.js';
import { ssoRouter } from './routes/ssoRoutes.js';
import { getAuditQueueHealth } from './models/auditModel.js';
import { getAuditWorkerStatus } from './services/auditWorker.js';
import { checkRateLimitStore } from './services/rateLimitStore.js';
import { createInstallRouter } from './routes/installRoutes.js';

export function createApp() {
  assertServerConfiguration();
  const app=express();
  app.disable('x-powered-by'); app.set('trust proxy',config.trustProxy);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','https://lh3.googleusercontent.com'],connectSrc:["'self'"],frameAncestors:["'none'"],formAction:["'self'"],upgradeInsecureRequests:config.secureCookies?[]:null}},crossOriginEmbedderPolicy:false,strictTransportSecurity:config.secureCookies?{maxAge:31536000,includeSubDomains:true}:false}));
  app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');next();});
  app.use('/api',localRateLimit({windowMs:60_000,limit:180,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'คำขอมากเกินไป กรุณารอสักครู่',code:'RATE_LIMITED'}}));
  app.use(express.json({limit:'16kb'}));
  app.use(express.urlencoded({extended:false,limit:'16kb'}));
  app.use(cookieParser());
  app.get('/api/health',(_req,res)=>res.json({status:'ok',configured:config.configured}));
  app.get('/api/ready',async(_req,res)=>{
    if(!config.configured || config.installEnabled)return res.status(503).json({ready:false});
    try {
      await checkRateLimitStore();
      const queue=await getAuditQueueHealth();const worker=getAuditWorkerStatus();
      const ready=worker.running&&worker.consecutiveFailures===0&&queue.oldestAgeSeconds<60;
      res.status(ready?200:503).json({ready});
    }catch{res.status(503).json({ready:false});}
  });
  app.use('/api/install',createInstallRouter());
  // Setup mode keeps all authentication and service APIs closed until the operator restarts.
  if (config.installEnabled) app.use('/api', (_req,res) => res.status(503).json({error:'ระบบอยู่ระหว่างติดตั้ง กรุณาลองใหม่ภายหลัง',code:'INSTALL_IN_PROGRESS'}));
  app.use('/api',attachIdentity,csrfProtection);
  app.use('/api/auth',authRouter); app.use('/api/admin',adminRouter); app.use('/api/sso',requireConfigured,ssoRouter);
  app.use('/api',(_req,res)=>res.status(404).json({error:'ไม่พบ API',code:'NOT_FOUND'}));
  const webDir=fileURLToPath(new URL('../../web/dist',import.meta.url));
  app.get('/install', (_req,res,next) => {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');
    if (!config.installEnabled) return res.status(404).type('text').send('Installer is disabled.');
    next();
  });
  if (existsSync(webDir)) { app.use(express.static(webDir,{index:false,maxAge:'1h'})); app.get('/{*path}',(req,res)=>{res.setHeader('Cache-Control',/^\/install\/?$/i.test(req.path)?'no-store':'no-cache');res.sendFile(`${webDir}/index.html`);}); }
  app.use(async (error:unknown,req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if (config.configured && !config.installEnabled && !req.path.startsWith('/api/install')) {
      await audit(req,'http.request.failure',req.path.slice(0,255),{failure_reason:error instanceof HttpError ? error.code ?? `HTTP_${error.status}` : error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',method:req.method}).catch(()=>{console.error('Audit enqueue failed');});
    }
    if (error instanceof z.ZodError) return res.status(400).json({error:error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง',code:'VALIDATION_ERROR'});
    if (error instanceof HttpError) return res.status(error.status).json({error:error.message,code:error.code});
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({error:'JSON ไม่ถูกต้อง',code:'VALIDATION_ERROR'});
    // Log only a safe classification; never OAuth responses, cookies, OTPs or credentials.
    console.error('Request failed:',error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({error:'ระบบไม่สามารถดำเนินการได้ กรุณาลองใหม่',code:'INTERNAL_ERROR'});
  });
  return app;
}
