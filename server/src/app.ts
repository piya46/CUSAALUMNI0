import { lineWebhook } from './controllers/factorController.js';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit as localRateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { staticCachePolicy } from './services/staticCache.js';
import { auditAvailability } from './middleware/auditAvailability.js';
import { requestContext, securityFailure } from './middleware/requestContext.js';
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
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",...(config.firebasePhoneEnabled?['https://www.google.com/recaptcha/','https://www.gstatic.com/recaptcha/']:[])],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:','https://lh3.googleusercontent.com'],connectSrc:["'self'",...(config.firebasePhoneEnabled?['https://identitytoolkit.googleapis.com','https://securetoken.googleapis.com','https://www.google.com/recaptcha/','https://recaptchaenterprise.googleapis.com']:[])],frameSrc:["'self'",...(config.firebasePhoneEnabled?['https://www.google.com/recaptcha/','https://recaptcha.google.com/recaptcha/',`https://${config.firebaseAuthDomain}`]:[])],frameAncestors:["'none'"],formAction:["'self'"],upgradeInsecureRequests:config.secureCookies?[]:null}},crossOriginEmbedderPolicy:false,strictTransportSecurity:config.secureCookies?{maxAge:31536000,includeSubDomains:true}:false}));
  app.use(requestContext);
  app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');next();});
  const coarseLimit=(limit:number)=>localRateLimit({windowMs:60_000,limit,standardHeaders:'draft-8',legacyHeaders:false,
    handler:(req,res)=>{securityFailure(req,'LOCAL_RATE_LIMIT');res.status(429).json({error:'คำขอมากเกินไป กรุณารอสักครู่',code:'RATE_LIMITED',requestId:req.context?.requestId});}});
  const browserLimit=coarseLimit(180), machineLimit=coarseLimit(12000);
  app.use('/api',(req,res,next)=>{
    if(['/health','/ready'].includes(req.path)) return next();
    return ['/sso/token','/sso/introspect'].includes(req.path)?machineLimit(req,res,next):browserLimit(req,res,next);
  });
  app.post('/api/auth/line/webhook',requireConfigured,auditAvailability,express.raw({type:'application/json',limit:'64kb'}),lineWebhook);
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
  app.use('/api',auditAvailability,attachIdentity,csrfProtection);
  app.use('/api/auth',authRouter); app.use('/api/admin',adminRouter); app.use('/api/sso',requireConfigured,ssoRouter);
  app.use('/api',(_req,res)=>res.status(404).json({error:'ไม่พบ API',code:'NOT_FOUND'}));
  const webDir=fileURLToPath(new URL('../../web/dist',import.meta.url));
  app.get('/install', (_req,res,next) => {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');
    if (!config.installEnabled) return res.status(404).type('text').send('Installer is disabled.');
    next();
  });
  if (existsSync(webDir)) { app.use(express.static(webDir,{index:false,setHeaders:(res,file)=>res.setHeader('Cache-Control',staticCachePolicy(file,webDir))})); app.get('/{*path}',(req,res)=>{res.setHeader('Cache-Control',/^\/install\/?$/i.test(req.path)?'no-store':'no-cache');res.sendFile(`${webDir}/index.html`);}); }
  app.use(async (error:unknown,req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const reason=error instanceof HttpError ? error.code ?? `HTTP_${error.status}` : error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
    securityFailure(req,reason);
    if (config.configured && !config.installEnabled && !req.auditRecorded && !req.path.startsWith('/api/install') && !(error instanceof HttpError && [401,429,503].includes(error.status))) {
      await audit(req,'http.request.failure',req.path.slice(0,255),{failure_reason:error instanceof HttpError ? error.code ?? `HTTP_${error.status}` : error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',method:req.method}).catch(()=>{console.error('Audit enqueue failed');});
    }
    if (error instanceof z.ZodError) return res.status(400).json({error:error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง',code:'VALIDATION_ERROR'});
    if (error instanceof HttpError) return res.status(error.status).json({error:error.message,code:error.code,requestId:req.context?.requestId});
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({error:'JSON ไม่ถูกต้อง',code:'VALIDATION_ERROR'});
    // Log only a safe classification; never OAuth responses, cookies, OTPs or credentials.
    console.error('Request failed:',error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({error:'ระบบไม่สามารถดำเนินการได้ กรุณาลองใหม่',code:'INTERNAL_ERROR'});
  });
  return app;
}
