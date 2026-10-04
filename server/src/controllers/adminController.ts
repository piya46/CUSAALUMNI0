import type { Request, Response } from 'express';
import * as model from '../models/adminModel.js';
import { audit } from '../middleware/security.js';
import { idSchema, paginationSchema, auditFilterSchema, allowlistSchema, applicationSchema, apiKeySchema } from './adminValidation.js';
import { sharingPolicySchema } from '../services/claimScopes.js';

function actor(req: Request) { return { userId: req.identity!.userId, email: req.identity!.email,sessionId:req.identity!.sessionId }; }
function auditWriter(req: Request): model.AuditWriter {
  return (connection, event, target, metadata) => audit(req, event, target, metadata, connection);
}

export async function overview(_req: Request, res: Response) { res.json(await model.getOverview()); }
export async function users(req: Request, res: Response) { res.json(await model.listUsers(paginationSchema.parse(req.query))); }
export async function allowlist(req: Request, res: Response) { res.json(await model.listAllowedEmails(paginationSchema.parse(req.query))); }
export async function applications(req: Request, res: Response) { res.json(await model.listApplications(paginationSchema.parse(req.query))); }
export async function apiKeys(req: Request, res: Response) { res.json(await model.listApiKeys(paginationSchema.parse(req.query))); }
export async function auditLog(req: Request, res: Response) { const filters=auditFilterSchema.parse(req.query);const result=await model.listAudit(filters);await audit(req,'audit.search',undefined,{event:filters.event,email:filters.email,returned:result.events.length,startAt:result.meta.startAt.toISOString(),endBefore:result.meta.endBefore.toISOString()});res.json(result); }

export async function createAllowedEmail(req: Request, res: Response) {
  const email = await model.addAllowedEmail(actor(req), allowlistSchema.parse(req.body), auditWriter(req));
  res.status(201).json({ email });
}
export async function deleteAllowedEmail(req: Request, res: Response) {
  await model.removeAllowedEmail(actor(req), idSchema.parse(req.params.id), auditWriter(req));
  res.json({ ok: true });
}
export async function deleteUser(req: Request, res: Response) {
  await model.removeUser(actor(req), idSchema.parse(req.params.id), auditWriter(req));
  res.json({ ok: true });
}
export async function revokeUserSessions(req: Request, res: Response) {
  const result = await model.revokeUserSessions(actor(req), idSchema.parse(req.params.id), auditWriter(req));
  res.json({ ok: true, ...result });
}
export async function createApplication(req: Request, res: Response) {
  const application = await model.addApplication(actor(req), applicationSchema.parse(req.body), auditWriter(req));
  res.status(201).json({ application });
}
export async function deleteApplication(req: Request, res: Response) {
  await model.revokeApplication(actor(req), idSchema.parse(req.params.id), auditWriter(req));
  res.json({ ok: true });
}
export async function sharingPolicy(req:Request,res:Response){res.json(await model.getSharingPolicy(idSchema.parse(req.params.id)));}
export async function saveSharingPolicy(req:Request,res:Response){
  await model.updateSharingPolicy(actor(req),idSchema.parse(req.params.id),sharingPolicySchema.parse(req.body),auditWriter(req));
  res.json({ok:true});
}
export async function createApiKey(req: Request, res: Response) {
  const result = await model.addApiKey(actor(req), apiKeySchema.parse(req.body), auditWriter(req));
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(result);
}
export async function deleteApiKey(req: Request, res: Response) {
  await model.revokeApiKey(actor(req), idSchema.parse(req.params.id), auditWriter(req));
  res.json({ ok: true });
}
