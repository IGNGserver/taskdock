import { expect, test } from '@playwright/test';

test.describe('real API and IndexedDB workflow', () => {
  test.skip(process.env['E2E_REAL'] !== '1', 'real API suite is enabled by E2E_REAL=1');
  test.describe.configure({ mode: 'serial' });

  const username = process.env['E2E_USERNAME'] ?? 'e2e-real-owner';
  const password = 'e2e-real-password-change-me';

  test('captures into the tree and converges in a second browser context', async ({
    page,
    browser,
  }) => {
    const isMobile = test.info().project.name === 'mobile';

    await page.goto('/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
    await page.goto('/tree');

    const title = `真实链路 ${Date.now()}`;
    const folderForm = page.locator('form.inline-capture').first();
    await folderForm.getByRole('textbox').fill(title);
    await folderForm.getByRole('button').click();
    await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });

    const secondContext = await browser.newContext(
      isMobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {},
    );
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto('/login');
      await secondPage.getByLabel('用户名').fill(username);
      await secondPage.getByLabel('密码').fill(password);
      await secondPage.getByRole('button', { name: '登录' }).click();
      await expect(secondPage.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
      await secondPage.goto('/tree');
      await expect(secondPage.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
      if (isMobile)
        await expect(secondPage.getByRole('navigation', { name: '移动导航' })).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });
});
