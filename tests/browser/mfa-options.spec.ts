import { test, expect } from '@playwright/test';

for(const scenario of ['all','totp-only','email'] as const){
  test(`MFA categories show only eligible methods (${scenario}), preserve Google-first flow and do not send on selection`,async({page})=>{
    const actions:string[]=[];
    await page.route('**/api/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(route.request().method()!=='GET')actions.push(path);
      if(path==='/api/auth/status')return route.fulfill({json:{configured:true}});
      if(path==='/api/auth/me')return route.fulfill({json:{
        user:{id:'admin-test',email:'admin@example.test',name:'Admin',role:'admin',totpEnabled:scenario!=='email'},
        csrfToken:'test-csrf',requiresMfa:true,mfaMethod:scenario==='email'?'email':'totp',adminMfaRequired:true,
        factors:{passkey:scenario==='all',line:scenario==='all',phoneVerified:false,phoneEnabled:true},
      }});
      return route.fulfill({json:{}});
    });
    await page.goto('/login');
    if(scenario==='email'){
      await expect(page.getByRole('heading',{name:'วิธียืนยันของคุณ'})).toBeVisible();
      await expect(page.getByRole('button',{name:'เลือก Email OTP',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(page.getByRole('button',{name:'ส่งรหัสไปยังอีเมล'})).toBeVisible();
      await expect(page.getByRole('heading',{name:'วิธีแนะนำ'})).toHaveCount(0);
      await expect(page.getByRole('button',{name:'เลือก Authenticator',exact:true})).toHaveCount(0);
      await expect(page.getByRole('button',{name:'ขอรีเซ็ต MFA'})).toHaveCount(0);
    }else{
      await expect(page.getByRole('region',{name:'วิธีแนะนำ'})).toBeVisible();
      await expect(page.getByRole('button',{name:'เลือก Authenticator',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(page.getByRole('button',{name:'เลือก Email OTP',exact:true})).toHaveCount(0);
      await expect(page.getByRole('region',{name:'กู้คืนบัญชี'})).toBeVisible();
      if(scenario==='all'){
        await expect(page.getByRole('region',{name:'วิธีแนะนำ'}).getByRole('button')).toHaveCount(2);
        await expect(page.getByRole('region',{name:'วิธีอื่นที่ใช้ได้'}).getByRole('button',{name:'เลือก LINE'})).toBeVisible();
        await page.screenshot({path:'test-results/mfa-options-desktop.png',fullPage:true,animations:'disabled'});
        await page.getByRole('button',{name:'เลือก Passkey',exact:true}).click();
        await expect(page.locator('#mfa-challenge-title')).toBeFocused();
        await expect(page.getByRole('button',{name:'ยืนยันด้วย Passkey'})).toBeVisible();
        await expect(page.locator('.otp-digits input')).toHaveCount(0);
        await page.getByRole('button',{name:'เลือก LINE',exact:true}).click();
        await expect(page.getByRole('button',{name:'ยืนยันผ่าน LINE',exact:true})).toBeVisible();
        await expect(page.getByText(/เข้าใช้บัญชีด้วย LINE ได้/)).toBeVisible();
      }else{
        await expect(page.getByRole('button',{name:'เลือก Passkey'})).toHaveCount(0);
        await expect(page.getByRole('button',{name:'เลือก LINE'})).toHaveCount(0);
      }
      await page.getByRole('button',{name:'เลือก Recovery code',exact:true}).click();
      await expect(page.getByRole('textbox',{name:'Recovery code',exact:true})).toBeVisible();
      await expect(page.getByText('ใช้รหัสกู้คืนเพื่อกลับไปตั้งค่า Authenticator ใหม่ก่อนเปิดสิทธิ์ผู้ดูแล')).toBeVisible();
      await page.getByRole('button',{name:'เลือก Authenticator',exact:true}).click();
      await expect(page.locator('.otp-digits input')).toHaveCount(6);
    }
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(scenario==='all')await page.screenshot({path:'test-results/mfa-options-mobile.png',fullPage:true,animations:'disabled'});
    expect(actions).toEqual([]);
  });
}
