import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config.js';
import { queueRedis, closeQueueRedis } from '../src/services/queueRedis.js';
import { closeRateLimitStore } from '../src/services/rateLimitStore.js';
import { visitQueue, queueKeys } from '../src/services/waitingRoom.js';
import { randomToken, hashToken, seal } from '../src/services/crypto.js';
import { queueCookie } from '../src/controllers/waitingRoomController.js';
import type { QueueApplication } from '../src/models/waitingRoomModel.js';
import { updateQueueSettings, queueApplication } from '../src/models/waitingRoomModel.js';
import { execute, query, pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import * as auth from '../src/models/authModel.js';
import { sessionCookie } from '../src/middleware/security.js';
import { pkceChallenge } from '../src/models/ssoModel.js';

const enabled=process.env.RUN_QUEUE_TESTS==='1' && process.env.RUN_DB_TESTS==='1';
if(enabled){
  const url=new URL(process.env.QUEUE_TEST_REDIS_URL??'');
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='36380')throw new Error('Queue tests require dedicated local Redis on 36380');
  config.redisUrl=url.toString();config.configured=true;
}
const apps:QueueApplication[]=[], users:Array<{userId:string;email:string}>=[], keys=new Set<string>();
function appFixture(overrides:Partial<QueueApplication>={}):QueueApplication {
  const app={id:randomUUID(),name:'Synthetic queue app',redirectUri:'https://app.example.test/callback',enabled:true,rate:100,capacity:100,ipLimit:10,...overrides};apps.push(app);return app;
}
async function visit(app:QueueApplication,browser:string,op:'join'|'check'|'consume'='join',user='',ip='127.0.0.1',flow='flow-one') {
  queueKeys(app.id,ip).forEach(key=>keys.add(key));return visitQueue(app,browser,ip,flow,op,user);
}
function returnTo(app:QueueApplication){return '/api/sso/authorize?'+new URLSearchParams({client_id:app.id,redirect_uri:app.redirectUri,response_type:'code',state:randomToken(),code_challenge:pkceChallenge(randomToken()),code_challenge_method:'S256'});}
async function user(role='user') {
  const email=`queue-${randomUUID()}@example.test`;
  await execute('INSERT INTO allowed_emails(id,email,role) VALUES (?,?,?)',[randomUUID(),email,role]);
  const session=await auth.startGoogleSession({sub:randomUUID(),email,name:'Synthetic queue user',avatar:null});assert.ok(session);users.push({...session,email});
  await execute('UPDATE users SET totp_secret=? WHERE id=?',[seal('JBSWY3DPEHPK3PXP'),session.userId]);
  await execute("UPDATE sessions SET kind='full',mfa_method='totp',authenticated_at=UTC_TIMESTAMP(3) WHERE id=?",[session.sessionId]);
  const identity=await auth.findSession(session.token);assert.ok(identity);
  return {...session,identity,cookie:`${sessionCookie}=${session.token}`,actor:{userId:session.userId,email,sessionId:session.sessionId}};
}
after(async()=>{
  if(enabled){
    if(keys.size)await (await queueRedis()).del([...keys]);
    for(const app of apps)await execute('DELETE FROM applications WHERE id=?',[app.id]);
    for(const u of users){await execute('DELETE FROM users WHERE id=?',[u.userId]);await execute('DELETE FROM allowed_emails WHERE email=?',[u.email]);}
  }
  await Promise.all([pool.end(),closeQueueRedis(),closeRateLimitStore()]);
});

test('Redis admission is atomic across tabs, bound to Service and consumed once per account', {skip:!enabled},async()=>{
  const app=appFixture(),browser=randomToken(),other=randomToken(),account=randomUUID();
  const joined=await Promise.all(Array.from({length:20},()=>visit(app,browser)));
  assert.equal(new Set(joined.map(x=>x.reference)).size,1);
  assert.equal(await (await queueRedis()).hLen(queueKeys(app.id,'127.0.0.1')[2]),1);
  assert.ok(joined.every(x=>x.status==='admitted'));
  assert.equal((await visit(app,randomToken(),'check')).status,'missing');
  const consumed=await Promise.all(Array.from({length:10},()=>visit(app,browser,'consume',account)));
  assert.equal(consumed.filter(x=>x.status==='consumed').length,1);
  assert.equal((await visit(app,browser)).status,'completed');
  await visit(app,other);assert.equal((await visit(app,other,'consume',account)).status,'duplicate_account');
  const second=appFixture();await visit(second,browser);assert.equal((await visit(second,browser,'consume',account)).status,'consumed');
});

test('FIFO release has a shared bounded budget and expired tickets cannot authorize', {skip:!enabled},async()=>{
  const app=appFixture({rate:1,ipLimit:100}),redis=await queueRedis();
  // Begin near a second boundary to exercise one dispatch window deterministically.
  await new Promise(resolve=>setTimeout(resolve,1020-Date.now()%1000));
  const before=Math.floor(Date.now()/1000),browsers=Array.from({length:20},()=>randomToken());
  const results=await Promise.all(browsers.map(b=>visit(app,b)));
  const after=Math.floor(Date.now()/1000);
  assert.ok(results.filter(x=>x.status==='admitted').length<=after-before+1);
  assert.equal(results[0].status,'admitted');
  const names=queueKeys(app.id,'127.0.0.1');
  const next=(await redis.zRange(names[0],0,0))[0];assert.ok(next);
  await redis.hSet(names[3],{window:'0',sent:'0'});
  await visit(app,browsers[0],'check');
  assert.equal(JSON.parse((await redis.hGet(names[2],next))!).state,'admitted');
  const id=hashToken(`queue:${app.id}:${browsers[0]}`);
  await redis.hSet(names[2],id,JSON.stringify({state:'admitted',expires:Date.now()-1000,flow:'expired'}));
  await redis.zAdd(names[1],{score:Date.now()-1000,value:id});
  assert.equal((await visit(app,browsers[0],'consume',randomUUID())).status,'missing');
});

