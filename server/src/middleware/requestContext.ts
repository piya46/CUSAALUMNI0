import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

export function normalizeIp(value?: string | null): string {
  if (!value) return 'unknown';
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  if (isIP(value) === 6) return new URL(`http://[${value}]/`).hostname.slice(1,-1);
  return isIP(value) === 4 ? value : 'unknown';
}
export const requestContext: RequestHandler = (req,res,next) => {
  req.context = { requestId:randomUUID(), peerIp:normalizeIp(req.socket.remoteAddress),
    clientIp:normalizeIp(req.ip), ipSource:req.ips.length ? 'trusted_proxy' : 'socket' };
  res.setHeader('X-Request-ID',req.context.requestId);
  next();
};
export function rateIp(req: Request) { return ipKeyGenerator(normalizeIp(req.ip),56); }
export function auditContext(req:Request) {
  return { requestId:req.context?.requestId ?? null, peerIp:req.context?.peerIp ?? normalizeIp(req.socket.remoteAddress),
    ipSource:req.context?.ipSource ?? 'socket', ip:normalizeIp(req.ip),
    actorType:req.service ? 'service' : req.identity ? 'user' : 'anonymous',
    applicationId:req.service?.applicationId ?? null, apiKeyId:req.service?.apiKeyId ?? null };
}

// Failure storms are aggregated without persisting attacker-controlled payloads to MariaDB.
const failures = new Map<string,{until:number;count:number}>();
export function securityFailure(req:Request,reason:string) {
  const key=reason.slice(0,64); const now=Date.now(); const entry=failures.get(key);
  if(entry && entry.until>now) { entry.count++; return; }
  if(failures.size>=128) failures.delete(failures.keys().next().value!);
  console.error(JSON.stringify({event:'http.request.failure',reason:key,requestId:req.context?.requestId,
    clientIp:normalizeIp(req.ip),peerIp:req.context?.peerIp,previousWindowCount:entry?.count??0}));
  failures.set(key,{until:now+60_000,count:1});
}
