import { z } from 'zod';

export const idSchema = z.uuid();
const labelSchema = z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed.');
const integerQuery = (fallback: string, max: number) => z.string().regex(/^[1-9]\d{0,6}$/)
  .default(fallback).transform(Number).pipe(z.number().int().min(1).max(max));

export const paginationSchema = z.object({
  page: integerQuery('1', 1_000_000),
  limit: integerQuery('20', 100),
  search: z.string().trim().max(100).default(''),
}).strict();

const dateFilter = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const emailFilter = z.string().trim().toLowerCase().max(254).email();
export const auditFilterSchema = paginationSchema.extend({
  event: z.string().trim().min(1).max(100).optional(),
  email: emailFilter.optional(),
  actor_email: emailFilter.optional(),
  startDate: dateFilter.optional(),
  start_date: dateFilter.optional(),
  endDate: dateFilter.optional(),
  end_date: dateFilter.optional(),
  status: z.enum(['success', 'failure']).optional(),
}).superRefine((value, ctx) => {
  for (const [preferred, alias] of [['email', 'actor_email'], ['startDate', 'start_date'], ['endDate', 'end_date']] as const) {
    if (value[preferred] && value[alias] && value[preferred] !== value[alias]) {
      ctx.addIssue({ code: 'custom', path: [alias], message: `Use matching values for ${preferred} and ${alias}, or supply only one.` });
    }
  }
  const start = value.startDate ?? value.start_date;
  const end = value.endDate ?? value.end_date;
  if (start && end) {
    const endMillis = new Date(end).getTime() + (end.length === 10 ? 86_400_000 - 1 : 0);
    if (new Date(start).getTime() > endMillis) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date.' });
  }
}).transform(value => {
  const start = value.startDate ?? value.start_date;
  const end = value.endDate ?? value.end_date;
  return {
    page: value.page, limit: value.limit, search: value.search,
    event: value.event, email: value.email ?? value.actor_email, status: value.status,
    startAt: start ? new Date(start) : undefined,
    // Date-only values cover the entire UTC day; timestamps are inclusive to millisecond precision.
    endBefore: end ? new Date(new Date(end).getTime() + (end.length === 10 ? 86_400_000 : 1)) : undefined,
  };
});

export const allowlistSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  role: z.enum(['admin', 'user']),
}).strict();

export const applicationSchema = z.object({
  name: labelSchema,
  description: z.string().trim().max(500).default(''),
  redirectUri: z.string().trim().max(2048).url().refine(value => {
    try {
      const url = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password && !url.hash;
    } catch { return false; }
  }, 'Redirect URI must use HTTPS (HTTP is allowed for loopback development only), with no credentials or fragment.'),
}).strict();

export const apiKeySchema = z.object({
  applicationId: idSchema,
  name: labelSchema,
  scopes: z.array(z.enum(['identity:read', 'token:introspect'])).min(1).max(2)
    .refine(scopes => new Set(scopes).size === scopes.length, 'Scopes must be unique.'),
  expiresInDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(365)]),
}).strict();
