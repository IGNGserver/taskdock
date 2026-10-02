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
    test.setTimeout(60_000);
    const isMobile = test.info().project.name === 'mobile';

    await page.goto('/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
    await page.goto('/tree');

    const title = `真实链路 ${Date.now()}`;
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
    const folderDialog = page.getByRole('dialog', { name: '新建文件夹', exact: true });
    await folderDialog.getByRole('textbox', { name: '文件夹名称', exact: true }).fill(title);
    await folderDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `打开文件夹 ${title}`, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: `打开文件夹 ${title}`, exact: true }).click();
    const folderPath = new URL(page.url()).pathname;
    const taskTitle = `录入 ${Date.now()}`;
    const capture = page.getByRole('textbox', { name: '新建任务', exact: true });
    await capture.fill(taskTitle);
    await capture.press('Enter');
    await page.getByRole('button', { name: `打开任务 ${taskTitle}`, exact: true }).click();
    await page.getByRole('textbox', { name: '任务标题', exact: true }).fill(`${taskTitle} 已编辑`);
    await page.getByRole('textbox', { name: '任务备注', exact: true }).fill('真实 API 验证的备注');
    const editor = page.locator('.workspace-editor');
    await editor.getByRole('textbox', { name: '新增执行步骤', exact: true }).fill('检查发布文件');
    await expect(editor.getByRole('button', { name: '添加', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: '添加', exact: true }).click();
    await expect(
      editor.getByRole('button', { name: '编辑步骤 检查发布文件', exact: true }),
    ).toBeVisible();
    await editor
      .locator('.workspace-steps')
      .getByRole('button', { name: '标记为进行中', exact: true })
      .click();
    await editor
      .locator('.workspace-steps')
      .getByRole('button', { name: '标记为已完成', exact: true })
      .click();
    await expect(editor.getByRole('radio', { name: '待开始', exact: true })).toBeChecked();
    await expect(editor.locator('.task-save-state')).toContainText('已保存');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: `打开任务 ${taskTitle} 已编辑`, exact: true }),
    ).toBeVisible();

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
      await secondPage.goto(folderPath);
      await expect(
        secondPage.getByRole('button', { name: `打开任务 ${taskTitle} 已编辑`, exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await secondPage
        .getByRole('button', { name: `打开任务 ${taskTitle} 已编辑`, exact: true })
        .click();
      await expect(secondPage.getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue(
        '真实 API 验证的备注',
      );
      await expect(
        secondPage.locator('.workspace-editor').getByRole('heading', { name: '步骤 1/1' }),
      ).toBeVisible();
      if (isMobile)
        await expect(secondPage.getByRole('navigation', { name: '移动导航' })).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });
});
