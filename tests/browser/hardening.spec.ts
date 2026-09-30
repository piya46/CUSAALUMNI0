import { test,expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const pending={user:{id:'user-test',email:'member@example.test',name:'Member',role:'user',totpEnabled:false},csrfToken:'test-csrf',requiresMfa:true,mfaMethod:'email',otp:{reference:null,expiresAt:null,retryAfter:0}};

test('public homepage explains CUSA SSO and Google data without an authenticated API',async({page})=>{
  const calls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/'))calls.push(r.url());});
  await page.goto('/');await expect(page.getByRole('heading',{name:'CUSA SSO',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'ข้อมูล Google ที่เราใช้'})).toBeVisible();
  await expect(page.getByRole('link',{name:'เข้าสู่ระบบด้วยบัญชี Google'})).toHaveAttribute('href','/login');
  expect(calls).toEqual([]);await page.screenshot({path:'test-results/homepage.png',fullPage:true});
});

test('six OTP fields accept paste, backspace and leading zero, show Ref and survive cooldown reload',async({page})=>{
  let sent=false,requests=0;
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/auth/status',r=>r.fulfill({json:{configured:true}}));
  await page.route('**/api/auth/me',r=>r.fulfill({json:{...pending,otp:sent?{reference:'ABC12345',expiresAt:new Date(Date.now()+300000).toISOString(),retryAfter:60}:pending.otp}}));
  await page.route('**/api/auth/otp/send',r=>{requests++;sent=true;return r.fulfill({json:{reference:'ABC12345',expiresAt:new Date(Date.now()+300000).toISOString(),retryAfter:60}});});
  await page.route('**/api/auth/otp/verify',r=>{expect(r.request().postDataJSON()).toEqual({code:'012346',reference:'ABC12345'});return r.fulfill({status:401,json:{error:'รหัสทดสอบไม่ถูกต้อง',code:'INVALID_CODE'}});});
  await page.goto('/login');await page.getByRole('button',{name:'ส่งรหัสไปยังอีเมล'}).click();
  await expect(page.getByText('ABC12345')).toBeVisible();await expect(page.getByRole('button',{name:/ส่งใหม่ได้ใน/})).toBeDisabled();
  const digits=page.locator('.otp-digits input');await expect(digits).toHaveCount(6);
  await digits.first().evaluate(el=>{const data=new DataTransfer();data.setData('text','012345');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await expect(digits.first()).toHaveValue('0');await expect(digits.nth(5)).toHaveValue('5');
  await digits.nth(5).press('Backspace');await digits.nth(5).fill('6');
  await page.getByRole('button',{name:'ยืนยันและเข้าสู่ระบบ'}).click();await expect(page.getByRole('alert')).toContainText('รหัสทดสอบ');
  await page.reload();await expect(page.getByText('ABC12345')).toBeVisible();await expect(page.getByRole('button',{name:/ส่งใหม่ได้ใน/})).toBeDisabled();
  expect(requests).toBe(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/otp-mobile.png',fullPage:true});
});

test('admin without TOTP stays on security enrollment without fetching admin data',async({page})=>{
  const calls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/admin/'))calls.push(r.url());});
  await page.route('**/api/auth/status',r=>r.fulfill({json:{configured:true}}));
  await page.route('**/api/auth/me',r=>r.fulfill({json:{...pending,requiresMfa:false,adminMfaRequired:true,user:{...pending.user,role:'admin'}}}));
  await page.route('**/api/auth/sessions',r=>r.fulfill({json:{sessions:[]}}));
  await page.goto('/login');await expect(page.getByText('บัญชีผู้ดูแลต้องเปิด Authenticator ก่อนจัดการผู้ใช้และสิทธิ์')).toBeVisible();
  await expect(page.getByRole('button',{name:'ผู้ใช้งาน',exact:true})).toHaveCount(0);expect(calls).toEqual([]);
});

test('API documentation has searchable endpoints, valid downloadable references and fits a mobile screen',async({page})=>{
  await page.goto('/login');await page.getByRole('button',{name:'เปิดโหมดตัวอย่าง'}).click();
  await page.getByRole('button',{name:'คู่มือเชื่อมต่อ',exact:true}).click();
  await expect(page.getByRole('heading',{name:'CUSA SSO API',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'OpenAPI 3.1'})).toHaveAttribute('href','/openapi.json');
  const spec=await (await page.request.get('/openapi.json')).json();expect(spec.openapi).toBe('3.1.0');
  function check(value:unknown){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(key==='$ref'){let target:any=spec;for(const part of String(child).slice(2).split('/'))target=target?.[part];expect(target).toBeTruthy();}else check(child);}}
  check(spec);
  await page.getByRole('textbox',{name:'ค้นหา Endpoint'}).fill('introspect');await expect(page.locator('.api-endpoint')).toHaveCount(1);
  await page.locator('.api-endpoint').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/api-docs-desktop.png'});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('owner submits an MFA reset from the pending TOTP screen with a privacy notice and receives status',async({page})=>{
  let submitted=false;
  await page.route('**/api/auth/status',r=>r.fulfill({json:{configured:true}}));
  await page.route('**/api/auth/me',r=>r.fulfill({json:{...pending,mfaMethod:'totp',user:{...pending.user,totpEnabled:true}}}));
  await page.route('**/api/auth/mfa-reset',r=>{
    if(r.request().method()==='POST'){
      expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');
      expect(r.request().postData()).toContain('2026-09-30');submitted=true;return r.fulfill({status:201,json:{id:'request-test',status:'pending'}});
    }
    return r.fulfill({json:{enabled:true,request:submitted?{id:'request-test',status:'pending',createdAt:new Date().toISOString(),deleteAfter:new Date(Date.now()+86400000).toISOString()}:null}});
  });
  await page.goto('/login');await page.getByRole('button',{name:'ไม่มีเครื่องเดิมและ Recovery code'}).click();
  await expect(page.getByRole('heading',{name:'ขอเปลี่ยน Authenticator'})).toBeVisible();
  await expect(page.getByText(/ปิดเลขบัตร/)).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('synthetic test only')});
  await page.getByRole('checkbox').check();
  await page.screenshot({path:'test-results/mfa-reset-owner.png',fullPage:true});
  await page.getByRole('button',{name:'ส่งคำขอให้ผู้ดูแลพิจารณา'}).click();
  await expect(page.getByRole('status')).toContainText('รอพิจารณา');await expect(page.locator('input[type=file]')).toHaveCount(0);expect(submitted).toBe(true);
});

test('admin must reauthenticate to view evidence and explicitly verify before approving',async({page})=>{
  let fresh=false,approved=false,views=0;
  const item={id:'00000000-0000-4000-8000-000000000002',userId:'member-test',email:'member@example.test',name:'Synthetic member',userRole:'user',status:'pending',reason:'lost',createdAt:new Date().toISOString(),deleteAfter:new Date(Date.now()+86400000).toISOString(),purgedAt:null};
  await page.route('**/api/**',r=>{
    const path=new URL(r.request().url()).pathname;
    if(path==='/api/auth/status')return r.fulfill({json:{configured:true}});
    if(path==='/api/auth/me')return r.fulfill({json:{...pending,requiresMfa:false,mfaMethod:'totp',user:{...pending.user,role:'admin',totpEnabled:true}}});
    if(path==='/api/auth/reauth'){expect(r.request().postDataJSON()).toEqual({code:'012345'});fresh=true;return r.fulfill({json:{ok:true}});}
    if(path.endsWith('/evidence')){views++;return fresh?r.fulfill({contentType:'image/png',body:readFileSync('tests/fixtures/mfa-synthetic.png')}):r.fulfill({status:403,json:{code:'MFA_REAUTH_REQUIRED',error:'ยืนยันใหม่'}});}
    if(path.endsWith('/decision')){expect(fresh).toBe(true);expect(r.request().postDataJSON()).toEqual({decision:'approve',verified:true,reason:'identity_verified'});approved=true;return r.fulfill({json:{status:'approved'}});}
    if(path==='/api/admin/mfa-resets')return r.fulfill({json:{requests:approved?[]:[item],meta:{hasMore:false,nextCursor:null}}});
    return r.fulfill({json:{stats:{users:0,allowedEmails:0,applications:0,activeApiKeys:0,mfaEnabled:0,activeSessions:0},users:[],emails:[],applications:[],apiKeys:[],events:[],sessions:[],meta:{total:0,totalPages:0,currentPage:1,limit:10}}});
  });
  await page.goto('/login');await page.getByRole('navigation',{name:'เมนูหลัก'}).getByRole('button',{name:'คำขอเปลี่ยน MFA'}).click();
  await page.getByRole('button',{name:'เปิดตรวจหลักฐาน'}).click();const reauth=page.getByRole('dialog');
  await expect(reauth.getByText('ยืนยันก่อนเปลี่ยนแปลงสิทธิ์')).toBeVisible();
  const digits=reauth.locator('.otp-digits input');for(let i=0;i<6;i++)await digits.nth(i).fill('012345'[i]);
  await reauth.getByRole('button',{name:'ยืนยันและดำเนินการต่อ'}).click();
  const review=page.getByRole('dialog');await expect(review.getByText('ตรวจคำขอเปลี่ยน MFA')).toBeVisible();
  await expect(review.getByRole('button',{name:'อนุมัติและยกเลิก MFA เดิม'})).toBeDisabled();
  await review.getByRole('checkbox').check();await page.screenshot({path:'test-results/mfa-reset-admin.png'});
  await review.getByRole('button',{name:'อนุมัติและยกเลิก MFA เดิม'}).click();await expect(review).toBeHidden();expect(approved).toBe(true);expect(views).toBe(2);
});

test('OTP email preview shows purpose and matching Ref on mobile without overflow',async({page})=>{
  const {readFile}=await import('node:fs/promises');
  await page.setViewportSize({width:390,height:844});
  await page.setContent(await readFile('docs/previews/otp-email.html','utf8'));
  await expect(page.getByRole('heading',{name:'รหัสยืนยันของคุณ'})).toBeVisible();
  await expect(page.getByText('012345',{exact:true})).toBeVisible();await expect(page.getByText('ABC12345',{exact:true})).toBeVisible();
  await expect(page.getByText(/ยืนยันการเข้าสู่ระบบ CUSA SSO เพื่อเข้าใช้งาน/)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/otp-email-mobile.png',fullPage:true});
});
