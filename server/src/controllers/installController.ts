import type { Request, Response } from 'express';
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
      res.status(201).json(await service.run());
    },
  };
}
