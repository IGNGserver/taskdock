import { expect, test, type Route } from '@playwright/test';

test('calendar distinguishes a failed load from an empty day and recovers on retry', async ({
  page,
}) => {
  const user = {
    id: '00000000-0000-7000-8000-000000000301',
    username: 'calendar-e2e-user',
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
  const point = {
    id: '00000000-0000-7000-8000-000000000302',
    type: 'DATE',
    localDate: '2026-09-21',
    title: null,
    rank: '1024',
    version: 1,
    reachedAt: null,
    archivedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  let authenticated = false;
  let failFirstPlacementRead = true;
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
        authenticated ? { accessToken: 'calendar-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'calendar-token',
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
    const method = route.request().method();
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
    if (path.endsWith('/time-points/placement-counts')) return json(route, { items: [] });
    if (path.endsWith('/time-points/date') && method === 'POST') return json(route, point, 201);
    if (path.endsWith(`/time-points/${point.id}/placements`)) {
      if (failFirstPlacementRead) {
        failFirstPlacementRead = false;
        return json(route, { code: 'MUTATION_REJECTED', message: '数据库事务被拒绝' }, 409);
      }
      return json(route, { items: [] });
    }
    return json(route, {});
  });

  try {
    await page.goto('/login');
    await page.getByLabel('用户名').fill(user.username);
    await page.getByLabel('密码').fill('correct horse battery staple');
    await page.getByRole('button', { name: '登录' }).click();

    await page.goto('/time/calendar/2026-09-21');
    await expect(page.getByRole('alert')).toContainText('数据库事务被拒绝');
    await expect(page.getByText('这一天还没有安排')).toHaveCount(0);

    const addTask = page.getByRole('button', { name: '加入任务' });
    await expect(addTask).toBeDisabled();
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('这一天还没有安排')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(addTask).toBeEnabled();
    await addTask.click();
    await expect(page.getByRole('dialog', { name: '安排任务' })).toBeVisible();
  } finally {
    holdSyncPull = false;
    releaseSyncPull();
  }
});
