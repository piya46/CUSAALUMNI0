import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPhoneClaims } from '../src/services/firebasePhone.js';
import { staticCachePolicy } from '../src/services/staticCache.js';
test('only hashed Vite assets receive immutable cache; HTML, documents and outside paths revalidate',()=>{
  assert.equal(staticCachePolicy('/app/web/dist/assets/index-AbCd1234.js','/app/web/dist'),'public, max-age=31536000, immutable');
  for(const file of ['index.html','openapi.json','assets/index.js','assets/manual.html','../outside-AbCd1234.js'])assert.equal(staticCachePolicy(`/app/web/dist/${file}`,'/app/web/dist'),'no-cache');
});
test('Firebase phone claims require fresh phone authentication, not a different sign-in provider or refreshed old token',()=>{
  const valid={uid:'synthetic',phone_number:'+66812345678',auth_time:1000,firebase:{sign_in_provider:'phone'}} as any;
  assert.equal(assertPhoneClaims(valid,1001).phone,'+66812345678');
  for(const claims of [{...valid,auth_time:800},{...valid,auth_time:1200},{...valid,firebase:{sign_in_provider:'google.com'}},{...valid,phone_number:undefined}])assert.throws(()=>assertPhoneClaims(claims,1001),{code:'INVALID_PHONE_PROOF'});
});
