import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { securityFailure } from '../middleware/requestContext.js';
import { config } from '../config.js';
import { createInstallControllers } from '../controllers/installController.js';
import { installationService, InstallationError, type InstallationService } from '../services/installation.js';
import { MigrationBusyError } from '../services/migrations.js';

type Settings = Pick<typeof config, 'installEnabled' | 'installToken' | 'appOrigin'>;
export function createInstallRouter(settings: Settings = config, service: InstallationService = installationService) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!settings.installEnabled) return res.status(404).json({ error: 'ไม่พบหน้าติดตั้ง', code: 'NOT_FOUND' });
    next();
  });
  // Independent of Redis and schema: works before installation and remains bounded per process.
  router.use(rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    skipSuccessfulRequests: true, handler:(req,res)=>{securityFailure(req,'INSTALL_RATE_LIMIT');res.status(429).json({error:'ลองรหัสติดตั้งบ่อยเกินไป กรุณารอ 15 นาที',code:'RATE_LIMITED'});} }));
  router.use((req, res, next) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'ใช้ POST เท่านั้น', code: 'METHOD_NOT_ALLOWED' });
    if (req.get('Origin') !== settings.appOrigin || !req.is('application/json')) {
      throw new InstallationError(403, 'ORIGIN_REJECTED', 'กรุณาเปิดหน้าติดตั้งจากโดเมนของ CUSA SSO โดยตรง');
    }
    const authorization = req.get('Authorization') ?? '';
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!settings.installToken || !token || !timingSafeEqual(hash(token), hash(settings.installToken))) {
      throw new InstallationError(401, 'INSTALL_UNAUTHORIZED', 'รหัสติดตั้งไม่ถูกต้อง');
    }
    next();
  });
  const controllers = createInstallControllers(service);
  router.post('/check', controllers.check);
  router.post('/run', controllers.run);
  router.use((_req, res) => res.status(404).json({ error: 'ไม่พบ API', code: 'NOT_FOUND' }));
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    securityFailure(req,error instanceof InstallationError?error.code:'INSTALL_FAILED');
    if (error instanceof InstallationError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'ข้อมูลยืนยันการติดตั้งไม่ถูกต้อง', code: 'VALIDATION_ERROR' });
    if (error instanceof MigrationBusyError) return res.status(409).json({ error: 'มีการติดตั้งหรือ migration กำลังทำงาน กรุณารอแล้วตรวจสอบอีกครั้ง', code: 'INSTALL_BUSY' });
    console.error('Installation failed:', error instanceof Error ? error.name : 'UnknownError');
    return res.status(503).json({ error: 'ติดตั้งไม่สำเร็จ ตรวจการเชื่อมต่อ DB, สิทธิ์ CREATE/ALTER/INDEX, ไฟล์ migrations และ Redis บน Host แล้วลองอีกครั้ง', code: 'INSTALL_FAILED' });
  };
  router.use(errors);
  return router;
}
