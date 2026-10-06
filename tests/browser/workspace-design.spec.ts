import { test, expect } from '@playwright/test';

test('workspace directory covers every menu and search supports keywords and keyboard navigation', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'เปิดโหมดตัวอย่าง' }).click();
  const menu = page.getByRole('navigation', { name: 'เมนูหลัก' });
  const buttons = await menu.getByRole('button').allTextContents();
  const directory = page.locator('.feature-directory');
  expect(buttons.length).toBe(11);
  await expect(directory.getByRole('button')).toHaveCount(10);
  for (const name of buttons.slice(1)) await expect(directory.getByRole('button', { name: new RegExp(name.replace(/\d+$/, '').trim()) })).toHaveCount(1);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('textbox', { name: 'ค้นหาเมนู' });
  await expect(search).toBeFocused();
  await search.fill('LINE');
  await expect(menu.getByRole('button')).toHaveCount(1);
  await expect(menu.getByRole('button', { name: 'ความปลอดภัย', exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(page.locator('main h1')).toHaveText('ความปลอดภัย');
  await expect(menu.getByRole('button')).toHaveCount(11);
  await search.fill('ไม่มีเมนูนี้');
  await expect(menu.getByRole('status')).toHaveText(/ไม่พบเมนูที่ค้นหา/);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(menu.getByRole('button')).toHaveCount(11);
});

test('mobile menu traps focus, supports Escape, and stays hidden from keyboard when closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByRole('button', { name: 'เปิดโหมดตัวอย่าง' }).click();
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toHaveAttribute('inert', '');
  const opener = page.getByRole('button', { name: 'เปิดเมนู', exact: true });
  await opener.click();
  const closer = page.getByRole('button', { name: 'ปิดเมนู', exact: true });
  await expect(closer).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(sidebar.getByRole('button', { name: 'ออกจากโหมดตัวอย่าง', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closer).toBeFocused();
  await page.getByRole('textbox', { name: 'ค้นหาเมนู' }).fill('Passkey');
  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(sidebar).not.toHaveClass(/open/);
  await expect(opener).toBeFocused();
  await expect(sidebar).toHaveAttribute('inert', '');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'ค้นหาเมนู' })).toBeFocused();
  await page.screenshot({ path: 'test-results/workspace-menu-mobile.png', animations: 'disabled' });
  await sidebar.getByRole('button', { name: 'ออกจากโหมดตัวอย่าง', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

test('all workspace pages fit narrow phones and tablet widths without horizontal page overflow', async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await page.getByRole('button', { name: 'เปิดโหมดตัวอย่าง' }).click();
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 900) await page.getByRole('button', { name: 'เปิดเมนู', exact: true }).click();
    const menu = page.getByRole('navigation', { name: 'เมนูหลัก' });
    const count = await menu.getByRole('button').count();
    for (let i = 0; i < count; i++) {
      await menu.getByRole('button').nth(i).click();
      await expect(page.locator('main h1')).toBeVisible();
      // Let the lazily loaded guide settle before checking its dimensions.
      if (i === 6) await expect(page.getByRole('heading', { name: 'CUSA SSO API' })).toBeVisible();
      const overflow = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      expect(overflow.content, `page ${i} at ${width}px`).toBeLessThanOrEqual(overflow.width);
      if (width === 320 && [0, 4, 7].includes(i)) await page.screenshot({ path: `test-results/workspace-${i}-320.png`, fullPage: true, animations: 'disabled' });
      if (width <= 900 && i < count - 1) await page.getByRole('button', { name: 'เปิดเมนู', exact: true }).click();
    }
  }
  expect(errors).toEqual([]);
});
