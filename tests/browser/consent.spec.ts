import { expect, test } from '@playwright/test';

const request='r'.repeat(43);
const scopeItems=[
  {scope:'identity:read',title:'บัญชีและสิทธิ์ใน Service นี้',detail:'รหัสบัญชีและ Role',required:true},
  {scope:'profile',title:'โปรไฟล์พื้นฐาน',detail:'ชื่อ นามสกุล รูปภาพ',required:false},
  {scope:'phone',title:'เบอร์โทรศัพท์',detail:'ส่งเบอร์ที่ยืนยันแล้ว',required:false},
  {scope:'phone:match',title:'ตรวจว่าเบอร์ตรงกัน',detail:'คืนผลตรวจ ไม่ส่งเบอร์จริง',required:false},
  {scope:'line',title:'บัญชี LINE ที่ผูกไว้',detail:'LINE UID ไม่ใช่ LINE access token',required:false},
  {scope:'assurance',title:'วิธีและเวลายืนยันตัวตน',detail:'วิธีที่ใช้ในการเข้าสู่ระบบ',required:false},
];
for(const choice of ['approve','deny','expired'] as const){
  test(`consent ${choice}: explicit field choices, safe recipient and no silent grant`,async({page})=>{
    const decisions:unknown[]=[];
    await page.route('**/api/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/auth/me')return route.fulfill({json:{user:{email:'user@example.test'},csrfToken:'test-csrf',requiresMfa:false}});
      if(url.pathname==='/api/sso/consent'&&route.request().method()==='GET')return route.fulfill({json:{
        application:{name:'ระบบศิษย์เก่า',origin:'https://client.example.test'},purpose:'ใช้ข้อมูลเพื่อแสดงบัญชีสมาชิกและตรวจเบอร์ที่สมัครไว้',noticeVersion:'1.0',policyVersion:1,scopes:scopeItems,
      }});
      if(url.pathname==='/api/sso/consent'&&route.request().method()==='POST'){
        expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
        decisions.push(route.request().postDataJSON());
        return choice==='expired'?route.fulfill({status:403,json:{error:'คำขอหมดอายุ กรุณาเริ่มใหม่จาก Service'}}):route.fulfill({json:{redirectTo:`https://client.example.test/callback?state=test&${choice==='deny'?'error=access_denied':'code=test-code'}`}});
      }
      return route.fulfill({status:404,json:{}});
    });
    await page.route('https://client.example.test/**',route=>route.fulfill({body:'Callback received'}));
    await page.goto(`/consent?request=${request}`);
    await expect(page.getByRole('heading',{name:'อนุญาตให้เชื่อมต่อบัญชี'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'ระบบศิษย์เก่า'})).toBeVisible();
    await expect(page.getByRole('checkbox',{name:/บัญชีและสิทธิ์ใน Service นี้/})).toBeChecked();
    for(const item of scopeItems.slice(1))await expect(page.getByRole('checkbox',{name:new RegExp(item.title)})).not.toBeChecked();
    expect(decisions).toEqual([]);
    await page.getByRole('checkbox',{name:/โปรไฟล์พื้นฐาน/}).check();
    await page.getByRole('checkbox',{name:/ตรวจว่าเบอร์ตรงกัน/}).check();
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(choice==='approve'){
      await page.screenshot({path:'test-results/consent-mobile.png',fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:1440,height:1100});
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:'test-results/consent-desktop.png',fullPage:true,animations:'disabled'});
    }
    await page.getByRole('button',{name:choice==='deny'?'ไม่อนุญาต':'อนุญาตและเข้าสู่ระบบ',exact:true}).click();
    if(choice==='expired'){
      await expect(page.getByRole('alert')).toHaveText('คำขอหมดอายุ กรุณาเริ่มใหม่จาก Service');
      await expect(page).toHaveURL(new RegExp('/consent'));
    }else await expect(page).toHaveURL(/client\.example\.test\/callback/);
    expect(decisions).toEqual([{request,approved:choice!=='deny',scopes:choice==='deny'?[]:['identity:read','profile','phone:match']}]);
  });
}
test('consent never loads personal sharing context while MFA or phone gate is pending',async({page})=>{
  let read=false;
  await page.route('**/api/**',route=>{
    if(route.request().url().includes('/auth/me'))return route.fulfill({json:{user:{email:'user@example.test'},requiresMfa:true}});
    read=true;return route.fulfill({json:{}});
  });
  await page.goto(`/consent?request=${request}`);
  await expect(page.getByRole('alert')).toContainText('ยืนยันตัวตนให้ครบ');
  expect(read).toBe(false);await expect(page.getByRole('button',{name:'อนุญาตและเข้าสู่ระบบ'})).toHaveCount(0);
});

