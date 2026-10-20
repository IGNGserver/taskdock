import { expect, test, type Page, type Route } from '@playwright/test';
import { missingProgressiveRoute } from './legacy-hub-fixture.js';

/*
 * Status grouping, the reach toggle and the placement-menu stacking contract
 * are client-side behaviours driven through `page.route` fixtures. The real
 * gate has its own coverage, so this suite only runs in the mocked gate.
 */
test.skip(process.env['E2E_REAL'] === '1', 'drives grouping through page.route mocks');

const user = {
  id: '00000000-0000-7000-8000-000000000601',
  username: 'events-status-user',
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

const event = {
  id: '00000000-0000-7000-8000-000000000611',
  type: 'EVENT',
  localDate: null,
  title: '发布窗口',
  rank: '1024',
  version: 3,
  reachedAt: null as string | null,
  createdAt: user.createdAt,
  updatedAt: user.createdAt,
};

function taskFixture(
  id: string,
  title: string,
  status: 'TODO' | 'IN_PROGRESS' | 'DONE',
  rank: string,
) {
  return {
    id,
    referenceId: `TASK-${rank}`,
    parentFolderId: null,
    title,
    status,
    rank,
    version: 1,
    completedAt: null,
    deletedAt: null,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };
}

const progressTask = taskFixture(
  '00000000-0000-7000-8000-000000000621',
  '进行中的任务',
  'IN_PROGRESS',
  '1024',
);
const todoFirstTask = taskFixture(
  '00000000-0000-7000-8000-000000000622',
  '待开始一',
  'TODO',
  '2048',
);
const todoSecondTask = taskFixture(
  '00000000-0000-7000-8000-000000000623',
  '待开始二',
  'TODO',
  '3072',
);
const doneTask = taskFixture(
  '00000000-0000-7000-8000-000000000624',
  '已完成的任务',
  'DONE',
  '4096',
);

function placementFixture(
  id: string,
  timePointId: string,
  task: ReturnType<typeof taskFixture>,
  rank: string,
) {
  return {
    id,
    ownerId: user.id,
    taskId: task.id,
    timePointId,
    rank,
    version: 1,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    task,
  };
}

/** Deliberately unsorted by status: grouping, not the fixture order, must hold. */
const eventPlacements = [
  placementFixture('00000000-0000-7000-8000-000000000631', event.id, todoFirstTask, '1024'),
  placementFixture('00000000-0000-7000-8000-000000000632', event.id, doneTask, '2048'),
  placementFixture('00000000-0000-7000-8000-000000000633', event.id, todoSecondTask, '3072'),
  placementFixture('00000000-0000-7000-8000-000000000634', event.id, progressTask, '4096'),
];

const dayPoint = {
  id: '00000000-0000-7000-8000-000000000641',
  type: 'DATE',
  localDate: '2026-09-19',
  title: null,
  rank: '1024',
  version: 1,
  reachedAt: null,
  createdAt: user.createdAt,
  updatedAt: user.createdAt,
};

const dayPlacements = [
  placementFixture('00000000-0000-7000-8000-000000000651', dayPoint.id, doneTask, '1024'),
  placementFixture('00000000-0000-7000-8000-000000000652', dayPoint.id, progressTask, '2048'),
  placementFixture('00000000-0000-7000-8000-000000000653', dayPoint.id, todoFirstTask, '3072'),
];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSession(page: Page, handleV2: (route: Route, path: string) => Promise<void>) {
  let authenticated = false;

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/refresh'))
      return json(
        route,
        authenticated ? { accessToken: 'events-status-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'events-status-token',
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
    if (await missingProgressiveRoute(route, path)) return;
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
    if (path.endsWith('/sync/pull'))
      return json(route, { changes: [], nextCursor: '0', hasMore: false });
    if (path.endsWith('/sync/push')) return json(route, { protocolVersion: 2, results: [] });
    await handleV2(route, path);
  });

  return {
    async login() {
      await page.goto('/login');
      await page.getByLabel('用户名').fill(user.username);
      await page.getByLabel('密码').fill('correct horse battery staple');
      await page.getByRole('button', { name: '登录' }).click();
      await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
    },
  };
}

test('event placements group by task status and keep completed collapsed', async ({ page }) => {
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith(`/time-points/${event.id}/placements`))
      return json(route, { items: eventPlacements });
    if (path.endsWith(`/time-points/${event.id}`)) return json(route, event);
    return json(route, { items: [] });
  });

  await session.login();
  await page.goto(`/time/events/${event.id}`);

  const headings = page.locator('.placement-group-heading__label');
  await expect(headings).toHaveCount(3);
  await expect(headings.nth(0)).toContainText('进行中');
  await expect(headings.nth(1)).toContainText('待开始');
  await expect(headings.nth(2)).toContainText('已完成');

  // Groups render 进行中 → 待开始 → 已完成, and each group keeps rank order.
  const titles = page.locator('.task-row .task-title');
  await expect(titles).toHaveText(['进行中的任务', '待开始一', '待开始二']);
  await expect(page.getByText('已完成的任务')).toHaveCount(0);

  await page.getByRole('button', { name: '展开' }).click();
  await expect(titles).toHaveText(['进行中的任务', '待开始一', '待开始二', '已完成的任务']);
  await page.getByRole('button', { name: '收起' }).click();
  await expect(page.getByText('已完成的任务')).toHaveCount(0);
});

