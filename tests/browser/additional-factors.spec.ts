import { test,expect } from '@playwright/test';
const member={user:{id:'00000000-0000-4000-8000-000000000001',email:'member@example.test',name:'Test member',role:'user',totpEnabled:true},csrfToken:'test-csrf',requiresMfa:true,mfaMethod:'totp',factors:{passkey:true,line:true,phoneVerified:false}};
test('LINE MFA shows only the issued number, blocks resend and consumes approval through CSRF-protected browser',{timeout:30000},async({page})=>{
  let complete=false,checks=0,sends=0;
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,requiresMfa:!complete,mfaMethod:complete?'line':'totp'}});
    if(path==='/api/auth/line/send'){sends++;return route.fulfill({json:{challengeId:'challenge-test',number:'42',retryAfter:60,expiresIn:180}});}
    if(path==='/api/auth/line/challenges/challenge-test'){checks++;return route.fulfill({json:{status:checks===1?'pending':'approved'}});}
    if(path==='/api/auth/line/verify'){expect(route.request().postDataJSON()).toEqual({challengeId:'challenge-test'});expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');complete=true;return route.fulfill({json:{ok:true}});}
    if(path==='/api/auth/factors')return route.fulfill({json:{passkeyEnabled:true,lineEnabled:true,line:true,phoneEnabled:false,passkeys:[]}});
    return route.fulfill({json:{sessions:[]}});
  });
  await page.setViewportSize({width:390,height:844});await page.goto('/login');
  await expect(page.getByRole('button',{name:'ยืนยันด้วย Passkey'})).toBeVisible();
  await page.getByRole('button',{name:'ยืนยันผ่าน LINE',exact:true}).click();await expect(page.locator('.number-matching strong')).toHaveText('42');
  await expect(page.getByRole('button',{name:/ขอ LINE ใหม่ได้ใน/})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/line-matching-mobile.png',fullPage:true});
  await expect(page.getByRole('heading',{name:'ความปลอดภัย',exact:true})).toBeVisible({timeout:12000});expect(complete).toBe(true);expect(sends).toBe(1);
});
test('required phone gate blocks application continuation and lists the separate Firebase consent before sending',async({page})=>{
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return route.fulfill({json:{...member,requiresMfa:false,phoneRequired:true}});
    if(path==='/api/auth/factors')return route.fulfill({json:{phoneEnabled:true,phoneVerified:false,firebase:{apiKey:'synthetic',authDomain:'synthetic.firebaseapp.com',projectId:'synthetic',appId:'synthetic'}}});
    return route.fulfill({json:{}});
  });
  await page.goto('/login');await expect(page.getByRole('heading',{name:'ยืนยันเบอร์มือถือครั้งแรก'})).toBeVisible();
  const send=page.getByRole('button',{name:'ส่ง SMS ยืนยันเบอร์'});await expect(send).toBeDisabled();
  await page.getByRole('textbox',{name:'เบอร์มือถือพร้อมรหัสประเทศ'}).fill('+66812345678');await expect(send).toBeDisabled();
  await page.getByRole('checkbox').check();await expect(send).toBeEnabled();
  await expect(page.getByRole('navigation',{name:'เมนูหลัก'})).toHaveCount(0);
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
