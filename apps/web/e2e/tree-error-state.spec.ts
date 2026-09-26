import { expect, test, type Route } from '@playwright/test';

/*
 * This suite fabricates API failures with `page.route`, so it belongs to the
 * mocked gate. Under `E2E_REAL=1` the fixture answers for itself, the injected
 * 409/503 never happens, and the assertions below would measure an error state
 * the run never produced.
 */
test.skip(process.env['E2E_REAL'] === '1', 'drives failures through page.route mocks');

test('tree separates load errors from empty folders and recovers task detail in place', async ({
  page,
}) => {
  const user = {
    id: '00000000-0000-7000-8000-000000000401',
    username: 'tree-e2e-user',
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
  const task = {
    id: '00000000-0000-7000-8000-000000000402',
    referenceId: 'TASK-TREE-1',
    parentFolderId: null,
    title: '验收任务',
    status: 'TODO',
    rank: '1024',
    version: 1,
    completedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  const detail = {
    task,
    note: {
      id: '00000000-0000-7000-8000-000000000403',
      taskId: task.id,
      contentMarkdown: '',
      version: 1,
      updatedAt: user.createdAt,
    },
    steps: [],
    placements: [],
    workflowMemberships: [],
    folderPath: [],
  };
  let authenticated = false;
  let treeReads = 0;
  let detailReads = 0;
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
        authenticated ? { accessToken: 'tree-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'tree-token',
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
        settings,
        cursor: '0',
      });
    if (path.endsWith('/sync/pull')) {
      if (holdSyncPull) await syncPullGate;
      return json(route, { changes: [], nextCursor: '0', hasMore: false });
    }
    if (path.endsWith('/sync/push')) return json(route, { protocolVersion: 2, results: [] });
    if (path.endsWith('/tree/children')) {
      treeReads += 1;
      if (treeReads === 1)
        return json(route, { code: 'MUTATION_REJECTED', message: '目录暂时不可用' }, 409);
      return json(route, { items: [{ kind: 'TASK', task }] });
    }
    if (path.endsWith(`/tasks/${task.id}`)) {
      detailReads += 1;
      if (detailReads === 1)
        return json(route, { code: 'MUTATION_REJECTED', message: '任务详情暂时不可用' }, 409);
      return json(route, detail);
    }
    return json(route, {});
  });

  try {
    await page.goto('/login');
    await page.getByLabel('用户名').fill(user.username);
    await page.getByLabel('密码').fill('correct horse battery staple');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();

    await page.goto('/tree');
    await expect(page.locator('.m3e-alert--error')).toContainText('目录暂时不可用');
    await expect(page.getByText('暂无当前目录项')).toHaveCount(0);
    await page.getByRole('button', { name: '重试' }).click();
    await page.getByRole('button', { name: '打开任务 验收任务' }).click();

    await expect(page.locator('.m3e-alert--error')).toContainText('任务详情暂时不可用');
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByRole('textbox', { name: '任务标题' })).toHaveValue('验收任务');
  } finally {
    holdSyncPull = false;
    releaseSyncPull();
  }
});
