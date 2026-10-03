import { test, expect, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';

async function virtualPasskey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = Buffer.from('synthetic-admin-credential');
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: {
    credentialId: id.toString('base64'), isResidentCredential: true, rpId: 'localhost',
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    userHandle: Buffer.from('admin-test').toString('base64'), signCount: 1,
  } });
  return { challenge: Buffer.alloc(32, 11).toString('base64url'), rpId: 'localhost', userVerification: 'required',
    allowCredentials: [{ id: id.toString('base64url'), type: 'public-key', transports: ['internal'] }] };
}

test('Admin logs in with Passkey once, reuses fresh assurance and chooses Passkey for a later sensitive operation', async ({ page }) => {
  const options = await virtualPasskey(page);
  let loggedIn = false, fresh = true, writes = 0, reauth = 0, login = 0;
  const target = { id: 'target-test', email: 'target@example.test', name: 'Target', role: 'user', totpEnabled: true };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/status') return route.fulfill({ json: { configured: true } });
    if (path === '/api/auth/me') return route.fulfill({ json: {
      user: { id: 'admin-test', name: 'Admin', email: 'admin@example.test', role: 'admin', totpEnabled: true },
      csrfToken: 'test-csrf', requiresMfa: !loggedIn, mfaMethod: loggedIn ? 'passkey' : 'totp', adminMfaRequired: !loggedIn,
      factors: { passkey: true, line: true, phoneVerified: true },
    } });
    if (path.endsWith('/options')) {
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      return route.fulfill({ json: { challengeId: '00000000-0000-4000-8000-000000000001', options } });
    }
    if (path === '/api/auth/passkeys/authenticate/verify' || path === '/api/auth/passkeys/reauth/verify') {
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      const proof = route.request().postDataJSON().response;
      expect(proof.type).toBe('public-key'); expect(proof.response.signature).toBeTruthy();
      const clientData = JSON.parse(Buffer.from(proof.response.clientDataJSON, 'base64url').toString());
      expect(clientData.origin).toBe('http://localhost:4188'); expect(clientData.challenge).toBe(options.challenge);
      if (path.includes('/reauth/')) { reauth++; fresh = true; } else { login++; loggedIn = true; }
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/admin/users/target-test/sessions') {
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
      if (!fresh) return route.fulfill({ status: 403, json: { code: 'MFA_REAUTH_REQUIRED', error: 'กรุณายืนยันรายการสำคัญ' } });
      writes++; return route.fulfill({ json: { ok: true, sessions: 1 } });
    }
    return route.fulfill({ json: { stats: { users: 1, allowedEmails: 1, applications: 0, activeApiKeys: 0, mfaEnabled: 1, activeSessions: 1 },
      users: [target], emails: [], applications: [], apiKeys: [], events: [], sessions: [], passkeys: [], meta: { total: 1, totalPages: 1, currentPage: 1, limit: 10 } } });
  });
  await page.goto('http://localhost:4188/login?auth=success&status=mfa_required');
  await page.getByRole('button', { name: 'ยืนยันด้วย Passkey' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'เข้าสู่ระบบสำเร็จ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยืนยันสิทธิ์ Admin' })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: /^ผู้ใช้งาน/ }).click();
  const openOperation = async () => {
    await page.getByRole('button', { name: 'ออกจากระบบทุกอุปกรณ์ target@example.test' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'ยืนยันยกเลิกสิทธิ์' }).click();
  };
  await openOperation(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(login).toBe(1); expect(reauth).toBe(0); expect(writes).toBe(1);
  fresh = false;
  await openOperation();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'ยืนยันก่อนเปลี่ยนแปลงสิทธิ์' })).toBeVisible();
  await expect(dialog.locator('.otp-digits input')).toHaveCount(6);
  expect(writes).toBe(1);
  await page.screenshot({ path: 'test-results/admin-passkey-reauth.png', fullPage: true, animations: 'disabled' });
  // Cancelling the prompt must not execute the blocked action.
  await dialog.getByRole('button', { name: 'ปิดหน้าต่าง' }).click();
  await expect(dialog).toContainText('ยกเลิกการยืนยัน ไม่มีการเปลี่ยนแปลงสิทธิ์'); expect(writes).toBe(1);
  await dialog.getByRole('button', { name: 'ยืนยันยกเลิกสิทธิ์' }).click();
  await dialog.getByRole('button', { name: 'ยืนยันด้วย Passkey' }).click();
  await expect(dialog).toHaveCount(0); expect(reauth).toBe(1); expect(writes).toBe(2);
  await openOperation(); await expect(dialog).toHaveCount(0); expect(reauth).toBe(1); expect(writes).toBe(3);
});

for (const scenario of ['unverified', 'verified', 'disabled', 'required'] as const) {
  test(`Phone reminder: ${scenario}; no automatic SMS or loss of the required verification gate`, async ({ page }) => {
    let sends = 0;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/status') return route.fulfill({ json: { configured: true } });
      if (path === '/api/auth/me') return route.fulfill({ json: {
        user: { id: 'member-test', name: 'Member', email: 'member@example.test', role: 'user', totpEnabled: true },
        requiresMfa: false, csrfToken: 'test-csrf', mfaMethod: 'totp', phoneRequired: scenario === 'required',
        factors: { passkey: true, line: false, phoneEnabled: scenario !== 'disabled', phoneVerified: scenario === 'verified' },
      } });
      if (path === '/api/auth/factors') return route.fulfill({ json: {
        passkeys: [], phoneEnabled: scenario !== 'disabled', phoneVerified: scenario === 'verified',
      } });
      if (path === '/api/auth/phone/start') sends++;
      return route.fulfill({ json: { sessions: [] } });
    });
    await page.goto('/login?auth=success');
    const reminder = page.getByRole('status').filter({ hasText: 'บัญชีนี้ยังไม่ได้ยืนยันเบอร์มือถือ' });
    if (scenario === 'unverified') {
      await expect(reminder).toBeVisible();
      await reminder.getByRole('link', { name: 'ยืนยันเบอร์มือถือ' }).click();
      await expect(page.locator('#phone-verification')).toBeFocused();
      await expect(page.getByRole('textbox', { name: 'เบอร์มือถือของคุณ' })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: 'test-results/phone-reminder-mobile.png', fullPage: true, animations: 'disabled' });
    } else {
      await expect(reminder).toHaveCount(0);
      if (scenario === 'required') {
        await expect(page.getByRole('heading', { name: 'ยืนยันเบอร์มือถือครั้งแรก' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(0);
        await expect(page.getByRole('status').filter({ hasText: 'เข้าสู่ระบบสำเร็จ' })).toHaveCount(0);
      } else await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
    }
    expect(sends).toBe(0);
  });
}
