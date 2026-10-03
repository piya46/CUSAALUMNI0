import { test,expect } from '@playwright/test';
import { firebasePhoneError } from '../../web/src/models/firebasePhoneError';
const member={user:{id:'00000000-0000-4000-8000-000000000001',email:'member@example.test',name:'Test member',role:'user',totpEnabled:true},csrfToken:'test-csrf',requiresMfa:true,mfaMethod:'totp',factors:{passkey:true,line:true,phoneVerified:false}};
test('LINE MFA shows only the issued number, blocks resend and consumes approval through CSRF-protected browser',{timeout:30000},async({page})=>{
  let complete=false,checks=0,sends=0;
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,requiresMfa:!complete,mfaMethod:complete?'line':'totp'}});
    if(path==='/api/auth/line/send'){sends++;return route.fulfill({json:{challengeId:'challenge-test',number:'42',reference:'LN-001122334455',retryAfter:60,expiresIn:180}});}
    if(path==='/api/auth/line/challenges/challenge-test'){checks++;return route.fulfill({json:{status:checks===1?'pending':'approved'}});}
    if(path==='/api/auth/line/verify'){expect(route.request().postDataJSON()).toEqual({challengeId:'challenge-test'});expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');complete=true;return route.fulfill({json:{ok:true}});}
    if(path==='/api/auth/factors')return route.fulfill({json:{passkeyEnabled:true,lineEnabled:true,line:true,phoneEnabled:false,passkeys:[]}});
    return route.fulfill({json:{sessions:[]}});
  });
  await page.setViewportSize({width:390,height:844});await page.goto('/login');
  await expect(page.getByRole('button',{name:'ยืนยันด้วย Passkey'})).toBeVisible();
  await page.getByRole('button',{name:'ยืนยันผ่าน LINE',exact:true}).click();await expect(page.locator('.number-matching strong')).toHaveText('42');await expect(page.getByText('Ref: LN-001122334455')).toBeVisible();
  await expect(page.getByRole('button',{name:/ขอ LINE ใหม่ได้ใน/})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/line-matching-mobile.png',fullPage:true});
  await expect(page.getByRole('heading',{name:'ความปลอดภัย',exact:true})).toBeVisible({timeout:12000});expect(complete).toBe(true);expect(sends).toBe(1);await expect(page.getByRole('status').filter({hasText:'เข้าสู่ระบบสำเร็จ'})).toBeVisible();
});
test('required phone gate blocks application continuation and lists the separate Firebase consent before sending',async({page})=>{
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,requiresMfa:false,phoneRequired:scenario!=='sms-verified',factors:{...member.factors,phoneEnabled:true,phoneVerified:verified}}});
    if(path==='/api/auth/factors')return route.fulfill({json:{passkeys:[],phoneEnabled:true,phoneVerified:verified,firebase:{apiKey:'synthetic',authDomain:'synthetic.firebaseapp.com',projectId:'synthetic',appId:'synthetic'}}});
    return route.fulfill({json:{}});
  });
  await page.goto('/login');await expect(page.getByRole('heading',{name:'ยืนยันเบอร์มือถือครั้งแรก'})).toBeVisible();
  const send=page.getByRole('button',{name:'ส่ง SMS ยืนยันเบอร์'});await expect(send).toBeDisabled();
  await page.getByRole('textbox',{name:'เบอร์มือถือของคุณ'}).fill('081 234 5678');await expect(send).toBeDisabled();
  await page.getByRole('checkbox').check();await expect(send).toBeEnabled();
  await expect(page.getByRole('textbox',{name:'เบอร์มือถือของคุณ'})).toHaveValue('081 234 5678');
  await page.screenshot({path:'test-results/thai-phone-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/thai-phone-mobile.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:320,height:740});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByRole('navigation',{name:'เมนูหลัก'})).toHaveCount(0);
});
test('phone failure diagnostics never expose provider messages, custom data or unknown codes',()=>{
  const sensitive='private-provider-detail-token';
  const known=firebasePhoneError({code:'auth/configuration-not-found',message:sensitive,customData:{token:sensitive}},'send');
  expect(known).toContain('auth/configuration-not-found');expect(known).not.toContain(sensitive);
  for(const error of [null,new Error(sensitive),{code:`auth/${sensitive}`,message:sensitive},{code:'__proto__'}]){
    expect(firebasePhoneError(error,'send')).not.toContain(sensitive);
    expect(firebasePhoneError(error,'verify')).not.toContain(sensitive);
  }
});
for(const scenario of ['configuration','rate-limit','sms-region','sms-sent','sms-verified'] as const)test({'sms-verified':'Optional phone reminder disappears only after Firebase confirmation and server verification',configuration:'Firebase configuration failure shows its safe code and preserves resend cooldown','rate-limit':'phone API rate limit preserves the full Retry-After and does not call Firebase','sms-region':'Firebase SMS region rejection shows a safe support code after reCAPTCHA fallback','sms-sent':'Thai local number reaches Firebase as E.164 and successful SMS reveals six code inputs without bypassing cooldown'}[scenario],async({page})=>{
  const rateLimited=scenario==='rate-limit',smsRejected=scenario==='sms-region',smsSent=scenario==='sms-sent'||scenario==='sms-verified';
  let verified=false;
  let starts=0,params=0,sms=0;
  const unexpected:string[]=[];
  await page.route('**/*',route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(url.hostname==='identitytoolkit.googleapis.com'){
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET, POST, OPTIONS'};
      if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
      if(path==='/v2/recaptchaConfig')return route.fulfill({status:404,headers,json:{error:{code:404,message:'CONFIGURATION_NOT_FOUND'}}});
      if(path==='/v1/recaptchaParams'){params++;return smsRejected||smsSent?route.fulfill({headers,json:{recaptchaSiteKey:'synthetic-site-key'}}):route.fulfill({status:400,headers,json:{error:{code:400,message:'CONFIGURATION_NOT_FOUND : private-provider-detail-token'}}});}
      if(path==='/v1/accounts:sendVerificationCode'){
        sms++;
        expect(route.request().postDataJSON().phoneNumber).toBe('+66812345678');
        if(smsSent)return route.fulfill({headers,json:{sessionInfo:'synthetic-session-info'}});
        if(smsRejected)return route.fulfill({status:400,headers,json:{error:{code:400,message:'OPERATION_NOT_ALLOWED : SMS unable to be sent until this region enabled by the app developer. private-provider-detail-token'}}});
      }
      if(scenario==='sms-verified'&&path==='/v1/accounts:signInWithPhoneNumber'){
        expect(route.request().postDataJSON().code).toBe('012345');
        const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
        const stamp=Math.floor(Date.now()/1000),token=`${encode({alg:'RS256'})}.${encode({sub:'synthetic-uid',iat:stamp,exp:stamp+3600,auth_time:stamp,phone_number:'+66812345678',firebase:{sign_in_provider:'phone'}})}.synthetic-signature`;
        return route.fulfill({headers,json:{localId:'synthetic-uid',idToken:token,refreshToken:'synthetic-refresh',expiresIn:'3600',phoneNumber:'+66812345678'}});
      }
      if(scenario==='sms-verified'&&path==='/v1/accounts:lookup')return route.fulfill({headers,json:{users:[{localId:'synthetic-uid',phoneNumber:'+66812345678',providerUserInfo:[{providerId:'phone',rawId:'+66812345678',phoneNumber:'+66812345678'}]}]}});
      unexpected.push(path);return route.abort();
    }
    if(url.hostname==='www.google.com'&&path==='/recaptcha/api.js'){
      const callback=JSON.stringify(url.searchParams.get('onload'));
      return route.fulfill({contentType:'application/javascript',body:`window.grecaptcha={render:()=>1,reset:()=>{},getResponse:()=> 'synthetic-recaptcha-response',execute:()=>{}};window[${callback}]();`});
    }
    if(url.origin!=='http://127.0.0.1:4188'){unexpected.push(url.hostname);return route.abort();}
    if(route.request().resourceType()==='document')return route.fetch().then(response=>{
      // The shared test server has providers disabled. Match the phone-enabled CSP
      // for the mocked /factors response, keeping the remaining directives intact.
      const headers=response.headers();
      headers['content-security-policy']=headers['content-security-policy']
        .replace("script-src 'self'","script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/")
        .replace("connect-src 'self'","connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com/recaptcha/ https://recaptchaenterprise.googleapis.com");
      return route.fulfill({response,headers});
    });
    if(!path.startsWith('/api/'))return route.continue();
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,requiresMfa:false,phoneRequired:scenario!=='sms-verified',factors:{...member.factors,phoneEnabled:true,phoneVerified:verified}}});
    if(path==='/api/auth/factors')return route.fulfill({json:{passkeys:[],phoneEnabled:true,phoneVerified:verified,firebase:{apiKey:'synthetic',authDomain:'synthetic.firebaseapp.com',projectId:'synthetic',appId:'synthetic'}}});
    if(path==='/api/auth/phone/start'){
      starts++;expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');expect(route.request().postDataJSON().phone).toBe('+66812345678');
      return rateLimited?route.fulfill({status:429,headers:{'Retry-After':'600'},json:{error:'กรุณารอก่อนขอรหัสใหม่',code:'RATE_LIMITED'}}):route.fulfill({json:{challengeId:'synthetic-phone-challenge',retryAfter:60,expiresIn:180}});
    }
    if(path==='/api/auth/phone/verify'){
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      expect(route.request().postDataJSON().challengeId).toBe('synthetic-phone-challenge');
      expect(route.request().postDataJSON().idToken).toContain('.synthetic-signature');
      verified=true;return route.fulfill({json:{ok:true}});
    }
    return route.fulfill({json:{sessions:[]}});
  });
  await page.goto('/login');
  if(scenario==='sms-verified')await expect(page.getByRole('status').filter({hasText:'บัญชีนี้ยังไม่ได้ยืนยันเบอร์มือถือ'})).toBeVisible();
  await page.getByRole('textbox',{name:'เบอร์มือถือของคุณ'}).fill('081 234 5678');
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'ส่ง SMS ยืนยันเบอร์'}).click();
  if(smsSent){
    await expect(page.getByRole('status').filter({hasText:'ส่ง SMS แล้ว'})).toBeVisible();
    await expect(page.locator('.otp-digits input')).toHaveCount(6);
    await expect(page.getByRole('button',{name:'ยืนยันเบอร์มือถือ',exact:true})).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }else{
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await page.getByRole('alert').innerText(),JSON.stringify({params,unexpected})).toContain(rateLimited?'กรุณารอก่อนขอรหัสใหม่':smsRejected?'auth/operation-not-allowed':'auth/configuration-not-found');
  }
  const resend=page.getByRole('button',{name:/ส่งใหม่ได้ใน/});await expect(resend).toBeDisabled();
  const seconds=Number((await resend.innerText()).match(/\d+/)?.[0]);
  expect(seconds).toBeGreaterThan(rateLimited?570:30);expect(seconds).toBeLessThanOrEqual(rateLimited?600:60);
  await expect(page.locator('body')).not.toContainText('private-provider-detail-token');
  await expect(page.getByRole('status').filter({hasText:'ส่ง SMS แล้ว'})).toHaveCount(smsSent?1:0);
  if(scenario==='sms-verified'){
    const digits=page.locator('.otp-digits input');for(let i=0;i<6;i++)await digits.nth(i).fill('012345'[i]);
    await page.getByRole('button',{name:'ยืนยันเบอร์มือถือ',exact:true}).click();
    await expect(page.getByText('ยืนยันเบอร์แล้ว · ใช้สำหรับยืนยันเบอร์ครั้งแรก ไม่ใช้แทน MFA')).toBeVisible();
    await expect(page.getByRole('status').filter({hasText:'บัญชีนี้ยังไม่ได้ยืนยันเบอร์มือถือ'})).toHaveCount(0);
    expect(verified).toBe(true);
  }
  expect(starts).toBe(1);expect(params).toBe(rateLimited?0:1);expect(sms).toBe(smsRejected||smsSent?1:0);expect(unexpected).toEqual([]);
});
test('new factor enrollment remains disabled until Authenticator and recovery setup',async({page})=>{
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,requiresMfa:false,mfaMethod:'email',user:{...member.user,totpEnabled:false}}});
    if(path==='/api/auth/factors')return route.fulfill({json:{passkeyEnabled:true,lineEnabled:true,phoneEnabled:false,line:false,passkeys:[]}});
    return route.fulfill({json:{sessions:[]}});
  });
  await page.goto('/login');await expect(page.getByRole('button',{name:'เพิ่ม Passkey',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'ผูกบัญชี LINE'})).toBeDisabled();
  await expect(page.getByText('เปิด Authenticator และเก็บ Recovery codes ก่อนเพิ่ม Passkeys หรือ LINE')).toBeVisible();
});
test('Admin who uses LINE can explicitly step up with TOTP to regain admin access',async({page})=>{
  let fresh=false;
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,user:{...member.user,role:'admin'},requiresMfa:false,mfaMethod:fresh?'totp':'line',adminMfaRequired:!fresh}});
    if(path==='/api/auth/reauth'){expect(route.request().postDataJSON()).toEqual({code:'012345'});fresh=true;return route.fulfill({json:{ok:true}});}
    if(path==='/api/auth/factors')return route.fulfill({json:{passkeyEnabled:true,lineEnabled:true,line:true,passkeys:[]}});
    return route.fulfill({json:{stats:{users:0,allowedEmails:0,applications:0,activeApiKeys:0,mfaEnabled:0,activeSessions:0},users:[],emails:[],applications:[],apiKeys:[],events:[],sessions:[],meta:{total:0,totalPages:0,currentPage:1,limit:10}}});
  });
  await page.goto('/login');await page.getByRole('button',{name:'ยืนยันสิทธิ์ Admin'}).click();
  const dialog=page.getByRole('dialog'),digits=dialog.locator('.otp-digits input');for(let i=0;i<6;i++)await digits.nth(i).fill('012345'[i]);
  await dialog.getByRole('button',{name:'ยืนยันและดำเนินการต่อ'}).click();await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button',{name:/^ผู้ใช้งาน/})).toBeVisible();expect(fresh).toBe(true);
});

