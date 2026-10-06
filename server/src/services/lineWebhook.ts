import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../middleware/security.js';
import { safeEqual } from './crypto.js';
import { requireLine, validLineSignature } from './line.js';

const lineUserId = z.string().regex(/^U[0-9a-f]{32}$/);
const envelopeSchema = z.object({ destination: lineUserId, events: z.array(z.unknown()).max(100) });
const postbackSchema = z.object({
  type: z.literal('postback'),
  timestamp: z.number().int().nonnegative(),
  source: z.object({ type: z.literal('user'), userId: lineUserId }),
  postback: z.object({ data: z.string().max(300) }),
  mode: z.enum(['active', 'standby']).optional(),
  replyToken: z.unknown().optional(),
});

/** A gateway credential is an additional ingress check, never a substitute for LINE's signature. */
export function readLineWebhook(raw: unknown, signature: string | undefined, authorization: string | undefined) {
  requireLine();
  if (config.lineWebhookGatewayToken) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
    if (!token || !safeEqual(token, config.lineWebhookGatewayToken)) {
      throw new HttpError(401, 'Invalid webhook gateway credential', 'INVALID_GATEWAY_TOKEN');
    }
  }
  if (!Buffer.isBuffer(raw) || !validLineSignature(raw, signature)) {
    throw new HttpError(401, 'Invalid webhook signature', 'INVALID_SIGNATURE');
  }
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid webhook JSON', 'VALIDATION_ERROR'); }
  const input = envelopeSchema.safeParse(body);
  if (!input.success) throw new HttpError(400, 'Invalid webhook envelope', 'VALIDATION_ERROR');
  if (config.lineWebhookDestination && input.data.destination !== config.lineWebhookDestination) {
    throw new HttpError(401, 'Invalid webhook destination', 'INVALID_WEBHOOK_DESTINATION');
  }
  return input.data;
}

/** Validate each MFA event independently so unrelated or malformed events cannot poison a batch. */
export function lineMfaPostback(input: unknown, now = Date.now()) {
  const parsed = postbackSchema.safeParse(input);
  if (!parsed.success) return;
  const event = parsed.data;
  if (event.mode === 'standby' || Math.abs(now - event.timestamp) > 180000) return;
  const data = new URLSearchParams(event.postback.data);
  // The emitted contract has exactly these two keys. Reject duplicates, including encoded keys.
  if (data.size !== 2 || data.getAll('cusa_mfa').length !== 1 || data.getAll('choice').length !== 1) return;
  const challengeId = data.get('cusa_mfa'), choice = data.get('choice');
  if (!z.uuid().safeParse(challengeId).success || !choice || !/^[A-Za-z0-9_-]{43}$/.test(choice)) return;
  const reply = z.string().min(1).max(200).safeParse(event.replyToken);
  return { challengeId: challengeId!, choice, subject: event.source.userId, replyToken: reply.success ? reply.data : undefined };
}
