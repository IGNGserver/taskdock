import { expect, test } from '@playwright/test';

test('supports project archive confirmation, recovery, and custom time point creation', async ({
  page,
}, testInfo) => {
  const user = {
    id: '00000000-0000-7000-8000-000000000101',
    username: 'archive-e2e-user',
    createdAt: '2026-09-04T10:00:00.000Z',
  };
  const project = {
    id: '00000000-0000-7000-8000-000000000104',
    name: '归档回归项目',
    taskPrefix: 'ARCHIVE',
    rank: '1024',
    version: 1,
    archivedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  const task = {
    id: '00000000-0000-7000-8000-000000000105',
    referenceId: 'ARCHIVE-1',
    projectId: project.id,
    category: 'FEATURE',
    title: '验证安排弹窗',
    status: 'TODO',
    priority: 'NONE',
    rank: '1024',
    version: 1,
    completedAt: null,
    archivedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  const settings = {
    ownerId: user.id,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1,
    defaultCaptureTarget: 'GLOBAL_MISC',
    version: 1,
    updatedAt: user.createdAt,
  };
  const datePoint = {
    id: '00000000-0000-7000-8000-000000000102',
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
  const eventPoint = {
    id: '00000000-0000-7000-8000-000000000103',
    type: 'EVENT',
    localDate: null,
    title: '已有事件',
    rank: '2048',
    version: 1,
    reachedAt: null,
    archivedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
  let projectArchived = false;
  let createdEvent = false;

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.endsWith('/auth/refresh')) return json({}, 401);
    if (path.endsWith('/bootstrap/status')) return json({ initialized: true });
    if (path.endsWith('/auth/login'))
      return json({
        accessToken: 'archive-e2e-access-token',
        user,
        device: {
          id: '00000000-0000-7000-8000-000000000106',
          name: '浏览器',
          platform: 'web',
          lastSeenAt: user.createdAt,
          createdAt: user.createdAt,
          revokedAt: null,
        },
      });
    if (path.endsWith('/me'))
      return json({
        user,
        settings,
        capabilities: { syncProtocolVersion: 1, websocket: true, offline: true },
      });
    if (path.endsWith('/sync/pull')) return json({ changes: [], nextCursor: '0', hasMore: false });
    if (path.endsWith('/sync/push')) return json({ protocolVersion: 1, results: [] });
    if (path.endsWith('/devices')) return json([]);
    if (path.endsWith('/projects/task-counts') && method === 'GET')
      return json({
        items: projectArchived ? [] : [{ projectId: project.id, openCount: 1, doneCount: 0 }],
      });
    if (path.endsWith('/projects') && method === 'GET')
      return json({
        items:
          url.searchParams.get('archived') === 'true'
            ? projectArchived
              ? [{ ...project, archivedAt: user.createdAt }]
              : []
            : projectArchived
              ? []
              : [project],
      });
    if (path.endsWith(`/projects/${project.id}`) && method === 'GET')
      return json({ ...project, archivedAt: projectArchived ? user.createdAt : null });
    if (path.endsWith(`/projects/${project.id}/archive`) && method === 'POST') {
      projectArchived = true;
      return json({ ...project, archivedAt: user.createdAt });
    }
    if (path.endsWith(`/projects/${project.id}/restore`) && method === 'POST') {
      projectArchived = false;
      return json(project);
    }
    if (path.endsWith('/tasks') && method === 'GET')
      return json({ items: url.searchParams.get('archived') === 'true' ? [] : [task] });
    if (path.endsWith('/time-points/placement-counts') && method === 'GET')
      return json({ items: [] });
    if (path.endsWith('/time-points') && method === 'GET')
      return json({ items: [datePoint, ...(createdEvent ? [eventPoint] : [])] });
    if (path.endsWith('/time-points/events') && method === 'POST') {
      createdEvent = true;
      return json(eventPoint, 201);
    }
    if (path.endsWith('/placements') && method === 'GET') return json({ items: [] });
    if (path.endsWith('/placements') && method === 'POST')
      return json({ id: 'placement-e2e' }, 201);
    if (path.endsWith('/time-points/date') && method === 'POST') return json(datePoint, 201);
    return json({});
  });

  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('button', { name: '快速添加' })).toBeVisible();

  const openMobileSidebar = async () => {
    if (testInfo.project.name !== 'mobile') return;
    await page.getByRole('button', { name: '打开侧边栏' }).click();
    await expect(page.getByRole('complementary', { name: '移动侧边栏' })).toBeVisible();
  };

  await openMobileSidebar();
  await page.getByRole('link', { name: '新建项目' }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
  const archiveProjectButton = page.getByRole('button', { name: '归档归档回归项目' });
  await expect(archiveProjectButton).toHaveCount(1);
  await archiveProjectButton.click();
  const archiveDialog = page.getByRole('dialog', { name: '归档项目' });
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog).toContainText('不会被删除或自动归档');
  await archiveDialog.getByRole('button', { name: '归档项目', exact: true }).click();
  await expect(page.getByText('还没有项目')).toBeVisible();

  await openMobileSidebar();
  await page.getByRole('link', { name: '归档', exact: true }).click();
  await expect(page.getByText('归档回归项目')).toBeVisible();
  await page.getByRole('button', { name: '恢复项目' }).click();
  await expect(page.getByText('没有归档任务')).toBeVisible();

  await openMobileSidebar();
  await page.getByRole('link', { name: '任务库' }).click();
  await page.getByRole('button', { name: '安排到时间点' }).click();
  const picker = page.getByRole('dialog', { name: '安排到时间点' });
  await expect(picker).toBeVisible();
  await picker.getByRole('radio', { name: '自定义时间点' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await picker.getByRole('button', { name: '新建时间点' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await picker.getByLabel('时间点名称').fill('刚创建的事件');
  await picker.getByRole('button', { name: '创建并选择' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(picker.locator('select')).toHaveValue(eventPoint.id);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
});
