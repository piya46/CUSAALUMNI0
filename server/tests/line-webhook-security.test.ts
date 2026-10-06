import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { readLineWebhook, lineMfaPostback } from '../src/services/lineWebhook.js';

const destination = `U${'0'.repeat(32)}`, subject = `U${'1'.repeat(32)}`;
const id = '00000000-1234-4000-8000-000000000001', choice = 'a'.repeat(43);
const data = `cusa_mfa=${id}&choice=${choice}`;
function settings(t: TestContext) {
  const previous = { ...config };
  Object.assign(config, { nodeEnv: 'test', configured: true, installEnabled: false,
    lineMfaEnabled: true, lineMessagingChannelSecret: 'synthetic-webhook-secret',
    lineWebhookDestination: destination, lineWebhookGatewayToken: '' });
  t.after(() => { Object.assign(config, previous); });
}
const sign = (raw: Buffer | string) => createHmac('sha256', config.lineMessagingChannelSecret).update(raw).digest('base64');
const envelope = (events: unknown[] = []) => Buffer.from(JSON.stringify({ destination, events }));
const event = (timestamp = Date.now()) => ({ type: 'postback', timestamp, mode: 'active',
  source: { type: 'user', userId: subject }, postback: { data }, replyToken: 'synthetic-reply' });

test('raw LINE signature remains mandatory after proxying; reserialization, filtering and pre-parsed bodies fail', t => {
  settings(t);
  const raw = Buffer.from(`{ "destination": "${destination}", "events": [${JSON.stringify(event())}, {"type":"message","message":{"text":"สวัสดี\\n42"}}] }\n`);
  const signature = sign(raw);
  assert.equal(readLineWebhook(raw, signature, undefined).events.length, 2);
  for (const modified of [Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), envelope([event()]), JSON.parse(raw.toString())]) {
    assert.throws(() => readLineWebhook(modified, signature, undefined), { code: 'INVALID_SIGNATURE' });
  }
  for (const invalid of [undefined, '', 'invalid', signature + ', ' + signature]) {
    assert.throws(() => readLineWebhook(raw, invalid, undefined), { code: 'INVALID_SIGNATURE' });
  }
  config.lineMfaEnabled = false;
  assert.throws(() => readLineWebhook(raw, signature, undefined), { code: 'NOT_FOUND' });
});

test('gateway bearer and pinned destination are additional checks, never replacements for LINE verification', t => {
  settings(t);
  config.lineWebhookGatewayToken = 'g'.repeat(43);
  const raw = envelope(), signature = sign(raw), authorization = `Bearer ${config.lineWebhookGatewayToken}`;
  for (const invalid of [undefined, '', `Bearer ${'h'.repeat(43)}`, `Bearer ${'G'.repeat(43)}`, `Basic ${config.lineWebhookGatewayToken}`, authorization + ', ' + authorization]) {
    assert.throws(() => readLineWebhook(raw, signature, invalid), { code: 'INVALID_GATEWAY_TOKEN' });
  }
  assert.deepEqual(readLineWebhook(raw, signature, authorization).events, []);
  assert.throws(() => readLineWebhook(raw, undefined, authorization), { code: 'INVALID_SIGNATURE' });
  assert.throws(() => readLineWebhook(Buffer.concat([raw, Buffer.from(' ')]), signature, authorization), { code: 'INVALID_SIGNATURE' });
  const otherBot = Buffer.from(JSON.stringify({ destination: subject, events: [] }));
  assert.throws(() => readLineWebhook(otherBot, sign(otherBot), authorization), { code: 'INVALID_WEBHOOK_DESTINATION' });
  config.lineWebhookGatewayToken = '';
  assert.deepEqual(readLineWebhook(raw, signature, undefined).events, []);
});

test('valid empty verification and mixed batches are accepted; malformed or oversized envelopes fail', t => {
  settings(t);
  for (const events of [[], [{ type: 'accountLink', link: { result: 'failed' } }, null, event()]]) {
    const raw = envelope(events);
    assert.deepEqual(readLineWebhook(raw, sign(raw), undefined).events, events);
  }
  for (const body of [null, {}, { events: [] }, { destination: '@bot', events: [] }, { destination, events: {} }, { destination, events: Array(101).fill(null) }]) {
    const raw = Buffer.from(JSON.stringify(body));
    assert.throws(() => readLineWebhook(raw, sign(raw), undefined), { code: 'VALIDATION_ERROR' });
  }
  const badJson = Buffer.from('{invalid');
  assert.throws(() => readLineWebhook(badJson, sign(badJson), undefined), { code: 'VALIDATION_ERROR' });
});

