import { z } from 'zod';

const opaque = /^[A-Za-z0-9_-]{43}$/;
export const authorizationSchema = z.object({
  client_id: z.uuid(), redirect_uri: z.string().min(1).max(2048),
  response_type: z.literal('code'), state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  code_challenge_method: z.literal('S256'), code_challenge: z.string().regex(opaque)
    .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value),
}).strict();
export function parseAuthorizationReturnTo(value: unknown) {
  const path = z.string().max(3000).refine(s => s.startsWith('/api/sso/authorize?') && !/[\r\n]/.test(s)).parse(value);
  const url = new URL(path, 'https://sso.invalid');
  if (url.hash || url.pathname !== '/api/sso/authorize' || [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size)
    throw new Error('Invalid authorization path');
  const parameters = authorizationSchema.parse(Object.fromEntries(url.searchParams));
  return { parameters, returnTo: `/api/sso/authorize?${new URLSearchParams(parameters)}` };
}
