import { test, expect, type Page } from '@playwright/test';

const token = 'b'.repeat(43);
const details = { database: 'cusa_install_test', host: 'localhost', adminEmail: 'admin@example.test', databaseVersion: '10.11.18-MariaDB' };
async function installDocument(page: Page) {
  // Production server deliberately returns 404 while INSTALL_ENABLED=false.
  // Only the document is substituted for component tests; no real installation is performed.
  await page.route('**/install', async route => {
    const index = await page.request.get('/');
    await route.fulfill({ status: 200, contentType: 'text/html', body: await index.text() });
  });
}

test('installer checks settings, requires confirmation and clears token after success', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installDocument(page);
  const requests: string[] = [];
  await page.route('**/api/install/*', async route => {
    const request = route.request(); requests.push(request.url());
    expect(request.method()).toBe('POST');
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    expect(request.url()).not.toContain(token);
    const run = request.url().endsWith('/run');
    expect(request.postDataJSON()).toEqual(run ? { confirm: true } : {});
    await route.fulfill({ status: run ? 201 : 200, json: { ...details, ...(run ? { restartRequired: true, migrations: ['001_initial.sql'] } : {}) } });
  });
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: 'ติดตั้ง CUSA SSO' })).toBeVisible();
  expect(requests).toEqual([]);
  await page.getByLabel('รหัสติดตั้ง', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'ตรวจสอบความพร้อม' }).click();
  await expect(page.getByText(details.adminEmail, { exact: true })).toBeVisible();
  const install = page.getByRole('button', { name: 'สร้างตารางและติดตั้งระบบ' });
  await expect(install).toBeDisabled();
  await page.getByRole('checkbox').check();
  await install.click();
  await expect(page.getByRole('heading', { name: 'ติดตั้งเรียบร้อยแล้ว' })).toBeVisible();
  await expect(page.getByText('INSTALL_ENABLED=false', { exact: true })).toBeVisible();
  await expect(page.getByLabel('รหัสติดตั้ง', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`)).not.toContain(token);
  expect(requests).toHaveLength(2); expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/install-success.png', fullPage: true });
});

test('mobile installer handles incorrect credentials and a previously installed database', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDocument(page);
  let requests = 0;
  await page.route('**/api/install/check', route => {
    requests++;
    return route.fulfill({ status: requests === 1 ? 401 : 409,
      json: requests === 1 ? { code: 'INSTALL_UNAUTHORIZED', error: 'รหัสติดตั้งไม่ถูกต้อง' } : { code: 'INSTALL_LOCKED', error: 'ฐานข้อมูลนี้ติดตั้งแล้ว' } });
  });
  await page.goto('/install');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/install-mobile.png', fullPage: true });
  await page.getByLabel('รหัสติดตั้ง', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'ตรวจสอบความพร้อม' }).click();
  await expect(page.getByRole('alert')).toHaveText('รหัสติดตั้งไม่ถูกต้อง');
  await page.getByRole('button', { name: 'ตรวจสอบความพร้อม' }).click();
  await expect(page.getByRole('heading', { name: 'ปิดการติดตั้งแล้ว' })).toBeVisible();
  await expect(page.getByLabel('รหัสติดตั้ง', { exact: true })).toHaveCount(0);
});
