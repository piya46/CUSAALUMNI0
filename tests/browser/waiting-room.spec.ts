import { test,expect } from '@playwright/test';
const returnTo='/api/sso/authorize?client_id=22222222-2222-4222-8222-222222222222&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcallback&response_type=code&state='+'A'.repeat(43)+'&code_challenge_method=S256&code_challenge='+'A'.repeat(43);
const path='/waiting?'+new URLSearchParams({returnTo});
test('waiting room preserves reference on reload, polls without identity APIs and fits mobile',async({page})=>{
  const calls:string[]=[];
  await page.route('**/api/**',route=>{
    const p=new URL(route.request().url()).pathname;calls.push(p);
    if(p==='/api/queue/session')return route.fulfill({json:{ok:true}});
    expect(p).toBe('/api/queue/visit');expect(route.request().headers()['x-cusa-queue']).toBe('1');expect(route.request().postDataJSON()).toEqual({returnTo});
    return route.fulfill({json:{status:'waiting',reference:'TKT-123456ABCDEF',position:42,total:150,etaSeconds:21,pollAfter:10,application:{name:'Member Service',origin:'https://app.example.test'}}});
  });
  await page.setViewportSize({width:390,height:844});await page.goto(path);
  await expect(page.getByText('TKT-123456ABCDEF')).toBeVisible();await expect(page.getByRole('status')).toContainText('42');
  await page.reload();await expect(page.getByText('TKT-123456ABCDEF')).toBeVisible();
  expect(calls.every(p=>p.startsWith('/api/queue/'))).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/waiting-room-mobile.png',fullPage:true});
});
test('long queue wait keeps admission while asking for a fresh client OAuth flow; outages never navigate past the gate',async({page})=>{
  let unavailable=false;
  await page.route('**/api/queue/session',r=>r.fulfill({json:{ok:true}}));
  await page.route('**/api/queue/visit',r=>unavailable?r.fulfill({status:503,headers:{'Retry-After':'10'},json:{error:'ห้องรอคิวยังไม่พร้อม'}}):r.fulfill({json:{status:'admitted',restartFlow:true,next:returnTo,application:{name:'Member Service',origin:'https://app.example.test'}}}));
  await page.goto(path);await expect(page.getByRole('heading',{name:'ถึงคิวของคุณแล้ว'})).toBeVisible();
  await expect(page.getByRole('link',{name:'กลับไปยัง Member Service'})).toHaveAttribute('href','https://app.example.test');expect(new URL(page.url()).pathname).toBe('/waiting');
  unavailable=true;await page.reload();await expect(page.getByRole('alert')).toContainText('ห้องรอคิวยังไม่พร้อม');expect(new URL(page.url()).pathname).toBe('/waiting');
});
test('owner logout-all requires confirmation and uses only the CSRF-protected own-session endpoint',async({page})=>{
  let loggedOut=false;
  const identity={user:{id:'11111111-1111-4111-8111-111111111111',name:'Synthetic member',email:'member@example.test',role:'user',totpEnabled:true},csrfToken:'test-csrf',requiresMfa:false,mfaMethod:'totp'};
  await page.route('**/api/**',r=>{
    const p=new URL(r.request().url()).pathname;
    if(p==='/api/auth/status')return r.fulfill({json:{configured:true}});
    if(p==='/api/auth/me')return loggedOut?r.fulfill({status:401,json:{error:'Signed out'}}):r.fulfill({json:identity});
    if(p==='/api/auth/sessions'&&r.request().method()==='DELETE'){expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');loggedOut=true;return r.fulfill({json:{ok:true}});}
    if(p==='/api/auth/factors')return r.fulfill({json:{passkeys:[],passkeyEnabled:false,lineEnabled:false,phoneEnabled:false}});
    return r.fulfill({json:{sessions:[{id:'22222222-2222-4222-8222-222222222222',current:true,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),mfaMethod:'totp'}]}});
  });
  await page.goto('/login');await page.getByRole('navigation').getByRole('button',{name:'เซสชัน',exact:true}).click();
  await page.getByRole('button',{name:'ออกจากระบบทุกอุปกรณ์',exact:true}).click();expect(loggedOut).toBe(false);
  const dialog=page.getByRole('dialog');await expect(dialog).toContainText('รวมทั้งหน้านี้');await dialog.getByRole('button',{name:'ยืนยันยกเลิกสิทธิ์'}).click();
  await expect(page.getByRole('heading',{name:'เข้าสู่ระบบ',exact:true})).toBeVisible();expect(loggedOut).toBe(true);
});
test('admin changes queue policy through CSRF and fresh MFA without enabling revoke scope by default',async({page})=>{
  let fresh=false,saved=false;
  const app={id:'22222222-2222-4222-8222-222222222222',name:'Member Service',description:'Synthetic',redirectUri:'https://app.example.test/callback',createdAt:new Date().toISOString(),revokedAt:null};
  await page.route('**/api/**',r=>{
    const p=new URL(r.request().url()).pathname;
    if(p==='/api/auth/status')return r.fulfill({json:{configured:true}});
    if(p==='/api/auth/me')return r.fulfill({json:{user:{id:'11111111-1111-4111-8111-111111111111',name:'Admin',email:'admin@example.test',role:'admin',totpEnabled:true},csrfToken:'test-csrf',requiresMfa:false,mfaMethod:'totp',adminMfaRequired:false}});
    if(p.endsWith('/queue')){
      if(r.request().method()==='GET')return r.fulfill({json:{enabled:false,rate:2,capacity:2000,ipLimit:10}});
      expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');
      if(!fresh)return r.fulfill({status:403,json:{code:'MFA_REAUTH_REQUIRED',error:'Reauthenticate'}});
      expect(r.request().postDataJSON()).toEqual({enabled:true,rate:3,capacity:2000,ipLimit:10});saved=true;return r.fulfill({json:{ok:true}});
    }
    if(p==='/api/auth/reauth'){fresh=true;return r.fulfill({json:{ok:true}});}
    return r.fulfill({json:{stats:{users:1,allowedEmails:1,applications:1,activeApiKeys:0,mfaEnabled:1,activeSessions:1},users:[],emails:[],applications:[app],apiKeys:[],events:[],sessions:[],meta:{total:1,totalPages:1,currentPage:1,limit:10}}});
  });
  await page.goto('/login');await page.getByRole('navigation').getByRole('button',{name:'แอปพลิเคชัน',exact:true}).click();
  await page.getByRole('button',{name:'ตั้งค่าห้องรอคิว'}).click();await page.getByRole('checkbox',{name:'เปิดห้องรอคิวสำหรับ Service นี้'}).check();
  await page.getByRole('spinbutton',{name:'ปล่อยเข้าล็อกอินสูงสุดต่อวินาที'}).fill('3');await page.getByRole('button',{name:'บันทึกการตั้งค่าคิว'}).click();
  const dialog=page.getByRole('dialog'),digits=dialog.locator('.otp-digits input');for(let i=0;i<6;i++)await digits.nth(i).fill('012345'[i]);
  await dialog.getByRole('button',{name:'ยืนยันและดำเนินการต่อ'}).click();await expect(page.getByText('บันทึกการตั้งค่าคิวแล้ว')).toBeVisible();expect(saved).toBe(true);
  await page.getByRole('navigation').getByRole('button',{name:'API keys',exact:true}).click();await page.getByRole('button',{name:'สร้าง API key',exact:true}).first().click();
  await expect(page.getByRole('checkbox',{name:/token:revoke/})).not.toBeChecked();
});
