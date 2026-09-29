import { test,expect } from '@playwright/test';
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
