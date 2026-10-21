import { expect, test, type Page, type Route } from '@playwright/test';

/*
 * These cases run against the production preview. They injected a failed or
 * delayed route chunk in front of the real bundle so the regression cannot be
 * hidden by Vite's dev module graph. They belong to the mocked gate.
 */
test.skip(process.env['E2E_REAL'] === '1', 'drives asset failures through page.route mocks');

const createdAt = '2026-10-21T00:00:00.000Z';
const user = {
  id: '00000000-0000-7000-8000-000000000001',
  username: 'chunk-e2e-user',
  createdAt,
};
const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1,
  defaultCaptureTarget: 'ROOT',
  version: 1,
  updatedAt: createdAt,
};
const task = {
  id: '00000000-0000-7000-8000-000000000721',
  referenceId: 'TASK-721',
  parentFolderId: null,
  title: '整理发布清单',
  status: 'TODO',
  rank: '1024',
  version: 1,
  completedAt: null,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
};
const note = {
  id: '00000000-0000-7000-8000-000000000731',
  taskId: task.id,
  contentMarkdown: '',
  version: 1,
  updatedAt: createdAt,
};
const detail = {
  task,
  note,
  steps: [],
  placements: [],
  workflowMemberships: [],
  folderPath: [],
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSession(page: Page) {
  let authenticated = false;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/refresh'))
      return json(
        route,
        authenticated ? { accessToken: 'chunk-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'chunk-token',
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
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v2', '');
    const method = route.request().method();
    if (path === '/sync/preview') return json(route, { changes: [], complete: false });
    if (path === '/sync/bootstrap')
      return json(route, { code: 'NOT_FOUND', message: 'not found' }, 404);
    if (path === '/sync/status')
      return json(route, { cursor: '0', oldestCursor: '0', protocolVersion: 2 });
    if (path === '/sync/snapshot')
      return json(route, {
        folders: [],
        tasks: [task],
        notes: [note],
        taskSteps: [],
        timePoints: [],
        placements: [],
        workflows: [],
        workflowStages: [],
        workflowTaskMemberships: [],
        settings,
        cursor: '0',
      });
    if (path === '/sync/pull') return json(route, { changes: [], nextCursor: '0', hasMore: false });
    if (path === '/sync/push') return json(route, { protocolVersion: 2, results: [] });
    if (path === '/folders') return json(route, { items: [] });
    if (path === '/tree/children') return json(route, { items: [], nextCursor: null });
    if (path === '/settings') return json(route, settings);
    if (path === '/today') return json(route, { point: null, items: [] });
    if (path === '/time-points/placement-counts') return json(route, { items: [] });
    if (path === '/time-points') return json(route, { items: [] });
    if (path === '/time-points/date' && method === 'POST') {
      const body = route.request().postDataJSON() as { localDate?: string };
      return json(route, {
        id: 'point-1',
        type: 'DATE',
        localDate: body.localDate ?? '2026-10-21',
        title: null,
        rank: '1024',
        version: 1,
        reachedAt: null,
        createdAt,
        updatedAt: createdAt,
      });
    }
    if (path.endsWith('/placements')) return json(route, { items: [] });
    if (path === `/tasks/${task.id}`) return json(route, detail);
    return json(route, {});
  });
}

/** WebKit reports aborted in-flight fetches during a full navigation this way. */
function isNavigationAbort(message: string): boolean {
  return /due to access control checks|The operation was aborted|Load failed/.test(message);
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('a failed tree route chunk keeps the shell and shows the boundary', async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await page.route(/\/assets\/TreePage-[^/]+\.js$/, (route) => route.abort('failed'));
  await mockSession(page);
  await login(page);

  await page.goto('/tree');
  await expect(page.locator('.app-frame')).toBeVisible();
  await expect(page.getByText('页面暂时无法打开', { exact: true })).toBeVisible();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(pageErrors.filter((message) => !isNavigationAbort(message))).toEqual([]);
});

test('task detail opens while the tree chunk is unavailable', async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await page.route(/\/assets\/TreePage-[^/]+\.js$/, (route) => route.abort('failed'));
  await mockSession(page);
  await login(page);

  await page.goto(`/settings?task=${task.id}`);
  await expect(page.locator('.workspace-editor')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(
    task.title,
  );
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(pageErrors.filter((message) => !isNavigationAbort(message))).toEqual([]);
});

test('a slow tree chunk does not hold the authenticated shell blank', async ({ page }) => {
  await page.route(/\/assets\/TreePage-[^/]+\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue();
  });
  await mockSession(page);
  await login(page);

  await page.goto('/tree', { waitUntil: 'domcontentloaded' });
  // The route may still be resolving, but the top bar and navigation are part
  // of the shell and must not wait for the page chunk.
  await expect(page.locator('.app-frame')).toBeVisible({ timeout: 2500 });
  await expect(page.locator('.loading-screen')).toBeVisible({ timeout: 2500 });
});

test('a malformed detail payload shows a retry instead of unmounting the root', async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  await mockSession(page);
  await login(page);

  const unknownTaskId = '00000000-0000-7000-8000-000000000722';
  await page.goto(`/settings?task=${unknownTaskId}`);
  await expect(page.locator('.app-frame')).toBeVisible();
  await expect(page.getByText('任务详情加载失败', { exact: true })).toBeVisible();
  await expect(page.getByText('任务详情格式异常，请重试', { exact: true })).toBeVisible();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(pageErrors.filter((message) => !isNavigationAbort(message))).toEqual([]);
});

test('an invalid calendar date falls back to a renderable day', async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await mockSession(page);
  await login(page);

  await page.goto('/time/calendar/2026-02-31');
  await expect(page.locator('.app-frame')).toBeVisible();
  await expect(page.locator('.calendar-layout')).toBeVisible();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(pageErrors.filter((message) => !isNavigationAbort(message))).toEqual([]);
});