test('admin kill switch targets sessions while keeping the user in the directory',async({page})=>{
  let revoked=false;
  const target={id:'00000000-0000-4000-8000-000000000002',name:'Test target',email:'target@example.test',role:'user',totpEnabled:true};
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,user:{...member.user,role:'admin'},requiresMfa:false,mfaMethod:'totp',adminMfaRequired:false}});
    if(path===`/api/admin/users/${target.id}/sessions`){expect(route.request().method()).toBe('DELETE');expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');revoked=true;return route.fulfill({json:{ok:true,sessions:2}});}
    return route.fulfill({json:{stats:{users:1,allowedEmails:1,applications:0,activeApiKeys:0,mfaEnabled:1,activeSessions:revoked?0:2},users:[target],emails:[],applications:[],apiKeys:[],events:[],sessions:[],meta:{total:1,totalPages:1,currentPage:1,limit:10}}});
  });
  await page.goto('/login');await page.getByRole('navigation').getByRole('button',{name:/^ผู้ใช้งาน/}).click();
  await page.getByRole('button',{name:`ออกจากระบบทุกอุปกรณ์ ${target.email}`}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('คงบัญชี Role และ MFA เดิมไว้');
  await dialog.getByRole('button',{name:'ยืนยันยกเลิกสิทธิ์'}).click();await expect(dialog).toHaveCount(0);
  expect(revoked).toBe(true);await expect(page.getByText(target.email,{exact:true})).toBeVisible();
});
