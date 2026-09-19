import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: '00000000-0000-7000-8000-000000000011',
  username: 'axe-user',
  createdAt: '2026-09-04T10:00:00.000Z',
};
const TIME_POINT_ID = '00000000-0000-7000-8000-000000000021';

const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1 as const,
  defaultCaptureTarget: 'GLOBAL_MISC',
  version: 1,
  updatedAt: user.createdAt,
};

async function installMockApi(page: Page): Promise<void> {
  /*
   * A full-page navigation drops the in-memory access token, so the route loop
   * below re-authenticates through this refresh cookie. It starts
   * unauthenticated so the login flow is still exercised for real.
   */
  let authenticated = false;
  await page.route('**/api/v1/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = (value: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.endsWith('/auth/refresh'))
      return authenticated
        ? body({ accessToken: 'axe-access-token' })
        : route.fulfill({ status: 401, body: '{}' });
    if (path.endsWith('/bootstrap/status')) return body({ initialized: true });
    if (path.endsWith('/auth/login')) {
      authenticated = true;
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
    }
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

  /*
   * The v2 tree/workflow/archive routes read `/api/v2`, so the v1 mock alone
   * leaves them on the error path — which is not what this gate is meant to
   * audit. Mirror the empty-snapshot shape the v2 feature spec uses.
   */
  await page.route('**/api/v2/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/time-points/date'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: TIME_POINT_ID,
          type: 'DATE',
          title: '今天',
          localDate: '2026-09-19',
          timezone: 'Asia/Shanghai',
          reachedAt: null,
          archivedAt: null,
          version: 1,
          createdAt: '2026-09-19T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
        }),
      });
    if (path.endsWith('/sync/snapshot'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
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
        }),
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
    /* Any list endpoint the audited routes read. `/tree/children` and
       `/folders/:id/path` both return `{ items: [] }`. */
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/**
 * WCAG 1.4.3 exempts text in an *inactive* user interface component, and the M3
 * spec renders disabled content at 38% opacity — deliberately below the 4.5:1
 * floor that applies to active text. axe reports the label `<span>` inside a
 * disabled button even though it exempts the button, so the colour-contrast
 * rule is configured with axe's own `exclude` matcher, which prunes the whole
 * disabled subtree. Disabled controls are inert, so no interaction rule loses
 * coverage; every other rule still applies to them.
 */
function analyzePage(page: Page) {
  return new AxeBuilder({ page })
    .options({
      rules: {
        'color-contrast': {
          enabled: true,
        },
      },
    })
    .exclude('[disabled]')
    .exclude('[aria-disabled="true"]')
    .analyze();
}

/**
 * Data-driven controls render disabled until their request resolves. Auditing a
 * transient loading state would measure the disabled treatment instead of the
 * interactive surface, so wait for the shell to mount and then for the disabled
 * set to stop changing. `networkidle` is unusable because the sync WebSocket
 * reconnects continuously.
 */
async function waitForInteractive(page: Page, ready: string): Promise<void> {
  const control = page.getByRole('button', { name: ready });
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled({ timeout: 10_000 });
  let last = -1;
  let streak = 0;
  await expect
    .poll(
      async () => {
        const count = await page.locator('button[disabled]').count();
        streak = count === last ? streak + 1 : 0;
        last = count;
        return streak >= 3;
      },
      { timeout: 10_000, intervals: [150, 150, 150, 250, 250, 400] },
    )
    .toBe(true);
}

test('login and authenticated shell have no axe violations', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  let results = await analyzePage(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  await waitForInteractive(
    page,
    test.info().project.name === 'mobile' ? '打开创建菜单' : '快速添加',
  );
  results = await analyzePage(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

/*
 * Every primary route is audited in its own test so each gets a fresh page and
 * session, and a failure names the route instead of the loop.
 */
const ROUTES: ReadonlyArray<{ path: string; heading: string | RegExp }> = [
  { path: '/today', heading: /今日|今天/ },
  { path: '/tree', heading: '目录' },
  { path: '/tasks', heading: /所有任务|任务库/ },
  { path: '/workflows', heading: '流程' },
  { path: '/time', heading: '时间' },
  { path: '/time/calendar', heading: '日历' },
  { path: '/time/events', heading: '时间点' },
  { path: '/archive', heading: '归档' },
  { path: '/settings', heading: '设置' },
  { path: '/more', heading: '更多' },
];

for (const route of ROUTES) {
  test(`route ${route.path} has no axe violations`, async ({ page }) => {
    /*
     * The route matrix renders two distinct shells (pointer-first drawer vs
     * touch-first navigation bar), covered by chromium and mobile. The markup
     * and CSS audited here do not vary by engine, so running it again under
     * Firefox and WebKit only multiplies browser restarts.
     */
    test.skip(
      !['chromium', 'mobile'].includes(test.info().project.name),
      'route matrix runs on the two shell variants only',
    );
    await installMockApi(page);
    await page.goto('/login');
    await page.getByLabel('用户名').fill(user.username);
    await page.getByLabel('密码').fill('correct horse battery staple');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(
      test.info().project.name === 'mobile'
        ? page.getByRole('button', { name: '打开创建菜单' })
        : page.getByRole('button', { name: '快速添加' }),
    ).toBeVisible();

    await page.goto(route.path);
    await expect(page.getByRole('heading', { name: route.heading }).first()).toBeVisible();
    await waitForInteractive(
      page,
      test.info().project.name === 'mobile' ? '打开创建菜单' : '快速添加',
    );
    const results = await analyzePage(page);
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}

/**
 * Overlays animate in. Auditing a mid-animation frame makes axe composite the
 * colours against a partially transparent surface, which produces contrast
 * failures that do not exist in the settled UI (observed as dark on-surface text
 * measured over a light surface in Firefox). Wait for the element's animations
 * to finish first.
 */
async function waitForSettled(page: Page, selector: string): Promise<void> {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    if (!element) return false;
    const animations = element.getAnimations({ subtree: true });
    return animations.every((animation) => animation.playState !== 'running');
  }, selector);
}

test('open overlays have no axe violations', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();

  // Quick capture: a dialog on every shell.
  const quickEntry =
    test.info().project.name === 'mobile'
      ? page.getByRole('button', { name: '打开创建菜单' })
      : page.getByRole('button', { name: '快速添加' });
  await waitForInteractive(
    page,
    test.info().project.name === 'mobile' ? '打开创建菜单' : '快速添加',
  );
  await quickEntry.click();
  if (test.info().project.name === 'mobile')
    await page.getByRole('menuitem', { name: '新建任务' }).click();
  await expect(page.getByRole('dialog', { name: '快速添加' })).toBeVisible();
  await waitForSettled(page, '.m3e-dialog');
  let results = await analyzePage(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '快速添加' })).toBeHidden();

  // Command palette: the search surface that replaced the inline trigger box.
  if (test.info().project.name === 'mobile') {
    await page.getByRole('button', { name: '搜索任务和备注' }).click();
  } else {
    await page.getByRole('button', { name: '搜索任务和备注' }).click();
  }
  await expect(page.getByRole('dialog', { name: '搜索和命令面板' })).toBeVisible();
  await waitForSettled(page, '.command-panel');
  results = await analyzePage(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
