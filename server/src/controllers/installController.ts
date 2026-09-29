import type { Request, Response } from 'express';
import { auditContext } from '../middleware/requestContext.js';
import { z } from 'zod';
import type { InstallationService } from '../services/installation.js';

export function createInstallControllers(service: InstallationService) {
  return {
    async check(req: Request, res: Response) {
      z.object({}).strict().parse(req.body);
      res.json(await service.check());
    },
    async run(req: Request, res: Response) {
      z.object({ confirm: z.literal(true) }).strict().parse(req.body);
      res.status(201).json(await service.run({...auditContext(req),requestId:req.context?.requestId,userAgent:(req.get('user-agent')??'').slice(0,512)}));
    },
  };
}
