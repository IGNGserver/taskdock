import { expect, test, type Route } from '@playwright/test';
import { missingProgressiveRoute } from './legacy-hub-fixture.js';

test.skip(process.env['E2E_REAL'] === '1', 'injects partial bootstrap and cursor failures');

test('directory first page is independent of breadcrumbs; more failures retain rows and can restart', async ({
  page,
}) => {
  const now = '2026-10-20T00:00:00.000Z';
  const owner = '00000000-0000-7000-8000-000000000501';
  const folder = '00000000-0000-7000-8000-000000000502';
  const user = { id: owner, username: 'paged-owner', createdAt: now };
  const settings = {
    ownerId: owner,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1,
    defaultCaptureTarget: 'ROOT',
    version: 1,
    updatedAt: now,
  };
  const item = (index: number) => ({
    kind: 'TASK',
    task: {
      id: `00000000-0000-7000-8000-${String(index + 1000).padStart(12, '0')}`,
      parentFolderId: folder,
      title: `分页任务 ${index}`,
      referenceId: `TASK-${index}`,
      status: 'TODO',
      rank: String(index * 1024),
      version: 1,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  let loggedIn = false;
  let nextReads = 0;
  let firstReads = 0;
  let summaryReads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const json = (route: Route, value: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/refresh'))
      return json(route, loggedIn ? { accessToken: 'paged-token' } : {}, loggedIn ? 200 : 401);
    if (path.endsWith('/auth/login')) loggedIn = true;
    return json(route, {
      accessToken: 'paged-token',
      user,
      settings,
      capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
    });
  });
  await page.route('**/api/v2/**', async (route) => {
    const url = new URL(route.request().url());
    if (await missingProgressiveRoute(route, url.pathname)) return;
    if (url.pathname.endsWith('/sync/snapshot') || url.pathname.endsWith('/sync/pull')) {
      await held;
      return json(route, { changes: [], nextCursor: '0', hasMore: false });
    }
    if (url.pathname.endsWith('/path')) {
      await held;
      return json(route, { items: [{ id: folder, title: '慢路径' }] });
    }
    if (url.searchParams.get('view') === 'summary') {
      summaryReads++;
      return json(route, { task: item(150).task });
    }
    if (url.pathname.endsWith('/tree/children')) {
      expect(url.searchParams.get('limit')).toBe('100');
      if (!url.searchParams.has('cursor')) {
        firstReads++;
        return json(route, {
          items: Array.from({ length: 100 }, (_, i) => item(i + 1)),
          parentFolderId: folder,
          nextCursor: 'page-two',
        });
      }
      nextReads++;
      if (nextReads === 1)
        return json(route, { code: 'INTERNAL_ERROR', message: '下一页暂时不可用' }, 503);
      if (nextReads === 2)
        return json(
          route,
          { code: 'SYNC_CURSOR_EXPIRED', message: '目录已变化，请重新加载后继续' },
          410,
        );
      return json(route, { items: [item(101)], parentFolderId: folder, nextCursor: null });
    }
    return json(route, {});
  });
  try {
    await page.goto('/login');
    await page.getByLabel('用户名').fill(user.username);
    await page.getByLabel('密码').fill('test-only-directory-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
    await page.goto(`/tree/${folder}?focusTask=${item(150).task.id}`);
    await expect(
      page.getByRole('button', { name: '打开任务 分页任务 1', exact: true }),
    ).toBeVisible();
    expect(nextReads).toBe(0);
    await expect(
      page.getByRole('button', { name: '打开任务 分页任务 150', exact: true }),
    ).toBeVisible();
    expect(summaryReads).toBeGreaterThan(0);
    await expect(page.getByPlaceholder('筛选已加载项…')).toBeVisible();
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByText('下一页暂时不可用', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '打开任务 分页任务 1', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新加载目录' })).toBeVisible();
    await page.getByRole('button', { name: '重新加载目录' }).click();
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toBeEnabled();
    expect(firstReads).toBeGreaterThan(0);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '打开任务 分页任务 101', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});