test('calendar day panel groups placements by task status too', async ({ page }) => {
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith('/time-points/date')) return json(route, dayPoint);
    if (path.endsWith(`/time-points/${dayPoint.id}/placements`))
      return json(route, { items: dayPlacements });
    if (path.endsWith('/time-points/placement-counts')) return json(route, { items: [] });
    return json(route, { items: [] });
  });

  await session.login();
  await page.goto('/time/calendar/2026-09-19');

  const headings = page.locator('.m3e-card--calendar-detail .placement-group-heading__label');
  await expect(headings).toHaveCount(3);
  await expect(headings.nth(0)).toContainText('进行中');
  await expect(headings.nth(1)).toContainText('待开始');
  await expect(headings.nth(2)).toContainText('已完成');

  const titles = page.locator('.m3e-card--calendar-detail .task-row .task-title');
  await expect(titles).toHaveText(['进行中的任务', '待开始一']);
});

test('撤销到达 clears the reached state and restores the reach action', async ({ page }) => {
  let reachedAt: string | null = '2026-10-01T02:00:00.000Z';
  let version = event.version;
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith(`/time-points/${event.id}/unreach`)) {
      expect(route.request().method()).toBe('POST');
      const body = route.request().postDataJSON() as { baseVersion: number };
      expect(body.baseVersion).toBe(version);
      reachedAt = null;
      version += 1;
      return json(route, { ...event, reachedAt, version });
    }
    if (path.endsWith(`/time-points/${event.id}/placements`)) return json(route, { items: [] });
    if (path.endsWith(`/time-points/${event.id}`))
      return json(route, { ...event, reachedAt, version });
    return json(route, { items: [] });
  });

  await session.login();
  await page.goto(`/time/events/${event.id}`);

  await expect(page.getByRole('button', { name: '撤销到达' })).toBeVisible();
  await page.getByRole('button', { name: '撤销到达' }).click();

  await expect(page.getByRole('button', { name: '标记已到达' })).toBeVisible();
  await expect(page.getByText('等待中')).toBeVisible();
});

