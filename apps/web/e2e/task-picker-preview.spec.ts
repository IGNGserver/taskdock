import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Covers two row-level affordances of the arrangement flow:
 *   - the task picker must show the tasks that are already on the time point as
 *     checked, non-selectable rows, so nobody adds the same task twice;
 *   - hovering a task row on a pointer device previews its note and steps.
 *
 * The suite drives everything through page.route mocks, so it runs in both the
 * mocked and the real-API gates; the hover test skips the touch project.
 */

const user = {
  id: '00000000-0000-7000-8000-000000000401',
  username: 'picker-e2e-user',
  createdAt: '2026-09-21T00:00:00.000Z',
};

const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1 as const,
  defaultCaptureTarget: 'GLOBAL_MISC',
  version: 1,
  updatedAt: user.createdAt,
};

const point = {
  id: '00000000-0000-7000-8000-000000000402',
  type: 'DATE',
  title: '今天',
  localDate: '2026-09-21',
  timezone: 'Asia/Shanghai',
  reachedAt: null,
  version: 1,
  createdAt: user.createdAt,
  updatedAt: user.createdAt,
};

const placedTask = {
  id: '00000000-0000-7000-8000-000000000403',
  referenceId: 'TASK-1',
  parentFolderId: null,
  title: '已安排任务',
  status: 'TODO',
  rank: '1024',
  version: 1,
  completedAt: null,
  deletedAt: null,
  createdAt: user.createdAt,
  updatedAt: user.createdAt,
};

const freeTask = {
  id: '00000000-0000-7000-8000-000000000404',
  referenceId: 'TASK-2',
  parentFolderId: null,
  title: '可选任务',
  status: 'TODO',
  rank: '2048',
  version: 1,
  completedAt: null,
  deletedAt: null,
  createdAt: user.createdAt,
  updatedAt: user.createdAt,
};

const placement = {
  id: '00000000-0000-7000-8000-000000000405',
  ownerId: user.id,
  taskId: placedTask.id,
  timePointId: point.id,
  rank: '1024',
  version: 1,
  createdAt: user.createdAt,
  updatedAt: user.createdAt,
  task: placedTask,
};

const taskDetail = {
  task: placedTask,
  note: {
    id: '00000000-0000-7000-8000-000000000406',
    taskId: placedTask.id,
    contentMarkdown: '这是任务的备注内容，用于悬停预览。',
    version: 1,
    updatedAt: user.createdAt,
  },
  steps: [
    {
      id: '00000000-0000-7000-8000-000000000407',
      taskId: placedTask.id,
      title: '准备发布说明',
      noteMarkdown: '',
      status: 'DONE',
      rank: '1024',
      completedAt: user.createdAt,
      version: 1,
      createdAt: user.createdAt,
      updatedAt: user.createdAt,
      deletedAt: null,
    },
    {
      id: '00000000-0000-7000-8000-000000000408',
      taskId: placedTask.id,
      title: '通知验收人',
      noteMarkdown: '',
      status: 'TODO',
      rank: '2048',
      completedAt: null,
      version: 1,
      createdAt: user.createdAt,
      updatedAt: user.createdAt,
      deletedAt: null,
    },
  ],
  placements: [placement],
  workflowMemberships: [],
  folderPath: [],
};

async function installMockApi(page: Page): Promise<void> {
  let authenticated = false;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/refresh'))
      return json(
        route,
        authenticated ? { accessToken: 'picker-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'picker-token',
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
    return json(route, { items: [] });
  });

  await page.route('**/api/v2/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sync/snapshot'))
      return json(route, {
        folders: [],
        tasks: [placedTask, freeTask],
        notes: [],
        taskSteps: [],
        timePoints: [point],
        placements: [placement],
        workflows: [],
        workflowStages: [],
        workflowTaskMemberships: [],
        settings,
        cursor: '0',
      });
    if (path.endsWith('/sync/pull'))
      return json(route, { changes: [], nextCursor: '0', hasMore: false });
    if (path.endsWith('/sync/push')) return json(route, { protocolVersion: 2, results: [] });
    if (path.endsWith('/time-points/date')) return json(route, point);
    if (path.endsWith('/placements')) return json(route, { items: [placement] });
    if (path.endsWith('/time-points/placement-counts')) return json(route, { items: [] });
    if (path.endsWith('/tree/children'))
      return json(route, {
        items: [
          { kind: 'TASK', task: placedTask },
          { kind: 'TASK', task: freeTask },
        ],
      });
    if (path.endsWith('/folders')) return json(route, { items: [] });
    if (path.endsWith('/tasks')) return json(route, { items: [placedTask, freeTask] });
    if (path.endsWith(`/tasks/${placedTask.id}`)) return json(route, taskDetail);
    return json(route, { items: [] });
  });
}

async function signIn(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
}

test('the task picker marks tasks that are already on the time point', async ({ page }) => {
  await signIn(page);
  await page.goto('/today');
  await page.getByRole('button', { name: '从目录加入' }).click();

  const dialog = page.getByRole('dialog', { name: '安排任务' });
  await expect(dialog).toBeVisible();

  // The placed task is checked, labelled and cannot be selected again.
  await expect(dialog.locator('.m3e-list-item.is-already-added')).toHaveCount(1);
  await expect(
    dialog.getByRole('listitem', { name: '任务 已安排任务 已加入当前日程' }),
  ).toBeVisible();
  await expect(dialog.getByText('已加入', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '选择任务 已安排任务' })).toHaveCount(0);

  // A task that is not on the day yet is still selectable.
  const selectable = dialog.getByRole('button', { name: '选择任务 可选任务' });
  await expect(selectable).toBeVisible();
  await selectable.click();
  await expect(dialog.getByText('已选择 1 项')).toBeVisible();
});

test('hovering a task row previews its note and steps', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the hover preview is a pointer-only surface');
  await signIn(page);
  await page.goto('/today');

  await page.locator('.task-row').first().hover();
  const preview = page.locator('.task-hover-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('这是任务的备注内容');
  await expect(preview).toContainText('1/2 已完成');
  await expect(preview).toContainText('准备发布说明');
  await expect(preview).toContainText('通知验收人');

  // Moving the pointer off the row dismisses it again.
  await page.mouse.move(4, 4);
  await expect(preview).toHaveCount(0);

  // Picker rows carry the same preview, including rows that are already added.
  await page.getByRole('button', { name: '从目录加入' }).click();
  const dialog = page.getByRole('dialog', { name: '安排任务' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('已安排任务', { exact: true }).hover();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('1/2 已完成');
});
