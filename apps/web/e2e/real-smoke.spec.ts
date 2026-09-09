import { expect, test, type Page } from '@playwright/test';

test.describe('real API and IndexedDB workflow', () => {
  test.skip(process.env['E2E_REAL'] !== '1', 'real API suite is enabled by E2E_REAL=1');
  test.describe.configure({ mode: 'serial' });

  const username = process.env['E2E_USERNAME'] ?? 'e2e-real-owner';
  const password = 'e2e-real-password-change-me';

  test('captures into Today and converges in a second browser context', async ({
    page,
    browser,
  }) => {
    const isMobile = test.info().project.name === 'mobile';
    const openTaskCapture = async (targetPage: Page) => {
      if (isMobile) {
        await targetPage.getByRole('button', { name: '打开创建菜单' }).click();
        const actionSheet = targetPage.getByRole('dialog', { name: '创建' });
        await expect(actionSheet).toBeVisible();
        await actionSheet.getByRole('button', { name: '新建任务' }).click();
      } else {
        await targetPage.getByRole('button', { name: '快速添加' }).click();
      }
      await expect(targetPage.getByRole('dialog', { name: '快速添加' })).toBeVisible();
    };

    await page.goto('/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录' }).click();
    const quickEntry = isMobile
      ? page.getByRole('button', { name: '打开创建菜单' })
      : page.getByRole('button', { name: '快速添加' });
    await expect(quickEntry).toBeVisible();
    await page.goto('/today');

    const title = `真实链路 ${Date.now()}`;
    await openTaskCapture(page);
    const dialog = page.getByRole('dialog', { name: '快速添加' });
    await dialog.getByLabel('任务标题').fill(title);
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto('/login');
      await secondPage.getByLabel('用户名').fill(username);
      await secondPage.getByLabel('密码').fill(password);
      await secondPage.getByRole('button', { name: '登录' }).click();
      const secondQuickEntry = isMobile
        ? secondPage.getByRole('button', { name: '打开创建菜单' })
        : secondPage.getByRole('button', { name: '快速添加' });
      await expect(secondQuickEntry).toBeVisible();
      await secondPage.goto('/today');
      await expect(secondPage.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
      if (isMobile)
        await expect(secondPage.getByRole('navigation', { name: '移动导航' })).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });
});
