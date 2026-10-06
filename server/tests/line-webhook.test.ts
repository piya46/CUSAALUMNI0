import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { lineWebhook } from '../src/controllers/factorController.js';
import { hashToken, seal } from '../src/services/crypto.js';

// Exercise the real signed webhook and model with a transactional in-memory DB
// adapter. No external account, live database or LINE message is used.
test('LINE loads and replies after a bound decision commits; replay and invalid proofs stay silent; loading failure preserves the result', async t => {
  const previous={lineMfaEnabled:config.lineMfaEnabled,lineMessagingChannelSecret:config.lineMessagingChannelSecret,lineWebhookDestination:config.lineWebhookDestination,lineWebhookGatewayToken:config.lineWebhookGatewayToken};
  Object.assign(config,{lineMfaEnabled:true,lineMessagingChannelSecret:'synthetic-webhook-secret',lineWebhookDestination:`U${'0'.repeat(32)}`,lineWebhookGatewayToken:'g'.repeat(43)});
  const id='00000000-1234-4000-8000-000000000001',subject=`U${'1'.repeat(32)}`,choice='a'.repeat(43);
  let status='pending',snapshot=status,committed=false,failAudit=false,failDelivery=false,failLoading=false,correct=true,expired=false;
  let replies=0,loadings=0,failures=0,transactions=0;
  const effects:string[]=[];
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
    assert.ok(committed);
    if(url==='https://api.line.me/v2/bot/chat/loading/start'){
      loadings++;effects.push('loading');
      assert.deepEqual(JSON.parse(String(options.body)),{chatId:subject,loadingSeconds:5});
      if(failLoading)throw new Error('private-loading-token');
      return Response.json({},{status:202});
    }
    effects.push('reply');
    replies++;assert.ok(committed);assert.equal(url,'https://api.line.me/v2/bot/message/reply');
    assert.equal(JSON.parse(String(options.body)).replyToken,'synthetic-reply');
    if(failDelivery)throw new Error('private-provider-token');
    return Response.json({});
  });
  const warnings:string[]=[];t.mock.method(console,'warn',(message:string)=>warnings.push(message));
  async function deliver({sender=subject,badSignature=false,data=`cusa_mfa=${id}&choice=${choice}`,redelivery=false,replyToken='synthetic-reply'}={}){
    const raw=Buffer.from(JSON.stringify({destination:config.lineWebhookDestination,events:[
      {type:'accountLink',link:{result:'failed'}},null,{type:'postback',source:null},
      {type:'message',message:{type:'text',text:'42'}},
      {type:'postback',timestamp:Date.now(),replyToken,source:{type:'user',userId:sender},postback:{data},deliveryContext:{isRedelivery:redelivery}},
      {type:'follow'},
    ]}));
    const signature=createHmac('sha256',config.lineMessagingChannelSecret).update(raw).digest('base64');
    const req:any={body:raw,ip:'127.0.0.1',socket:{remoteAddress:'127.0.0.1'},get:(name:string)=>name==='x-line-signature'?(badSignature?'invalid':signature):name==='authorization'?`Bearer ${config.lineWebhookGatewayToken}`:undefined};
    let response:unknown;await lineWebhook(req,{json:(value:unknown)=>{response=value;}} as any);assert.deepEqual(response,{ok:true});
  }
  try{
    await assert.rejects(deliver({badSignature:true}),{code:'INVALID_SIGNATURE'});assert.equal(transactions,0);assert.equal(replies,0);
    await deliver({data:`cusa_mfa=${id}&choice=${choice}&%63hoice=${choice}`});assert.equal(transactions,0);assert.equal(status,'pending');
    await deliver({data:`cusa_mfa=${id}&choice=${'b'.repeat(43)}`});assert.equal(status,'pending');assert.equal(replies,0);
    await deliver({sender:`U${'2'.repeat(32)}`});assert.equal(status,'pending');assert.equal(replies,0);
    expired=true;await deliver();assert.equal(status,'pending');assert.equal(replies,0);expired=false;
    failAudit=true;await assert.rejects(deliver(),{message:'audit unavailable'});assert.equal(status,'pending');assert.equal(replies,0);failAudit=false;assert.equal(loadings,0);
    await deliver({redelivery:true});assert.equal(status,'approved');assert.equal(replies,1);assert.equal(loadings,1);
    assert.deepEqual(effects,['loading','reply']);
    await deliver({redelivery:true});assert.equal(status,'approved');assert.equal(replies,1);assert.equal(loadings,1);
    status='pending';correct=false;await deliver();assert.equal(status,'denied');assert.equal(replies,2);assert.equal(failures,1);assert.equal(loadings,2);
    await deliver();assert.equal(failures,1);assert.equal(replies,2);assert.equal(loadings,2);
    status='pending';correct=true;failDelivery=true;await deliver();assert.equal(status,'approved');assert.equal(replies,3);assert.equal(loadings,3);
    assert.equal(warnings.length,1);assert.ok(!warnings.join('').includes('private-provider-token'));
    await deliver();assert.equal(replies,3);assert.equal(loadings,3);
    status='pending';failDelivery=false;failLoading=true;await deliver();assert.equal(status,'approved');assert.equal(replies,4);assert.equal(loadings,4);
    assert.equal(warnings.length,2);assert.ok(warnings[1].includes('LINE_LOADING_UNAVAILABLE'));assert.ok(!warnings.join('').includes('private-loading-token'));
    await deliver();assert.equal(replies,4);assert.equal(loadings,4);
    assert.deepEqual(effects,['loading','reply','loading','reply','loading','reply','loading','reply']);
    status='pending';await deliver({replyToken:''});assert.equal(status,'approved');assert.equal(replies,4);assert.equal(loadings,4);
  }finally{Object.assign(config,previous);}
});
