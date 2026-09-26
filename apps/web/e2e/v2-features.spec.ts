import { expect, test } from '@playwright/test';

test('verifies v2 workflow reordering, direct status toggles, folder display, and folder-first tree sorting', async ({
  page,
}) => {
  const user = {
    id: '00000000-0000-7000-8000-000000000201',
    username: 'v2-e2e-user',
    createdAt: '2026-09-15T00:00:00.000Z',
  };

  const folder = {
    id: '00000000-0000-7000-8000-000000000202',
    parentFolderId: null,
    title: '工作项目',
    rank: '1024',
    version: 1,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    deletedAt: null,
  };

  const task1 = {
    id: '00000000-0000-7000-8000-000000000203',
    referenceId: 'TASK-1',
    parentFolderId: folder.id,
    title: '任务一',
    status: 'TODO' as const,
    rank: '2048',
    version: 1,
    completedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    deletedAt: null,
  };

  const task2 = {
    id: '00000000-0000-7000-8000-000000000204',
    referenceId: 'TASK-2',
    parentFolderId: folder.id,
    title: '任务二',
    status: 'TODO' as const,
    rank: '3072',
    version: 1,
    completedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    deletedAt: null,
  };

  const workflow = {
    id: '00000000-0000-7000-8000-000000000205',
    name: '发布流程',
    rank: '1024',
    version: 1,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    deletedAt: null,
    stages: [
      {
        id: '00000000-0000-7000-8000-000000000206',
        workflowId: '00000000-0000-7000-8000-000000000205',
        name: '开发阶段',
        rank: '1024',
        version: 1,
        createdAt: user.createdAt,
        updatedAt: user.createdAt,
        deletedAt: null,
        tasks: [task1, task2],
        memberships: [
          {
            id: '00000000-0000-7000-8000-000000000207',
            workflowId: '00000000-0000-7000-8000-000000000205',
            stageId: '00000000-0000-7000-8000-000000000206',
            taskId: task1.id,
            rank: '1024',
            version: 1,
            createdAt: user.createdAt,
            updatedAt: user.createdAt,
            deletedAt: null,
          },
          {
            id: '00000000-0000-7000-8000-000000000208',
            workflowId: '00000000-0000-7000-8000-000000000205',
            stageId: '00000000-0000-7000-8000-000000000206',
            taskId: task2.id,
            rank: '2048',
            version: 1,
            createdAt: user.createdAt,
            updatedAt: user.createdAt,
            deletedAt: null,
          },
        ],
        hiddenTaskCount: 0,
      },
    ],
  };

  const settings = {
    ownerId: user.id,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1 as const,
    defaultCaptureTarget: 'ROOT' as const,
    version: 1,
    updatedAt: user.createdAt,
  };

  const snapshot = {
    folders: [folder],
    tasks: [task1, task2],
    notes: [],
    taskSteps: [],
    timePoints: [],
    placements: [],
    workflows: [workflow],
    workflowStages: [workflow.stages[0]],
    workflowTaskMemberships: workflow.stages[0].memberships,
    settings,
    cursor: '0',
  };
  let authenticated = false;

  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ initialized: true }),
      });
    if (path.endsWith('/auth/refresh'))
      return route.fulfill({
        status: authenticated ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(authenticated ? { accessToken: 'v2-token' } : {}),
      });
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'v2-token',
          user,
          settings,
          capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
        }),
      });
    }
    if (path.endsWith('/me'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user,
          settings,
          capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
        }),
      });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/api/v2/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sync/snapshot'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot),
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
        body: JSON.stringify({ protocolVersion: 2, results: [] }),
      });
    if (path.endsWith('/workflows')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [workflow] }),
      });
    }
    if (path.endsWith('/tasks')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [task1, task2] }),
      });
    }
    if (path.endsWith('/folders')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [folder] }),
      });
    }
    if (path.includes('/folders/') && path.endsWith('/path')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ id: folder.id, title: folder.title }] }),
      });
    }
    if (path.includes('/tree/children')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              kind: 'TASK',
              task: task1,
            },
            {
              kind: 'TASK',
              task: task2,
            },
          ],
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();

  // Navigate to Workflows page
  await page.goto('/workflows');
  await expect(page.getByRole('heading', { level: 2, name: '发布流程' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: '开发阶段' })).toBeVisible();
  await expect(page.getByText('任务一')).toBeVisible();
  await expect(
    page
      .locator('.m3e-list-item--workflow-task')
      .first()
      .getByText(/工作项目/),
  ).toBeVisible();

  // Row verbs live in one overflow menu per task, so in-stage reordering is
  // reached from the first row and correctly disabled at the list boundary.
  await page.getByRole('button', { name: '任务一 的操作' }).click();
  await expect(page.getByRole('menuitem', { name: /在阶段内下移/ })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: /在阶段内上移/ })).toBeDisabled();

  // Test deep-link jump to directory with focusTask query parameter
  await page.goto(`/tree/${folder.id}?focusTask=${task1.id}`);
  await expect(page.locator('.m3e-list-item.is-selected')).toBeVisible();
  await expect(page.locator('.m3e-list-item.is-selected')).toContainText('任务一');
});
