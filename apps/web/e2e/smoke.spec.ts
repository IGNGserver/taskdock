import { expect, test } from '@playwright/test';

test('shows the first-run capture screen with labelled fields', async ({ page }) => {
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'AUTH_SESSION_REVOKED' }),
    }),
  );
  await page.route('**/api/v1/bootstrap/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ initialized: false }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '建立你的工作区' })).toBeVisible();
  await expect(page.getByLabel('初始化令牌')).toBeVisible();
  await expect(page.getByLabel('用户名')).toBeVisible();
  await expect(page.getByRole('button', { name: '初始化并进入' })).toBeVisible();
});

test('opens the authenticated quick-capture dialog and exposes mobile navigation', async ({
  page,
}, testInfo) => {
  const user = {
    id: '00000000-0000-7000-8000-000000000001',
    username: 'e2e-user',
    createdAt: '2026-09-04T10:00:00.000Z',
  };
  const settings = {
    ownerId: user.id,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1,
    defaultCaptureTarget: 'GLOBAL_MISC',
    version: 1,
    updatedAt: user.createdAt,
  };
  const point = {
    id: '00000000-0000-7000-8000-000000000002',
    type: 'DATE',
    localDate: '2026-09-04',
    title: null,
    rank: '1024',
    version: 1,
    reachedAt: null,
    archivedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/auth/refresh'))
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    if (path.endsWith('/bootstrap/status'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ initialized: true }),
      });
    if (path.endsWith('/auth/login'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'e2e-access-token',
          user,
          device: {
            id: '00000000-0000-7000-8000-000000000003',
            name: '浏览器',
            platform: 'web',
            lastSeenAt: user.createdAt,
            createdAt: user.createdAt,
            revokedAt: null,
          },
        }),
      });
    if (path.endsWith('/me'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user,
          settings,
          capabilities: { syncProtocolVersion: 1, websocket: true, offline: true },
        }),
      });
    if (path.endsWith('/sync/pull'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ changes: [], nextCursor: '0', hasMore: false }),
      });
    if (path.endsWith('/sync/push'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 1, results: [] }),
      });
    if (route.request().method() === 'POST' && path.endsWith('/time-points/date'))
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(point),
      });
    if (route.request().method() === 'GET' && path.endsWith('/placements'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    if (route.request().method() === 'GET' && path.endsWith('/projects'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    if (route.request().method() === 'GET' && path.endsWith('/tasks'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    if (route.request().method() === 'GET' && path.endsWith('/time-points'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  const quickEntry =
    testInfo.project.name === 'mobile'
      ? page.getByRole('button', { name: '打开创建菜单' })
      : page.getByRole('button', { name: '快速添加' });
  await expect(quickEntry).toBeVisible();
  if (testInfo.project.name === 'mobile')
    await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();

  await quickEntry.click();
  if (testInfo.project.name === 'mobile') {
    const actionSheet = page.getByRole('dialog', { name: '创建' });
    await expect(actionSheet).toBeVisible();
    await actionSheet.getByRole('button', { name: '新建任务' }).click();
  }
  const dialog = page.getByRole('dialog', { name: '快速添加' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('任务标题')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
