import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseAuthorizationReturnTo } from '../src/services/authorizationRequest.js';
import { randomToken } from '../src/services/crypto.js';
import { queueSettingsSchema } from '../src/models/waitingRoomModel.js';
test('queue request preserves PKCE/callback binding and rejects duplicate/unknown/unsafe parameters',()=>{
  const params=new URLSearchParams({client_id:randomUUID(),redirect_uri:'https://app.example.test/callback',response_type:'code',state:randomToken(),code_challenge_method:'S256',code_challenge:randomToken(),scope:'identity:read profile email'});
  const path='/api/sso/authorize?'+params;
  assert.equal(parseAuthorizationReturnTo(path).returnTo,path);
  for(const bad of ['https://evil.test'+path,'//evil.test'+path,path+'&client_id='+randomUUID(),path+'&skip_queue=true',path+'#fragment',path.replace('S256','plain')])assert.throws(()=>parseAuthorizationReturnTo(bad));
  for(const bad of [{enabled:true,rate:0,capacity:2000,ipLimit:10},{enabled:true,rate:101,capacity:2000,ipLimit:10},{enabled:true,rate:2,capacity:1000000,ipLimit:10},{enabled:true,rate:2,capacity:2000,ipLimit:0}])assert.equal(queueSettingsSchema.safeParse(bad).success,false);
});
