import { test, expect } from '@playwright/test';
import { thaiMobile, displayThaiMobile } from '../../web/src/models/phone';

test('Thai mobile entry preserves leading zeros and normalizes only valid mobile numbers', () => {
  for (const input of ['0812345678', '081 234 5678', '081-234-5678', '+66812345678', '66812345678', '๐๘๑๒๓๔๕๖๗๘']) {
    expect(thaiMobile(input)).toBe('+66812345678');
    expect(displayThaiMobile(input)).toBe('081 234 5678');
  }
  expect(thaiMobile('0612345678')).toBe('+66612345678');
  expect(thaiMobile('0912345678')).toBe('+66912345678');
  for (const input of ['', '081234567', '08123456789', '0212345678', '+668123456789', '+440812345678', '08abc12345678', '0812345678 ext 1']) {
    expect(thaiMobile(input)).toBeNull();
  }
});

test('Admin enters with one TOTP verification, receives success only after MFA, and can browse without reauthentication', async ({ page }) => {
  let verified = false, verifications = 0, reauth = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/status') return route.fulfill({ json: { configured: true } });
    if (path === '/api/auth/me') return route.fulfill({ json: {
      user: { id: 'admin-test', email: 'admin@example.test', name: 'Test Admin', role: 'admin', totpEnabled: true },
      csrfToken: 'test-csrf', requiresMfa: !verified, mfaMethod: 'totp', adminMfaRequired: !verified,
      factors: { passkey: true, line: true, phoneVerified: true },
    } });
    if (path === '/api/auth/totp/verify') {
      expect(route.request().postDataJSON()).toEqual({ code: '012345' });
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      verifications++; verified = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/auth/reauth') reauth++;
    return route.fulfill({ json: { stats: { users: 0, allowedEmails: 0, applications: 0, activeApiKeys: 0, mfaEnabled: 0, activeSessions: 0 }, users: [], emails: [], applications: [], apiKeys: [], events: [], sessions: [], passkeys: [], meta: { total: 0, totalPages: 1, currentPage: 1, limit: 10 } } });
  });
  await page.goto('/login?auth=success&status=mfa_required');
  await expect(page.getByRole('heading', { name: 'ยืนยันว่าเป็นคุณ' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'เข้าสู่ระบบสำเร็จ' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ยืนยันผ่าน LINE', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ยืนยันด้วย Passkey' })).toHaveCount(0);
  const digits = page.locator('.otp-digits input');
  for (let i = 0; i < 6; i++) await digits.nth(i).fill('012345'[i]);
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'เข้าสู่ระบบสำเร็จ' })).toBeVisible();
  await expect(page).toHaveURL('/login');
  await page.getByRole('navigation').getByRole('button', { name: /^ผู้ใช้งาน/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ยืนยันสิทธิ์ Admin' })).toHaveCount(0);
  expect(verifications).toBe(1); expect(reauth).toBe(0);
  await page.screenshot({ path: 'test-results/admin-login-success.png', fullPage: true, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'เข้าสู่ระบบสำเร็จ' })).toHaveCount(0);
});
