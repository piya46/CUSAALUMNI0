import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { lineWebhook } from '../src/controllers/factorController.js';
import { hashToken, seal } from '../src/services/crypto.js';

// Exercise the real signed webhook and model with a transactional in-memory DB
// adapter. No external account, live database or LINE message is used.
test('LINE replies only after a bound decision commits; replay, bad signature and rollback never send a result', async t => {
  const previous={enabled:config.lineMfaEnabled,secret:config.lineMessagingChannelSecret};
  config.lineMfaEnabled=true;config.lineMessagingChannelSecret='synthetic-webhook-secret';
  const id='00000000-1234-4000-8000-000000000001',subject=`U${'1'.repeat(32)}`,choice='a'.repeat(43);
  let status='pending',snapshot=status,committed=false,failAudit=false,failDelivery=false,correct=true,expired=false;
  let replies=0,failures=0,transactions=0;
  const connection={
    beginTransaction:async()=>{snapshot=status;committed=false;transactions++;},
    commit:async()=>{committed=true;},rollback:async()=>{status=snapshot;},release:()=>{},
    execute:async(sql:string,params:any[])=>{
      if(sql.startsWith('SELECT session_id'))return [[{session_id:'session-test'}]];
      if(sql.includes('SELECT s.*'))return [[{id:'session-test',user_id:'user-test',kind:'pending',totp_secret:'synthetic-factor',locked:0}]];
      if(sql.startsWith('SELECT * FROM factor_challenges'))return [[...(!expired&&['pending','approved'].includes(status)?[{status,payload:seal(JSON.stringify({factor:hashToken('synthetic-factor'),subjectHash:hashToken(`line:${subject}`),choices:[{hash:hashToken(choice),correct}]}))}]:[])]];
      if(sql.startsWith('SELECT user_id FROM line_identities'))return [[{user_id:'user-test'}]];
      if(sql.startsWith('UPDATE factor_challenges')){status=params[0];return [{affectedRows:1}];}
      if(sql.startsWith('UPDATE users SET mfa_failed_attempts')){failures++;return [{affectedRows:1}];}
      if(sql.startsWith('INSERT INTO audit_outbox')){if(failAudit)throw new Error('audit unavailable');return [{affectedRows:1}];}
      throw new Error('Unexpected SQL in webhook: '+sql); // In particular, no session promotion.
    },
  };
  t.mock.method(pool,'getConnection',async()=>connection as any);
  t.mock.method(globalThis,'fetch',async(url:unknown,options:RequestInit)=>{
    replies++;assert.ok(committed);assert.equal(url,'https://api.line.me/v2/bot/message/reply');
    assert.equal(JSON.parse(String(options.body)).replyToken,'synthetic-reply');
    if(failDelivery)throw new Error('private-provider-token');
    return Response.json({});
  });
  const warnings:string[]=[];t.mock.method(console,'warn',(message:string)=>warnings.push(message));
  async function deliver({sender=subject,badSignature=false}={}){
    const raw=Buffer.from(JSON.stringify({events:[{type:'postback',timestamp:Date.now(),replyToken:'synthetic-reply',source:{type:'user',userId:sender},postback:{data:`cusa_mfa=${id}&choice=${choice}`}}]}));
    const signature=createHmac('sha256',config.lineMessagingChannelSecret).update(raw).digest('base64');
    const req:any={body:raw,ip:'127.0.0.1',socket:{remoteAddress:'127.0.0.1'},get:(name:string)=>name==='x-line-signature'?(badSignature?'invalid':signature):undefined};
    let response:unknown;await lineWebhook(req,{json:(value:unknown)=>{response=value;}} as any);assert.deepEqual(response,{ok:true});
  }
  try{
    await assert.rejects(deliver({badSignature:true}),{code:'INVALID_SIGNATURE'});assert.equal(transactions,0);assert.equal(replies,0);
    await deliver({sender:`U${'2'.repeat(32)}`});assert.equal(status,'pending');assert.equal(replies,0);
    expired=true;await deliver();assert.equal(status,'pending');assert.equal(replies,0);expired=false;
    failAudit=true;await assert.rejects(deliver(),{message:'audit unavailable'});assert.equal(status,'pending');assert.equal(replies,0);failAudit=false;
    await deliver();assert.equal(status,'approved');assert.equal(replies,1);
    await deliver();assert.equal(status,'approved');assert.equal(replies,1);
    status='pending';correct=false;await deliver();assert.equal(status,'denied');assert.equal(replies,2);assert.equal(failures,1);
    await deliver();assert.equal(failures,1);assert.equal(replies,2);
    status='pending';correct=true;failDelivery=true;await deliver();assert.equal(status,'approved');assert.equal(replies,3);
    assert.equal(warnings.length,1);assert.ok(!warnings.join('').includes('private-provider-token'));
    await deliver();assert.equal(replies,3);
  }finally{config.lineMfaEnabled=previous.enabled;config.lineMessagingChannelSecret=previous.secret;}
});