test('capacity/IP quotas bound Redis state without joining a new ticket on refresh', {skip:!enabled},async()=>{
  const app=appFixture({capacity:2,ipLimit:1}),browser=randomToken();
  await visit(app,browser);assert.equal((await visit(app,browser)).status,'admitted');
  assert.equal((await visit(app,randomToken())).status,'ip_limit');
  assert.equal((await visit(app,randomToken(),'join','','127.0.0.2')).status,'admitted');
  assert.equal((await visit(app,randomToken(),'join','','127.0.0.3')).status,'full');
  for(const key of queueKeys(app.id,'127.0.0.1').slice(0,5)){const ttl=await (await queueRedis()).pTTL(key);assert.ok(ttl>0||ttl===-2);}
});

test('HTTP rejects queue bypass, cross-origin joins, stale admin MFA and policy audit failure', {skip:!enabled},async()=>{
  const app=appFixture(),owner=await user(),admin=await user('admin'),web=createApp(),path=returnTo(app);
  await execute('INSERT INTO applications(id,name,redirect_uri,queue_enabled,queue_rate) VALUES (?,?,?,?,?)',[app.id,app.name,app.redirectUri,1,100]);
  const role=randomUUID();await execute('INSERT INTO application_roles(id,application_id,code,name) VALUES (?,?,?,?)',[role,app.id,'member','Member']);
  await execute('INSERT INTO application_memberships(application_id,user_id) VALUES (?,?)',[app.id,owner.userId]);
  await execute('INSERT INTO application_member_roles(application_id,user_id,role_id) VALUES (?,?,?)',[app.id,owner.userId,role]);
  const bypass=await request(web).get(path).set('Cookie',owner.cookie).expect(303);assert.match(bypass.headers.location,/^\/waiting\?/);
  assert.equal((await query('SELECT code_hash FROM authorization_codes WHERE application_id=?',[app.id])).length,0);
  await request(web).get('/api/auth/google/start').query({returnTo:path}).expect(303).expect('Location',/^\/waiting\?/);
  await request(web).post('/api/queue/visit').set('Origin','https://evil.test').set('X-CUSA-Queue','1').send({returnTo:path}).expect(403);
  const session=await request(web).get('/api/queue/session').expect(200);
  const cookie=(session.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  assert.match(session.headers['set-cookie'].join(';'),/HttpOnly/);assert.match(session.headers['set-cookie'].join(';'),/SameSite=Lax/);
  const joined=await request(web).post('/api/queue/visit').set('Cookie',cookie).set('Origin',config.appOrigin).set('X-CUSA-Queue','1').send({returnTo:path}).expect(200);
  assert.equal(joined.body.status,'admitted');queueKeys(app.id,'127.0.0.1').forEach(k=>keys.add(k));
  await request(web).get(path).set('Cookie',cookie).expect(303).expect('Location',/^\/login\?/);
  assert.equal((await query('SELECT code_hash FROM authorization_codes WHERE application_id=?',[app.id])).length,0);
  const granted=await request(web).get(path).set('Cookie',`${owner.cookie}; ${cookie}`).expect(303);
  assert.equal(new URL(granted.headers.location).origin,'https://app.example.test');
  await request(web).get(path).set('Cookie',`${owner.cookie}; ${cookie}`).expect(303).expect('Location',/^\/waiting\?/);
  const settings={enabled:false,rate:2,capacity:2000,ipLimit:10};
  await request(web).put(`/api/admin/applications/${app.id}/queue`).set('Cookie',owner.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',owner.identity.csrfToken).send(settings).expect(403);
  await assert.rejects(updateQueueSettings(admin.actor,app.id,settings,async()=>{throw new Error('audit unavailable');}));
  assert.equal((await queueApplication(app.id)).enabled,true);
  await request(web).put(`/api/admin/applications/${app.id}/queue`).set('Cookie',admin.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',admin.identity.csrfToken).send({...settings,enabled:true,rate:3}).expect(200);
  assert.equal((await queueApplication(app.id)).rate,3);
  await execute('UPDATE sessions SET authenticated_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 6 MINUTE) WHERE id=?',[admin.sessionId]);
  await request(web).put(`/api/admin/applications/${app.id}/queue`).set('Cookie',admin.cookie).set('Origin',config.appOrigin).set('X-CSRF-Token',admin.identity.csrfToken).send(settings).expect(403);
});

test('configured queue fails closed when Redis is unavailable', {skip:!enabled},async()=>{
  const app=appFixture();await execute('INSERT INTO applications(id,name,redirect_uri,queue_enabled) VALUES (?,?,?,1)',[app.id,app.name,app.redirectUri]);
  await closeQueueRedis();const previous=config.redisUrl;config.redisUrl='';
  try{
    const web=createApp(),path=returnTo(app);
    await request(web).post('/api/queue/visit').set('Cookie',`${queueCookie}=${randomToken()}`).set('Origin',config.appOrigin).set('X-CUSA-Queue','1').send({returnTo:path}).expect(503);
  }finally{config.redisUrl=previous;}
});
