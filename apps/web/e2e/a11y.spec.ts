import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: '00000000-0000-7000-8000-000000000011',
  username: 'axe-user',
  createdAt: '2026-09-04T10:00:00.000Z',
};
const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1 as const,
  defaultCaptureTarget: 'GLOBAL_MISC',
  version: 1,
  updatedAt: user.createdAt,
};

async function installMockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = (value: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.endsWith('/auth/refresh')) return route.fulfill({ status: 401, body: '{}' });
    if (path.endsWith('/bootstrap/status')) return body({ initialized: true });
    if (path.endsWith('/auth/login'))
      return body({
        accessToken: 'axe-access-token',
        user,
        device: {
          id: '00000000-0000-7000-8000-000000000013',
          name: '浏览器',
          platform: 'web',
          lastSeenAt: user.createdAt,
          createdAt: user.createdAt,
          revokedAt: null,
        },
      });
    if (path.endsWith('/me'))
      return body({
        user,
        settings,
        capabilities: { syncProtocolVersion: 1, websocket: true, offline: true },
      });
    if (path.endsWith('/sync/pull')) return body({ changes: [], nextCursor: '0', hasMore: false });
    if (path.endsWith('/sync/push')) return body({ protocolVersion: 1, results: [] });
    if (path.endsWith('/devices')) return body([]);
    if (path.endsWith('/projects')) return body({ items: [] });
    if (path.endsWith('/tasks')) return body({ items: [] });
    if (path.endsWith('/time-points')) return body({ items: [] });
    if (path.endsWith('/placements')) return body({ items: [] });
    return body({});
  });
}

test('login and authenticated shell have no axe violations', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  let results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  const quickEntry =
    test.info().project.name === 'mobile'
      ? page.getByRole('button', { name: '打开创建菜单' })
      : page.getByRole('button', { name: '快速添加' });
  await expect(quickEntry).toBeVisible();
  results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
