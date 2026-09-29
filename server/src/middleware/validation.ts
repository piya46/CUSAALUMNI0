import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
export const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'กรุณากรอกรหัส 6 หลัก') }).strict();
export const emailCodeSchema = codeSchema.extend({reference:z.string().regex(/^[A-F0-9]{8}$/, 'กรุณาขอรหัส OTP ใหม่')});
export const recoverySchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{20}$/, 'รูปแบบ Recovery code ไม่ถูกต้อง') }).strict();
export function validateBody(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => { req.body = schema.parse(req.body); next(); };
}