test('MFA parsing rejects ambiguous parameters and ineligible events without breaking later items', () => {
  const now = Date.now(), valid = event(now);
  const expected = { challengeId: id, choice, subject, replyToken: 'synthetic-reply' };
  assert.deepEqual(lineMfaPostback(valid, now), expected);
  assert.deepEqual(lineMfaPostback({ ...valid, postback: { data: `choice=${choice}&cusa_mfa=${id}` } }, now), expected);
  assert.deepEqual(lineMfaPostback({ ...valid, deliveryContext: { isRedelivery: true } }, now), expected);
  const invalidData = [
    `choice=${choice}`, `cusa_mfa=${id}`, `cusa_mfa=not-a-uuid&choice=${choice}`,
    `cusa_mfa=${id}&choice=42`, `cusa_mfa=${id}&choice=deny`,
    data + `&cusa_mfa=${id}`, data + `&choice=${choice}`, data + `&%63hoice=${choice}`,
    data + `&%63usa_mfa=${id}`, data + '&action=approve', data + '&' + 'x'.repeat(300),
    `cusa_mfa=${id}&choice=${'a'.repeat(44)}`, `cusa_mfa=${id}&choice=${'a'.repeat(42)}!`,
  ];
  const invalidEvents = [null, [], 42, {}, { type: 'accountLink', link: { result: 'failed' } },
    { ...valid, type: 'message' }, { ...valid, source: null },
    ...['group', 'room'].map(type => ({ ...valid, source: { type, userId: subject } })),
    { ...valid, source: { type: 'user' } }, { ...valid, source: { type: 'user', userId: 'not-a-user' } },
    { ...valid, mode: 'standby' }, { ...valid, postback: { data: 42 } },
    ...[now - 180001, now + 180001, -1, now + 0.5, String(now), NaN, Infinity].map(timestamp => ({ ...valid, timestamp })),
    ...invalidData.map(data => ({ ...valid, postback: { data } })),
  ];
  for (const input of invalidEvents) assert.equal(lineMfaPostback(input, now), undefined);
  assert.deepEqual([...invalidEvents, valid].map(input => lineMfaPostback(input, now)).filter(Boolean), [expected]);
  assert.deepEqual(lineMfaPostback({ ...valid, replyToken: null }, now), { ...expected, replyToken: undefined });
});

test('HTTP central forwarding keeps raw bytes, enforces both credentials, and bounds the request body', async t => {
  settings(t);
  config.lineWebhookGatewayToken = 'g'.repeat(43);
  const logs: string[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => logs.push(values.join(' ')));
  t.mock.method(pool, 'execute', async (sql: string) => {
    assert.ok(sql.startsWith('INSERT INTO audit_outbox'), 'Only redacted request-failure audit is allowed');
    return [{ affectedRows: 1 }, []] as any;
  });
  t.mock.method(pool, 'getConnection', async () => { throw new Error('No MFA decision should reach the database'); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No LINE reply should be sent'); });
  const app = createApp(), raw = envelope().toString(), signature = sign(raw);
  const authorization = `Bearer ${config.lineWebhookGatewayToken}`;
  const send = (body: string, auth?: string, sig?: string) => {
    const req = request(app).post('/api/auth/line/webhook').set('Content-Type', 'application/json');
    if (auth) req.set('Authorization', auth);
    if (sig) req.set('X-Line-Signature', sig);
    return req.send(body);
  };
  const ok = await send(raw, authorization, signature).expect(200);
  assert.deepEqual(ok.body, { ok: true });assert.equal(ok.headers['set-cookie'], undefined);
  assert.equal((await send(raw, undefined, signature).expect(401)).body.code, 'INVALID_GATEWAY_TOKEN');
  assert.equal((await send(raw, authorization).expect(401)).body.code, 'INVALID_SIGNATURE');
  assert.equal((await send(raw + ' ', authorization, signature).expect(401)).body.code, 'INVALID_SIGNATURE');
  const forged = await request(app).post('/api/auth/line/webhook').set('Content-Type', 'application/json')
    .set('X-Line-Signature', signature).set('X-Webhook-Verified', 'true').set('X-Forwarded-For', '127.0.0.1').send(raw).expect(401);
  assert.equal(forged.body.code, 'INVALID_GATEWAY_TOKEN');
  const other = JSON.stringify({ destination: subject, events: [] });
  assert.equal((await send(other, authorization, sign(other)).expect(401)).body.code, 'INVALID_WEBHOOK_DESTINATION');
  const oversized = JSON.stringify({ destination, events: [], padding: 'x'.repeat(65536) });
  assert.equal((await send(oversized, authorization, sign(oversized)).expect(413)).body.code, 'WEBHOOK_TOO_LARGE');
  const compressed = await request(app).post('/api/auth/line/webhook').set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip').set('Authorization', authorization).set('X-Line-Signature', signature).send(raw).expect(415);
  assert.equal(compressed.body.code, 'INVALID_WEBHOOK_ENCODING');
  for (const secret of [config.lineWebhookGatewayToken, config.lineMessagingChannelSecret, signature]) assert.ok(!logs.join('\n').includes(secret));
});