test('toggling a status keeps the row in place until the page is entered again', async ({
  page,
}) => {
  const statusById = new Map<string, 'TODO' | 'IN_PROGRESS' | 'DONE'>([
    [todoFirstTask.id, 'TODO'],
    [todoSecondTask.id, 'TODO'],
    [doneTask.id, 'DONE'],
  ]);
  const rows = [
    { id: '00000000-0000-7000-8000-000000000661', task: todoFirstTask, rank: '1024' },
    { id: '00000000-0000-7000-8000-000000000662', task: todoSecondTask, rank: '2048' },
    { id: '00000000-0000-7000-8000-000000000663', task: doneTask, rank: '3072' },
  ];
  const items = () =>
    rows.map((row) => ({
      ...placementFixture(row.id, event.id, row.task, row.rank),
      task: { ...row.task, status: statusById.get(row.task.id)! },
    }));
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith(`/tasks/${todoSecondTask.id}`)) {
      const body = route.request().postDataJSON() as { status: string };
      expect(body.status).toBe('IN_PROGRESS');
      statusById.set(todoSecondTask.id, 'IN_PROGRESS');
      return json(route, { ...todoSecondTask, status: 'IN_PROGRESS', version: 2 });
    }
    if (path.endsWith(`/time-points/${event.id}/placements`))
      return json(route, { items: items() });
    if (path.endsWith(`/time-points/${event.id}`)) return json(route, event);
    if (path.endsWith('/time-points/placement-counts')) return json(route, { items: [] });
    if (path.endsWith('/time-points')) return json(route, { items: [event] });
    return json(route, { items: [] });
  });

  await session.login();
  await page.goto('/time/events');
  await page.getByRole('link', { name: /发布窗口/ }).click();

  const titles = page.locator('.task-row .task-title');
  await expect(titles).toHaveText(['待开始一', '待开始二']);

  // Toggling to 进行中 updates the row in place: it keeps its slot and group…
  const secondRow = page.locator('.task-row', { hasText: '待开始二' });
  await secondRow.getByRole('button', { name: '标记为进行中' }).click();
  await expect(secondRow.locator('.m3e-task-status-control__label')).toHaveText('进行中');
  await expect(titles).toHaveText(['待开始一', '待开始二']);
  await expect(page.locator('.placement-group-heading__label')).toHaveCount(2);

  // …and only re-sorts after the page is left and entered again.
  await page.goBack();
  await page.getByRole('link', { name: /发布窗口/ }).click();
  await expect(page.locator('.placement-group-heading__label').nth(0)).toContainText('进行中');
  await expect(titles).toHaveText(['待开始二', '待开始一']);
});

test('an open row menu is never painted under the following task rows', async ({ page }) => {
  const session = await mockSession(page, async (route, path) => {
    if (path.endsWith(`/time-points/${event.id}/placements`))
      return json(route, { items: eventPlacements });
    if (path.endsWith(`/time-points/${event.id}`)) return json(route, event);
    return json(route, { items: [] });
  });

  await session.login();
  await page.goto(`/time/events/${event.id}`);
  await page.getByRole('button', { name: '安排操作' }).first().click();
  await expect(page.locator('.m3e-menu')).toBeVisible();

  /*
   * The regression: on the touch shell the menu was clipped by the row's
   * overflow and the following rows were painted (and hit-tested) above it.
   * Probing the menu's visible band must always resolve inside the menu, on
   * the desktop layout and the swipe-shell layout alike. The band stops at
   * the viewport and the fixed bottom navigation — the menu opening past the
   * fold is the existing overlay behaviour, not this contract.
   */
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const menu = document.querySelector('.m3e-menu');
        if (!menu) return 'missing';
        const rect = menu.getBoundingClientRect();
        const nav = document.querySelector('.m3e-navigation-bar--mobile-shell');
        const navTop = nav ? nav.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
        const x = rect.left + rect.width / 2;
        const low = rect.top + 6;
        const high = Math.min(rect.bottom - 6, window.innerHeight - 4, navTop - 4);
        if (!(high > low)) return 'no-visible-band';
        const points = [low, (low + high) / 2, high];
        return points
          .map((y) => {
            const hit = document.elementFromPoint(x, Math.max(y, 4));
            if (!hit) return 'none';
            return menu.contains(hit) ? 'menu' : String(hit.className || hit.tagName);
          })
          .join(',');
      }),
    )
    .toBe('menu,menu,menu');
});
