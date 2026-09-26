import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: '00000000-0000-7000-8000-000000000501',
  username: 'reload-e2e-user',
  createdAt: '2026-09-21T00:00:00.000Z',
};
const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1,
  defaultCaptureTarget: 'ROOT',
  version: 1,
  updatedAt: user.createdAt,
};

async function mockSession(page: Page, handleV2: (route: Route, path: string) => Promise<void>) {
  let authenticated = false;
  let holdSyncPull = true;
  let releaseSyncPull!: () => void;
  const syncPullGate = new Promise<void>((resolve) => {
    releaseSyncPull = resolve;
  });
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/refresh'))
      return json(
        route,
        authenticated ? { accessToken: 'reload-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'reload-token',
        user,
        settings,
        capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
      });
    }
    if (path.endsWith('/me'))
      return json(route, {
        user,
        settings,
        capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
      });
    return json(route, {});
  });

  await page.route('**/api/v2/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sync/snapshot'))
      return json(route, {
        folders: [],
        tasks: [],
        notes: [],
        taskSteps: [],
        timePoints: [],
        placements: [],
        workflows: [],
        workflowStages: [],
        workflowTaskMemberships: [],
        archiveOperations: [],
        settings,
        cursor: '0',
      });
    if (path.endsWith('/sync/pull')) {
      if (holdSyncPull) await syncPullGate;
      return json(route, { changes: [], nextCursor: '0', hasMore: false });
    }
    if (path.endsWith('/sync/push')) return json(route, { protocolVersion: 2, results: [] });
    await handleV2(route, path);
  });

  return {
    releaseSyncPull() {
      holdSyncPull = false;
      releaseSyncPull();
    },
    async login() {
      await page.goto('/login');
      await page.getByLabel('用户名').fill(user.username);
      await page.getByLabel('密码').fill('correct horse battery staple');
      await page.getByRole('button', { name: '登录' }).click();
      const authenticatedShellAction =
        test.info().project.name === 'mobile'
          ? page.getByRole('button', { name: '打开创建菜单' })
          : page.getByRole('button', { name: '快速添加' });
      await expect(authenticatedShellAction).toBeVisible();
    },
  };
}

test('directory keeps real empty state separate from failed and refreshing reads', async ({
  page,
}) => {
  const task = {
    id: '00000000-0000-7000-8000-000000000502',
    referenceId: 'TASK-RELOAD-1',
    parentFolderId: null,
    title: '保留在屏幕上的任务',
    status: 'TODO',
    version: 1,
  };
  let childReads = 0;
  let holdRefresh = false;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith('/tree/children')) {
      childReads += 1;
      if (childReads === 1)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '目录暂时不可用' }),
        });
      if (holdRefresh && childReads > 2) await refreshGate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ kind: 'TASK', task }] }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  try {
    await session.login();
    await page.goto('/tree');
    await expect(page.locator('.m3e-alert--error')).toContainText('目录暂时不可用');
    await expect(page.getByText('创建任务或文件夹后，它们会显示在这里。')).toHaveCount(0);
    await page.getByRole('button', { name: '重试' }).click();
    const row = page.locator('.m3e-list-item--tree-row', { hasText: task.title });
    await expect(row).toBeVisible();

    holdRefresh = true;
    await page.evaluate(() => window.dispatchEvent(new Event('devtodo:data-changed')));
    // A held background refresh must neither blank the directory nor swap the
    // loaded rows for a loading state.
    await expect(row).toBeVisible();
    await expect(page.getByText('正在加载目录')).toHaveCount(0);
  } finally {
    holdRefresh = false;
    releaseRefresh();
    session.releaseSyncPull();
  }
});

test('event detail keeps loaded content visible when an event action fails', async ({ page }) => {
  const event = {
    id: '00000000-0000-7000-8000-000000000503',
    type: 'EVENT',
    localDate: null,
    title: '下一次发布窗口',
    rank: '1024',
    version: 1,
    reachedAt: null,
    archivedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  let failPlacementRead = true;
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith(`/time-points/${event.id}/placements`)) {
      if (failPlacementRead) {
        failPlacementRead = false;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '事件安排暂时不可用' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    if (path.endsWith(`/time-points/${event.id}`))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(event),
      });
    if (path.endsWith(`/time-points/${event.id}/reach`))
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'MUTATION_REJECTED', message: '事件状态冲突' }),
      });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  try {
    await session.login();
    await page.goto(`/time/events/${event.id}`);
    await expect(page.locator('.m3e-alert--error')).toContainText('事件安排暂时不可用');
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();

    await page.getByRole('button', { name: '标记已到达' }).click();
    await expect(page.locator('.m3e-alert--error')).toContainText('事件状态冲突');
    await expect(page.locator('.m3e-alert--error')).toContainText('事件操作失败');
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByText('等待中')).toBeVisible();
  } finally {
    session.releaseSyncPull();
  }
});

test('event list retries a failed first read without showing a false empty state', async ({
  page,
}) => {
  let activeEventReads = 0;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const session = await mockSession(page, async (route, path) => {
    const url = new URL(route.request().url());
    const refererPath = new URL(route.request().headers().referer ?? 'http://localhost').pathname;
    if (
      path.endsWith('/time-points') &&
      url.searchParams.get('archived') === 'false' &&
      refererPath === '/time/events'
    ) {
      activeEventReads += 1;
      if (activeEventReads === 1)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '事件列表暂时不可用' }),
        });
      await retryGate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
  });

  try {
    await session.login();
    await page.goto('/time/events');
    await expect(page.locator('.m3e-alert--error')).toContainText('事件列表暂时不可用');
    await expect(page.getByText('还没有自定义事件')).toHaveCount(0);

    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('正在加载')).toBeVisible();
    releaseRetry();
    await expect(page.getByText('还没有自定义事件')).toBeVisible();
  } finally {
    releaseRetry();
    session.releaseSyncPull();
  }
});

test('workflow list only shows its empty state after a successful read', async ({ page }) => {
  let workflowReads = 0;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith('/workflows')) {
      workflowReads += 1;
      if (workflowReads === 1)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '流程列表暂时不可用' }),
        });
      await retryGate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
  });

  try {
    await session.login();
    await page.goto('/workflows');
    await expect(page.locator('.m3e-alert--error')).toContainText('流程列表暂时不可用');
    await expect(page.getByText('还没有流程')).toHaveCount(0);

    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('正在加载流程')).toBeVisible();
    releaseRetry();
    await expect(page.getByText('还没有流程')).toBeVisible();
  } finally {
    releaseRetry();
    session.releaseSyncPull();
  }
});

test('archive center does not label a failed task read as an empty archive', async ({ page }) => {
  let failArchivedTasks = true;
  const session = await mockSession(page, async (route, path) => {
    const url = new URL(route.request().url());
    if (path.endsWith('/archive-operations'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    if (path.endsWith('/tasks') && url.searchParams.get('archived') === 'true') {
      if (failArchivedTasks) {
        failArchivedTasks = false;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '归档任务暂时不可用' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
  });

  try {
    await session.login();
    await page.goto('/archive');
    await expect(page.locator('.m3e-alert--error')).toContainText('归档任务暂时不可用');
    await expect(page.getByText('没有单独归档的任务')).toHaveCount(0);
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('没有单独归档的任务')).toBeVisible();
  } finally {
    session.releaseSyncPull();
  }
});
