import {expect,test} from '@playwright/test';
const app='11111111-1111-4111-8111-111111111111';
const returnTo=`/api/sso/authorize?${new URLSearchParams({client_id:app,redirect_uri:'https://service.example.test/callback',response_type:'code',state:'s'.repeat(43),code_challenge:'a'.repeat(42)+'A',code_challenge_method:'S256',scope:'identity:read email'})}`;
const user={id:'22222222-2222-4222-8222-222222222222',email:'customer@example.test',name:'Service Customer',role:'service',totpEnabled:false};
const identity={user,csrfToken:'csrf-test',requiresMfa:false,mfaMethod:'email',factors:{phoneVerified:true,phoneEnabled:false,passkey:false,line:false}};
const context={application:{id:app,name:'ระบบจองตั๋ว'},returnTo,missing:[],enrolled:true,blocked:false,ready:true,registration:'open',pendingDays:14,inactiveDays:null,noticeDays:30,totpEnabled:false};

test('required enrollment names the service, guides missing factors and never continues early',async({page})=>{
 await page.route('**/api/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/api/auth/me'?identity:{...context,ready:false,missing:['phone','line','strong_mfa']}}));
 await page.goto(`/service-enrollment?${new URLSearchParams({returnTo})}`);
 await expect(page.getByRole('heading',{name:'ระบบจองตั๋ว'})).toBeVisible();
 await expect(page.getByText('ยืนยันเบอร์มือถือ',{exact:true})).toBeVisible();
 await expect(page.getByText('ผูกบัญชี LINE',{exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'ตรวจสอบและอนุญาตข้อมูล'})).toHaveCount(0);
 const link=page.getByRole('link',{name:'ตั้งค่าการยืนยันตัวตน'});
 const url=new URL(await link.getAttribute('href')??'','http://127.0.0.1');
 expect(url.searchParams.get('manage')).toBe('security');expect(url.searchParams.get('returnTo')).toBe(returnTo);
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/service-enrollment-mobile.png',fullPage:true,animations:'disabled'});
});
test('service signup is explicit and CSRF bound, then still requires consent',async({page})=>{
 let enrolled=false;
 await page.route('**/api/**',r=>{
   if(new URL(r.request().url()).pathname==='/api/auth/me')return r.fulfill({json:identity});
   if(r.request().method()==='POST'){expect(r.request().headers()['x-csrf-token']).toBe('csrf-test');expect(r.request().postDataJSON()).toEqual({returnTo});enrolled=true;}
   return r.fulfill({json:{...context,enrolled,ready:enrolled}});
 });
 await page.goto(`/service-enrollment?${new URLSearchParams({returnTo})}`);
 await expect(page.getByRole('button',{name:'เริ่มสมัครสมาชิกระบบนี้'})).toBeVisible();expect(enrolled).toBe(false);
 await page.getByRole('button',{name:'เริ่มสมัครสมาชิกระบบนี้'}).click();
 await expect(page.getByRole('link',{name:'ตรวจสอบและอนุญาตข้อมูล'})).toHaveAttribute('href',returnTo);
});
test('revoked membership cannot offer a new signup path',async({page})=>{
 await page.route('**/api/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/api/auth/me'?identity:{...context,blocked:true,ready:false}}));
 await page.goto(`/service-enrollment?${new URLSearchParams({returnTo})}`);
 await expect(page.getByText(/สมาชิกถูกระงับหรือคำขอสมัครหมดอายุ/)).toBeVisible();
 await expect(page.getByRole('button',{name:'เริ่มสมัครสมาชิกระบบนี้'})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'ตรวจสอบและอนุญาตข้อมูล'})).toHaveCount(0);
});
test('external account only sees personal security and sessions, not central workspace navigation',async({page})=>{
 const adminCalls:string[]=[];
 await page.route('**/api/**',r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.startsWith('/api/admin')){adminCalls.push(path);return r.fulfill({status:403,json:{error:'forbidden'}});}
  if(path==='/api/auth/me')return r.fulfill({json:identity});
  if(path==='/api/auth/status')return r.fulfill({json:{configured:true}});
  if(path==='/api/auth/factors')return r.fulfill({json:{passkeyEnabled:false,lineEnabled:false,phoneEnabled:false,passkeys:[],line:false,phoneVerified:true}});
  return r.fulfill({json:{sessions:[],consents:[]}});
 });
 await page.goto('/login');
 await expect(page.getByText('บัญชีสำหรับ Service',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'ความปลอดภัย',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'ผู้ใช้งานภายใน',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'คู่มือเชื่อมต่อ API',exact:true})).toHaveCount(0);
 expect(adminCalls).toEqual([]);
});
test('mandatory disclosure scopes are visible, selected and cannot be unchecked',async({page})=>{
 await page.route('**/api/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/api/auth/me'?identity:{application:{name:'ระบบจองตั๋ว',origin:'https://service.example.test'},purpose:'รับสมาชิกและแจ้งข้อมูลการจอง',noticeVersion:'1.0',policyVersion:2,scopes:[
  {scope:'identity:read',title:'บัญชี',detail:'รหัสสมาชิก',required:true},
  {scope:'email',title:'อีเมล',detail:'อีเมลที่ Service จำเป็นต้องใช้',required:true},
  {scope:'phone',title:'เบอร์โทร',detail:'ข้อมูลเสริม',required:false},
 ]}}));
 await page.goto(`/consent?request=${'r'.repeat(43)}`);
 await expect(page.getByRole('checkbox',{name:/อีเมล/})).toBeChecked();
 await expect(page.getByRole('checkbox',{name:/อีเมล/})).toBeDisabled();
 await expect(page.getByRole('checkbox',{name:/เบอร์โทร/})).not.toBeChecked();
 await expect(page.getByRole('button',{name:'ไม่อนุญาต',exact:true})).toBeEnabled();
});

