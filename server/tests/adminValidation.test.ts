import test from 'node:test';
import assert from 'node:assert/strict';
import { allowlistSchema, applicationSchema, apiKeySchema, paginationSchema, auditFilterSchema } from '../src/controllers/adminValidation.js';

test('allowlist normalizes email and rejects unauthorized fields or roles', () => {
  assert.deepEqual(allowlistSchema.parse({ email: '  Operator@Example.com  ', role: 'user' }), { email: 'operator@example.com', role: 'user' });
  assert.equal(allowlistSchema.safeParse({ email: 'person@example.com', role: 'superadmin' }).success, false);
  assert.equal(allowlistSchema.safeParse({ email: 'person@example.com', role: 'user', totp_secret: 'injected' }).success, false);
  assert.equal(allowlistSchema.safeParse({ email: 'broken', role: 'user' }).success, false);
});

test('applications reject unsafe callbacks and accept HTTPS or exact local development hosts', () => {
  for (const redirectUri of ['https://app.example.com/callback', 'http://localhost:3000/callback', 'http://127.0.0.1:8080/callback', 'http://[::1]:8080/callback']) {
    assert.equal(applicationSchema.safeParse({ name: 'Portal', redirectUri }).success, true, redirectUri);
  }
  for (const redirectUri of ['javascript:alert(1)', 'http://app.example.com/callback', 'https://a.example.com/#fragment', 'https://user:secret@app.example.com/callback', 'http://localhost.example.com/callback']) {
    assert.equal(applicationSchema.safeParse({ name: 'Portal', redirectUri }).success, false, redirectUri);
  }
});

test('API keys require valid application, explicit narrow scopes and bounded expiry', () => {
  const valid = { applicationId: '19bd9217-0630-45d1-92d4-cc090bd7a420', name: 'Backend', scopes: ['identity:read', 'token:introspect'], expiresInDays: 30 };
  assert.equal(apiKeySchema.safeParse(valid).success, true);
  for (const changes of [{ scopes: ['admin:*'] }, { scopes: [] }, { scopes: ['identity:read', 'identity:read'] }, { expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: '30' }, { applicationId: 'bad-id' }, { key_hash: 'injected' }]) {
    assert.equal(apiKeySchema.safeParse({ ...valid, ...changes }).success, false, JSON.stringify(changes));
  }
});

test('pagination bounds workload and rejects malformed or array query parameters', () => {
  assert.deepEqual(paginationSchema.parse({}), { page: 1, limit: 20, search: '' });
  assert.deepEqual(paginationSchema.parse({ page: '2', limit: '100', search: ' ops ' }), { page: 2, limit: 100, search: 'ops' });
  for (const input of [{ page: '0' }, { page: '-1' }, { page: '2.5' }, { limit: '101' }, { limit: ['20'] }, { search: 'x'.repeat(101) }, { page: '1e6' }, { unknown: 'x' }]) {
    assert.equal(paginationSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test('audit filters normalize aliases and include the complete UTC end day', () => {
  const filters = auditFilterSchema.parse({ actor_email: ' ADMIN@Example.com ', start_date: '2026-09-01', end_date: '2026-09-28', status: 'failure' });
  assert.equal(filters.email, 'admin@example.com');
  assert.equal(filters.startAt?.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(filters.endBefore?.toISOString(), '2026-09-29T00:00:00.000Z');
  assert.equal(auditFilterSchema.safeParse({ email: 'one@example.com', actor_email: 'two@example.com' }).success, false);
  assert.equal(auditFilterSchema.safeParse({ startDate: '2026-09-30', endDate: '2026-09-28' }).success, false);
  assert.equal(auditFilterSchema.safeParse({ startDate: '2026-02-30' }).success, false);
  assert.equal(auditFilterSchema.safeParse({ status: 'anything' }).success, false);
});
