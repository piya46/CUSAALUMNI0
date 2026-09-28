import test from 'node:test';
import assert from 'node:assert/strict';
import { IntrospectionCache } from '../src/services/introspectionCache.js';
const identity={active:true as const,sub:'u',email:'u@example.com',name:'User',aud:'app',scope:'identity:read',exp:100};
test('introspection cache isolates API keys, coalesces requests and expires after five seconds',async()=>{
  let now=1000,calls=0;const cache=new IntrospectionCache(5000,10,()=>now);
  const load=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return identity;};
  await Promise.all(Array.from({length:20},()=>cache.get('app-a','token',load)));assert.equal(calls,1);
  await cache.get('app-b','token',load);assert.equal(calls,2);
  now=6001;await cache.get('app-a','token',load);assert.equal(calls,3);
});
test('cache never outlives expiry and disabled cache always checks current state',async()=>{
  let now=1000,calls=0;const cache=new IntrospectionCache(5000,10,()=>now);
  const load=async()=>{calls++;return {...identity,exp:2};};
  await cache.get('key','token',load);now=2000;await cache.get('key','token',load);assert.equal(calls,2);
  const disabled=new IntrospectionCache(0);await disabled.get('key','token',load);await disabled.get('key','token',load);assert.equal(calls,4);
});
test('failed authentication and inactive tokens are not cached',async()=>{
  const cache=new IntrospectionCache();let calls=0;
  const inactive=async()=>{calls++;return {active:false as const};};
  await cache.get('key','token',inactive);await cache.get('key','token',inactive);assert.equal(calls,2);
  await assert.rejects(cache.get('key','token',async()=>{throw new Error('invalid client');}));
  await cache.get('key','token',inactive);assert.equal(calls,3);
});
