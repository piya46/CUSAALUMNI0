import { test,expect } from '@playwright/test';

test('login, demo navigation, allowlist mutation and reload isolation',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'เข้าสู่ระบบ'})).toBeVisible();
  await page.screenshot({path:'test-results/login-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'เปิดโหมดตัวอย่าง'}).click();
  await expect(page.locator('.demo-banner')).toBeVisible();
  await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true});
  const nav=page.getByRole('navigation',{name:'เมนูหลัก'});
  const navButtons=nav.getByRole('button');
  const count=await navButtons.count();
  for(let i=0;i<count;i++){await navButtons.nth(i).click();await expect(page.locator('main h1')).toBeVisible();}
  await nav.getByRole('button',{name:'อีเมลที่อนุญาต',exact:true}).click();
  await page.getByRole('button',{name:'เพิ่มอีเมล',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.locator('input[name="email"]').fill('browser-test@example.com');
  await dialog.getByRole('button',{name:'เพิ่มอีเมล',exact:true}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('browser-test@example.com',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'เปิดโหมดตัวอย่าง'})).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile layout, navigation drawer and security page',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.getByRole('button',{name:'เปิดโหมดตัวอย่าง'}).click();
  await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'เปิดเมนู',exact:true}).click();
  await expect(page.locator('.sidebar')).toHaveClass(/open/);
  await page.getByRole('navigation',{name:'เมนูหลัก'}).getByRole('button',{name:'ความปลอดภัย',exact:true}).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});

test('demo application, one-time API key, revocation and MFA recovery setup',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByRole('button',{name:'เปิดโหมดตัวอย่าง'}).click();
  const nav=page.getByRole('navigation',{name:'เมนูหลัก'});
  await nav.getByRole('button',{name:'แอปพลิเคชัน',exact:true}).click();
  await page.getByRole('button',{name:'เพิ่มแอปพลิเคชัน',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.locator('input[name="name"]').fill('Browser test app');
  await dialog.locator('input[name="redirectUri"]').fill('https://browser-test.example.com/callback');
  await dialog.getByRole('button',{name:'เพิ่มแอปพลิเคชัน',exact:true}).click();
  await nav.getByRole('button',{name:'API keys',exact:true}).click();
  await page.getByRole('button',{name:'สร้าง API key',exact:true}).click();
  dialog=page.getByRole('dialog');await dialog.locator('input[name="name"]').fill('Browser test key');
  await dialog.locator('select[name="applicationId"]').selectOption({label:'Browser test app'});
  await dialog.getByRole('button',{name:'สร้าง API key',exact:true}).click();
  await expect(dialog.locator('.secret-key')).toContainText('DEMO_UI_ONLY_');
  await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'บันทึกแล้ว เสร็จสิ้น'}).click();
  const row=page.getByRole('row').filter({hasText:'Browser test key'});
  await row.getByRole('button').last().click();
  await page.getByRole('dialog').getByRole('button',{name:'ยืนยันยกเลิกสิทธิ์'}).click();
  await expect(row).toContainText('เพิกถอน');
  await nav.getByRole('button',{name:'ความปลอดภัย',exact:true}).click();
  await page.getByRole('button',{name:'ปิดใช้งาน',exact:true}).click();
  dialog=page.getByRole('dialog');await dialog.locator('input[name="code"]').fill('123456');
  await dialog.getByRole('button',{name:'ยืนยันปิดใช้งาน'}).click();
  await page.getByRole('button',{name:'เปิดใช้งาน',exact:true}).click();
  dialog=page.getByRole('dialog');await expect(dialog.getByRole('img',{name:'QR code สำหรับตั้งค่า Authenticator'})).toBeVisible();
  await expect(dialog.locator('.recovery-codes code')).toHaveCount(8);
  await dialog.getByRole('checkbox').check();await dialog.locator('input[name="code"]').fill('123456');
  await dialog.getByRole('button',{name:'ยืนยันและเปิดใช้งาน'}).click();
  await expect(page.getByRole('button',{name:'ปิดใช้งาน',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