for(const mode of ['admin','user'] as const){
  test(`${mode} manages only its sharing policy or own consent; changes require an explicit action`,async({page})=>{
    const writes:{path:string;body:unknown}[]=[];
    const app={id:'app-test',name:'Member Portal',description:'Members',redirectUri:'https://portal.example.test/callback',createdAt:new Date().toISOString(),revokedAt:null};
    await page.route('**/api/**',route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(req.method()!=='GET'){writes.push({path,body:req.postData()?req.postDataJSON():null});return route.fulfill({json:{ok:true}});}
      if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
      if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'user',email:'user@example.test',name:'Test User',role:mode,totpEnabled:true},csrfToken:'test-csrf',requiresMfa:false,adminMfaRequired:false,mfaMethod:'totp',factors:{passkey:false,line:false,phoneVerified:true}}});
      if(path==='/api/auth/factors')return route.fulfill({json:{passkeys:[],passkeyEnabled:false,lineEnabled:false,phoneEnabled:false,lineLinked:false,phoneVerified:true}});
      if(path==='/api/sso/consents')return route.fulfill({json:{consents:[{id:'consent-test',name:'Member Portal',scope:'identity:read profile',approvedAt:new Date().toISOString()}]}});
      if(path.endsWith('/sharing'))return route.fulfill({json:{scopes:['identity:read','profile','email'],purpose:'Use profile to display the membership account',version:1}});
      return route.fulfill({json:{applications:[app],users:[],emails:[],apiKeys:[],events:[],sessions:[],stats:{users:1,allowedEmails:1,applications:1,activeApiKeys:0,mfaEnabled:1,activeSessions:1},meta:{total:1,totalPages:1,currentPage:1,limit:10}}});
    });
    await page.goto('/login');
    if(mode==='admin'){
      await page.getByRole('button',{name:'แอปพลิเคชัน',exact:true}).click();
      await page.getByRole('button',{name:'ตั้งค่าข้อมูลและ Consent'}).click();
      await expect(page.getByRole('checkbox',{name:'LINE UID ที่ผูกไว้'})).not.toBeChecked();
      await page.getByRole('checkbox',{name:'LINE UID ที่ผูกไว้'}).check();
      expect(writes).toEqual([]);
      await page.getByRole('button',{name:'บันทึกนโยบายข้อมูล'}).click();
      await expect(page.getByText('บันทึกแล้ว สิทธิ์เดิมถูกยกเลิก ผู้ใช้ต้องอนุญาตใหม่เมื่อเข้า Service อีกครั้ง')).toBeVisible();
      expect(writes).toEqual([{path:'/api/admin/applications/app-test/sharing',body:{scopes:['identity:read','profile','email','line'],purpose:'Use profile to display the membership account'}}]);
      await page.getByRole('button',{name:'คู่มือเชื่อมต่อ API',exact:true}).click();
      await expect(page.getByRole('heading',{name:'ขอข้อมูลเฉพาะที่จำเป็น พร้อม Consent'})).toBeVisible();
    }else{
      await expect(page.getByRole('heading',{name:'ข้อมูลที่อนุญาตให้ Service ใช้'})).toBeVisible();
      await page.getByRole('button',{name:'ถอนการอนุญาต',exact:true}).click();expect(writes).toEqual([]);
      await page.getByRole('button',{name:'ยืนยันถอนการอนุญาต'}).click();
      await expect(page.getByText('ยังไม่มีการอนุญาตที่ใช้งานอยู่')).toBeVisible();
      expect(writes).toEqual([{path:'/api/sso/consents/consent-test',body:null}]);
    }
  });
}
