import type { Request, Response } from 'express';
import { z } from 'zod';
import * as model from '../models/serviceAccessModel.js';
import { updateUserProfile } from '../models/adminModel.js';
import { audit } from '../middleware/security.js';
import { idSchema, paginationSchema } from './adminValidation.js';

const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'ห้ามใช้อักขระควบคุม');
export const serviceRoleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), name: text(100).refine(value => value.length > 0), description: text(500).default(''),
}).strict();
export const membershipSchema = z.object({
  department: text(150).default(''), roleIds: z.array(idSchema).min(1).max(20).refine(ids => new Set(ids).size === ids.length),
}).strict();
export const profileSchema = z.object({ firstName: text(100), lastName: text(100) }).strict();
const actor = (req: Request) => ({ userId: req.identity!.userId, email: req.identity!.email });
const writer = (req: Request): import('../models/adminModel.js').AuditWriter => (conn, event, target, metadata) => audit(req, event, target, metadata, conn);
const appId = (req: Request) => idSchema.parse(req.params.applicationId);

export async function roles(req: Request, res: Response) { res.json({ roles: await model.listRoles(appId(req)) }); }
export async function createRole(req: Request, res: Response) {
  res.status(201).json({ role: await model.saveRole(actor(req), appId(req), null, serviceRoleSchema.parse(req.body), writer(req)) });
}
export async function editRole(req: Request, res: Response) {
  res.json({ role: await model.saveRole(actor(req), appId(req), idSchema.parse(req.params.roleId), serviceRoleSchema.parse(req.body), writer(req)) });
}
export async function deleteRole(req: Request, res: Response) {
  await model.revokeRole(actor(req), appId(req), idSchema.parse(req.params.roleId), writer(req)); res.json({ ok: true });
}
export async function members(req: Request, res: Response) { res.json(await model.listMembers(appId(req), paginationSchema.parse(req.query))); }
export async function saveMember(req: Request, res: Response) {
  await model.saveMember(actor(req), appId(req), idSchema.parse(req.params.userId), membershipSchema.parse(req.body), writer(req)); res.json({ ok: true });
}
export async function deleteMember(req: Request, res: Response) {
  await model.revokeMember(actor(req), appId(req), idSchema.parse(req.params.userId), writer(req)); res.json({ ok: true });
}
export async function editProfile(req: Request, res: Response) {
  await updateUserProfile(actor(req), idSchema.parse(req.params.id), profileSchema.parse(req.body), writer(req)); res.json({ ok: true });
}