test('admin explicitly saves service policy; lifecycle preview never sends a mutation',async({page})=>{
 const role='33333333-3333-4333-8333-333333333333',writes:{path:string;body:any}[]=[];
 let policy={registration:'closed',defaultRoleId:null as string|null,requirePhone:false,requireLine:false,minimumMfa:'standard',requiredScopes:['identity:read'],registrationLimit:1000,pendingDays:14,inactiveDays:null as number|null,noticeDays:30,recoveryDays:30,version:1,lifecycleMode:'preview'};
 await page.route('**/api/**',r=>{
   const req=r.request(),path=new URL(req.url()).pathname;
   if(req.method()!=='GET'){expect(req.headers()['x-csrf-token']).toBe('csrf-test');writes.push({path,body:req.postDataJSON()});const {expectedVersion,...input}=req.postDataJSON();expect(expectedVersion).toBe(1);policy={...policy,...input,version:2};return r.fulfill({json:policy});}
   if(path==='/api/auth/me')return r.fulfill({json:{...identity,user:{...user,role:'admin',totpEnabled:true},mfaMethod:'totp'}});
   if(path.endsWith('/access-policy'))return r.fulfill({json:policy});
   if(path.endsWith('/roles'))return r.fulfill({json:{roles:[{id:role,code:'customer',name:'ลูกค้า'}]}});
   if(path.endsWith('/invitations'))return r.fulfill({json:{invitations:[],page:1,hasMore:false}});
   if(path.endsWith('/lifecycle-preview'))return r.fulfill({json:{data:[{userId:user.id,email:user.email,reason:'inactive_membership',lastReportedActivityAt:null}],meta:{hasMore:false,nextCursor:null},warning:'โหมดตรวจสอบ ไม่ลบข้อมูล'}});
   return r.fulfill({json:{configured:true,applications:[{id:app,name:'ระบบจองตั๋ว',description:'สมาชิก',redirectUri:'https://service.example.test/callback',createdAt:new Date().toISOString(),revokedAt:null}],users:[],emails:[],apiKeys:[],events:[],sessions:[],stats:{users:1,allowedEmails:1,applications:1,activeApiKeys:0,mfaEnabled:1,activeSessions:1},meta:{total:1,totalPages:1,currentPage:1,limit:10}}});
 });
 await page.goto('/login');await page.getByRole('button',{name:'แอปพลิเคชัน',exact:true}).click();
 await page.getByRole('button',{name:'นโยบายสมาชิกและการรับสมัคร'}).click();
 await page.getByLabel('รูปแบบรับสมาชิก').selectOption('open');
 await page.getByRole('combobox',{name:/^Role เริ่มต้น/}).selectOption(role);
 await page.getByLabel('ไม่ใช้งานกี่วันจึงเข้ารายงาน').fill('180');
 expect(writes).toEqual([]);
 await page.getByRole('button',{name:'บันทึกนโยบายสมาชิก'}).click();
 await expect(page.getByText(/บันทึกนโยบายแล้ว Token เดิม/)).toBeVisible();
 expect(writes[0].body.registration).toBe('open');expect(writes[0].body.inactiveDays).toBe(180);
 await page.getByRole('button',{name:'ตรวจสมาชิกที่ถึงเกณฑ์'}).click();
 await expect(page.getByText('โหมดตรวจสอบ ไม่ลบข้อมูล')).toBeVisible();
 expect(writes).toHaveLength(1);
});
