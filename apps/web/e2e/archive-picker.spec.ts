import { expect, test } from '@playwright/test';

test('archives and restores a v2 folder through the tree and archive views', async ({ page }) => {
  const user = {
    id: '00000000-0000-7000-8000-000000000101',
    username: 'archive-e2e-user',
    createdAt: '2026-09-04T10:00:00.000Z',
  };
  const folder = {
    id: '00000000-0000-7000-8000-000000000104',
    parentFolderId: null,
    title: '归档回归文件夹',
    rank: '1024',
    version: 1,
    archivedAt: null,
    archivedByOperationId: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    deletedAt: null,
  };
  const task = {
    id: '00000000-0000-7000-8000-000000000105',
    referenceId: 'TASK-1',
    parentFolderId: folder.id,
    title: '归档回归任务',
    status: 'TODO' as const,
    rank: '1024',
    version: 1,
    completedAt: null,
    archivedAt: null,
    archivedByOperationId: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    deletedAt: null,
  };
  const settings = {
    ownerId: user.id,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1 as const,
    defaultCaptureTarget: 'ROOT' as const,
    version: 1,
    updatedAt: user.createdAt,
  };
  const archiveOperation = {
    id: '00000000-0000-7000-8000-000000000106',
    rootFolderId: folder.id,
    rootBaseVersion: 1,
    folderCount: 1,
    taskCount: 1,
    createdAt: user.createdAt,
    restoredAt: null,
  };
  let archived = false;

  const snapshot = () => ({
    folders: archived
      ? [{ ...folder, archivedAt: user.createdAt, archivedByOperationId: archiveOperation.id }]
      : [folder],
    tasks: archived
      ? [{ ...task, archivedAt: user.createdAt, archivedByOperationId: archiveOperation.id }]
      : [task],
    notes: [],
    taskSteps: [],
    timePoints: [],
    placements: [],
    workflows: [],
    workflowStages: [],
    workflowTaskMemberships: [],
    archiveOperations: archived ? [archiveOperation] : [],
    settings,
    cursor: '0',
  });
  let authenticated = false;

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.endsWith('/auth/refresh'))
      return json(
        authenticated ? { accessToken: 'archive-e2e-access-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/bootstrap/status')) return json({ initialized: true });
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json({
        accessToken: 'archive-e2e-access-token',
        user,
        device: {
          id: '00000000-0000-7000-8000-000000000107',
          name: '浏览器',
          platform: 'web',
          lastSeenAt: user.createdAt,
          createdAt: user.createdAt,
          revokedAt: null,
        },
      });
    }
    if (path.endsWith('/me'))
      return json({
        user,
        settings,
        capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
      });
    return json({});
  });

  await page.route('**/api/v2/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.endsWith('/sync/snapshot')) return json(snapshot());
    if (path.endsWith('/sync/pull')) return json({ changes: [], nextCursor: '0', hasMore: false });
    if (path.endsWith('/sync/push')) return json({ protocolVersion: 2, results: [] });
    if (path.endsWith('/tree/children'))
      return json({
        items: archived
          ? []
          : [
              {
                kind: 'FOLDER',
                folder,
                aggregate: {
                  status: 'TODO',
                  todoCount: 1,
                  inProgressCount: 0,
                  doneCount: 0,
                  totalCount: 1,
                },
              },
            ],
      });
    if (path.endsWith('/folders') && method === 'GET')
      return json({
        items:
          url.searchParams.get('archived') === 'true'
            ? archived
              ? [
                  {
                    ...folder,
                    archivedAt: user.createdAt,
                    archivedByOperationId: archiveOperation.id,
                  },
                ]
              : []
            : archived
              ? []
              : [folder],
      });
    if (path.endsWith('/tasks') && method === 'GET')
      return json({
        items:
          url.searchParams.get('archived') === 'true'
            ? archived
              ? [
                  {
                    ...task,
                    archivedAt: user.createdAt,
                    archivedByOperationId: archiveOperation.id,
                  },
                ]
              : []
            : archived
              ? []
              : [task],
      });
    if (path.endsWith('/time-points') && method === 'GET') return json({ items: [] });
    if (path.endsWith(`/folders/${folder.id}/archive-tree`) && method === 'POST') {
      archived = true;
      return json(archiveOperation);
    }
    if (path.endsWith(`/folders/${folder.id}/restore-tree`) && method === 'POST') {
      archived = false;
      return json({ ...archiveOperation, restoredAt: user.createdAt });
    }
    return json({});
  });

  page.on('dialog', (dialog) => void dialog.accept());

  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  const quickEntry =
    test.info().project.name === 'mobile'
      ? page.getByRole('button', { name: '打开创建菜单' })
      : page.getByRole('button', { name: '快速添加' });
  await expect(quickEntry).toBeVisible();

  await page.goto('/tree');
  const folderButton = page.getByRole('button', { name: `打开文件夹 ${folder.title}` });
  await expect(folderButton).toBeVisible();
  await page.getByRole('button', { name: `打开 ${folder.title} 的操作菜单` }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('devtodo:data-changed')));
  await expect(page.getByRole('menuitem', { name: '归档文件夹', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '归档文件夹', exact: true }).click();
  await expect(folderButton).toHaveCount(0);

  await page.goto('/archive');
  await expect(page.getByText(folder.title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复文件夹' }).click();
  await expect(page.getByText(folder.title, { exact: true })).toHaveCount(0);

  await page.goto('/tree');
  await expect(page.getByRole('button', { name: `打开文件夹 ${folder.title}` })).toBeVisible();
});
