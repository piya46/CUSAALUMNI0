import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingMessage, matchingResultMessage, lineReference } from '../src/services/lineMessages.js';
import { sendLineMatching, replyLineDecision } from '../src/services/line.js';

const id = '00000000-1234-4000-8000-000000000001';
const choices = [
  { label: '42', value: 'a'.repeat(43) }, { label: '12', value: 'b'.repeat(43) },
  { label: '73', value: 'c'.repeat(43) }, { label: 'ปฏิเสธ', value: 'd'.repeat(43) },
];

test('LINE Flex keeps all opaque postbacks, denial, purpose and matching Ref without identifying the correct choice', () => {
  const message = matchingMessage(id, choices, 'Alumni tickets');
  const json = JSON.stringify(message);
  assert.equal(message.type, 'flex'); assert.ok(json.includes('Alumni tickets'));
  assert.ok(json.includes(lineReference(id))); assert.ok(json.includes('หมดอายุใน 3 นาที'));
  const footer = message.contents.footer.contents as any[];
  const buttons = [...footer[0].contents, footer[1]];
  assert.equal(buttons.length, 4);
  for (const [index, button] of buttons.entries()) {
    const action = button.action, params = new URLSearchParams(action.data);
    assert.equal(action.type, 'postback'); assert.equal(action.label, choices[index].label);
    assert.equal(params.get('choice'), choices[index].value); assert.equal(params.get('cusa_mfa'), id);
    assert.doesNotMatch(action.displayText, /สำเร็จ/); // Only the originating browser can finish authentication.
  }
  assert.equal(buttons[0].color, buttons[1].color); assert.equal(buttons[0].color, buttons[2].color);
  assert.doesNotMatch(json, /correct|https?:\/\//);
});

test('decision cards report the committed outcome without replay controls or claiming an authenticated browser', () => {
  for(const decision of ['approved','denied'] as const){
    const message=matchingResultMessage(id,decision),json=JSON.stringify(message);
    assert.ok(json.includes(lineReference(id)));
    assert.ok(json.includes(decision==='approved'?'ยืนยันเลขสำเร็จ':'คำขอถูกปฏิเสธ'));
    assert.doesNotMatch(json,/postback|cusa_mfa|choice=|เข้าสู่ระบบสำเร็จ/);
  }
});

test('LINE decision uses a single-use reply token and never falls back to push on failure', async () => {
  const realFetch=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async(url,options)=>{
      calls++;assert.equal(url,'https://api.line.me/v2/bot/message/reply');assert.ok(options?.signal);
      const body=JSON.parse(String(options?.body));assert.equal(body.replyToken,'synthetic-reply-token');
      assert.equal(body.messages[0].type,'flex');return new Response('private error',{status:400});
    };
    await assert.rejects(replyLineDecision('synthetic-reply-token',id,'approved'),{message:'LINE_REPLY_UNAVAILABLE'});
    assert.equal(calls,1);
  }finally{globalThis.fetch=realFetch;}
});

test('Flex push retains retry idempotency, timeout and bounded provider failure without a live send', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.line.me/v2/bot/message/push');
      assert.equal(new Headers(options?.headers).get('X-Line-Retry-Key'), id);
      assert.ok(options?.signal); assert.equal(options?.redirect, 'error');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.to, 'synthetic-subject'); assert.equal(body.messages[0].type, 'flex');
      return Response.json({});
    };
    await sendLineMatching('synthetic-subject', id, choices);
    globalThis.fetch = async () => new Response('private-provider-detail', { status: 400 });
    await assert.rejects(sendLineMatching('synthetic-subject', id, choices), { message: 'LINE_DELIVERY_UNAVAILABLE' });
  } finally { globalThis.fetch = realFetch; }
});
