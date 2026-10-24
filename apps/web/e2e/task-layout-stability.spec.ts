import { expect, test, type Page, type Route } from '@playwright/test';
import { missingProgressiveRoute } from './legacy-hub-fixture.js';

// Deliberately independent of E2E_REAL: neither gate may contact a real account.
test.use({ serviceWorkers: 'block' });

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, '0')}`;
const createdAt = '2026-10-01T00:00:00.000Z';
const stamp = { version: 1, createdAt, updatedAt: createdAt };
const user = { id: id(9000), username: 'layout-fixture', createdAt };
const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1,
  defaultCaptureTarget: 'ROOT',
  version: 1,
  updatedAt: createdAt,
};
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: settings.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(page: Page) {
  const tasks = Array.from({ length: 32 }, (_, index) => ({
    ...stamp,
    id: id(9100 + index),
    referenceId: `TASK-${index + 1}`,
    parentFolderId: null,
    deletedAt: null,
    title: `稳定任务 ${String(index + 1).padStart(2, '0')} · 核对发布清单与跨设备同步的长标题，不能因重新验证而移动`,
    status: index % 7 === 6 ? 'DONE' : index % 3 === 1 ? 'IN_PROGRESS' : 'TODO',
    rank: String(2 ** (index % 20) + Math.floor(index / 20) * 2_000_000),
    completedAt: index % 7 === 6 ? createdAt : null,
  }));
  const notes = tasks.map((task, index) => ({
    id: id(9200 + index),
    taskId: task.id,
    contentMarkdown: '缓存中的初始备注',
    version: 1,
    updatedAt: createdAt,
  }));
  const day = {
    ...stamp,
    id: id(9300),
    type: 'DATE',
    title: null,
    localDate,
    timezone: settings.timezone,
    reachedAt: null,
    rank: '2',
  };
  const events = Array.from({ length: 24 }, (_, index) => ({
    ...stamp,
    id: id(9310 + index),
    type: 'EVENT',
    localDate: null,
    title: `稳定事件 ${index + 1} · 发布窗口与验收安排`,
    reachedAt: null,
    rank: String(2 ** index),
  }));
  // Membership order intentionally differs from task order, with different digit lengths.
  const placements = [day, events[0]!].flatMap((point, pointIndex) =>
    tasks
      .slice(0, 24)
      .reverse()
      .map((task, index) => ({
        ...stamp,
        id: id(9400 + pointIndex * 100 + index),
        ownerId: user.id,
        taskId: task.id,
        timePointId: point.id,
        rank: String(2 ** index),
      })),
  );
  const workflow = { ...stamp, id: id(9700), name: '稳定流程', rank: '2' };
  const stage = { ...stamp, id: id(9701), workflowId: workflow.id, name: '验收', rank: '2' };
  const members = tasks
    .slice(4, 28)
    .reverse()
    .map((task, index) => ({
      ...stamp,
      id: id(9800 + index),
      workflowId: workflow.id,
      stageId: stage.id,
      taskId: task.id,
      rank: String(2 ** index),
    }));
  const state = {
    gate: Promise.resolve(),
    requests: 0,
    searches: 0,
    details: 0,
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  let authenticated = false;
  const session = {
    accessToken: 'layout-fixture-token',
    user,
    settings,
    capabilities: { syncProtocolVersion: 2, websocket: false, offline: true },
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, session);
    }
    if (path.endsWith('/auth/refresh'))
      return json(route, authenticated ? session : {}, authenticated ? 200 : 401);
    if (path.endsWith('/me')) return json(route, session);
    return json(route, { items: [] });
  });
  await page.route('**/api/v2/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v2', '');
    if (await missingProgressiveRoute(route, path)) return;
    if (path === '/sync/snapshot')
      return json(route, {
        folders: [],
        tasks,
        notes,
        taskSteps: [],
        timePoints: [day, ...events],
        placements,
        workflows: [workflow],
        workflowStages: [stage],
        workflowTaskMemberships: members,
        settings,
        cursor: '0',
      });
    if (path === '/sync/pull') return json(route, { changes: [], nextCursor: '0', hasMore: false });
    if (path === '/sync/push') return json(route, { protocolVersion: 2, results: [] });
    const task = tasks.find((item) => path === `/tasks/${item.id}`);
    if (task) {
      state.details += 1;
      return json(route, {
        task,
        note: notes.find((note) => note.taskId === task.id),
        steps: [],
        placements: placements.filter((item) => item.taskId === task.id),
        workflowMemberships: members
          .filter((item) => item.taskId === task.id)
          .map((item) => ({
            ...item,
            workflow: { id: workflow.id, name: workflow.name },
            stage: { id: stage.id, name: stage.name },
          })),
        folderPath: [],
      });
    }
    state.requests += 1;
    if (path === '/tasks') state.searches += 1;
    await state.gate;
    if (path === '/tasks') return json(route, { items: tasks, nextCursor: null });
    if (path === '/tree/children')
      return json(route, {
        items: tasks.map((item) => ({ kind: 'TASK', task: item })),
        parentFolderId: null,
        nextCursor: null,
      });
    if (path === '/folders') return json(route, { items: [] });
    if (path === '/workflows')
      return json(route, {
        items: [
          {
            ...workflow,
            stages: [
              {
                ...stage,
                memberships: members,
                hiddenTaskCount: 0,
                tasks: members.map((item) =>
                  tasks.find((candidate) => candidate.id === item.taskId),
                ),
              },
            ],
          },
        ],
      });
    if (path === '/time-points/placement-counts') return json(route, { items: [] });
    if (path === '/time-points/date') return json(route, day);
    if (path === '/time-points')
      return json(route, { items: url.searchParams.get('type') === 'EVENT' ? events : [day] });
    const pointId = path.split('/')[2];
    if (path.endsWith('/placements'))
      return json(route, {
        items: placements
          .filter((item) => item.timePointId === pointId)
          .map((item) => ({
            ...item,
            task: tasks.find((candidate) => candidate.id === item.taskId),
          })),
      });
    if (path.startsWith('/time-points/'))
      return json(
        route,
        [day, ...events].find((point) => point.id === pointId),
      );
    return json(route, { items: [] });
  });
  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('layout-fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '搜索任务和备注' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  return { state, tasks, notes, events };
}

async function frames(page: Page, count = 12) {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

type ProbeResult = { samples: number; detached: boolean; reordered: boolean; drift: number };
declare global {
  interface Window {
    layoutProbe: { stop: () => ProbeResult };
  }
}

/** Sample every DOM mutation AND frame, not just the final settled screenshot. */
async function observeRows(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (!rows.length) throw new Error(`No rows to observe: ${selector}`);
    const measure = (row: HTMLElement) => {
      const rect = row.getBoundingClientRect();
      let y = rect.top;
      // Include every scrolling ancestor, including the document and dialog body.
      for (let parent = row.parentElement; parent; parent = parent.parentElement)
        y += parent.scrollTop;
      return { y, height: rect.height };
    };
    const baseline = rows.map(measure);
    const result: ProbeResult = { samples: 0, detached: false, reordered: false, drift: 0 };
    let running = true;
    let frame = 0;
    const sample = () => {
      result.samples += 1;
      const current = Array.from(document.querySelectorAll(selector));
      result.reordered ||=
        current.length !== rows.length || current.some((row, i) => row !== rows[i]);
      rows.forEach((row, index) => {
        result.detached ||= !row.isConnected;
        if (!row.isConnected) return;
        const value = measure(row);
        result.drift = Math.max(
          result.drift,
          Math.abs(value.y - baseline[index]!.y),
          Math.abs(value.height - baseline[index]!.height),
        );
      });
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const tick = () => {
      if (!running) return;
      sample();
      frame = requestAnimationFrame(tick);
    };
    tick();
    window.layoutProbe = {
      stop: () => {
        sample();
        running = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        return result;
      },
    };
  }, selector);
}

async function expectStable(page: Page) {
  const result = await page.evaluate(() => window.layoutProbe.stop());
  expect(result.samples).toBeGreaterThan(5);
  expect(result.detached, 'original rows must remain connected').toBe(false);
  expect(result.reordered, 'original DOM nodes must remain in the same slots').toBe(false);
  expect(result.drift, 'maximum transient content y / height drift').toBeLessThanOrEqual(1);
}

async function change(page: Page, taskDetailId?: string) {
  await page.evaluate(
    (taskDetailId) =>
      window.dispatchEvent(
        taskDetailId
          ? new CustomEvent('devtodo:data-changed', { detail: { taskDetailId } })
          : new Event('devtodo:data-changed'),
      ),
    taskDetailId,
  );
}

const surfaces = [
  { name: 'today', path: '/today', rows: '.today-task-pane .task-row' },
  { name: 'tree', path: '/tree', rows: '.tree-page [id^="task-"]' },
  { name: 'event index', path: '/time/events', rows: '.timeline-item-shell' },
  { name: 'event detail', path: `/time/events/${id(9310)}`, rows: '.task-row' },
  {
    name: 'calendar',
    path: `/time/calendar/${localDate}`,
    rows: '.m3e-card--calendar-detail .task-row',
  },
  { name: 'workflows', path: '/workflows', rows: '.m3e-list-item--workflow-task' },
];

for (const surface of surfaces) {
  test(`${surface.name}: repeated refresh and scrolling preserve every row`, async ({ page }) => {
    const { state, tasks } = await fixture(page);
    await page.goto(surface.path);
    await expect(page.locator(surface.rows).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await frames(page, 30); // Allow only initial route/entry animations to finish.
    expect(await page.locator(surface.rows).count()).toBeGreaterThan(15);
    await observeRows(page, surface.rows);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const gate = deferred();
      state.gate = gate.promise;
      const before = state.requests;
      try {
        await change(page);
        await expect.poll(() => state.requests).toBeGreaterThan(before);
        await frames(page);
      } finally {
        gate.release();
        state.gate = Promise.resolve();
      }
      await page.waitForLoadState('networkidle');
      await frames(page);
    }
    const beforeScoped = state.requests;
    await change(page, tasks[0]!.id);
    await frames(page, 30);
    expect(state.requests, 'note-only events must not reload list consumers').toBe(beforeScoped);
    await page.locator(surface.rows).last().scrollIntoViewIfNeeded();
    await frames(page);
    await expectStable(page);
  });
}

for (const surface of surfaces.filter((item) =>
  ['today', 'event detail', 'calendar'].includes(item.name),
)) {
  test(`${surface.name}: a pressed title does not shrink or move its hit target`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'mouse press/hover contract; touch scrolling is covered above');
    await fixture(page);
    await page.goto(surface.path);
    const row = page.locator(surface.rows).first();
    const title = row.getByRole('button', { name: /^打开任务 / });
    await expect(title).toBeVisible();
    await page.waitForLoadState('networkidle');
    await frames(page, 30);
    const before = await title.boundingBox();
    expect(before).not.toBeNull();
    await observeRows(page, surface.rows);
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    try {
      await frames(page);
      const pressed = await title.boundingBox();
      expect(pressed).not.toBeNull();
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(pressed![key] - before![key]), `pressed title ${key}`).toBeLessThanOrEqual(
          1,
        );
    } finally {
      // Release off the title: a successful click intentionally opens/reflows the editor.
      await page.mouse.move(4, 4);
      await page.mouse.up();
    }
    await frames(page);
    await expectStable(page);
    await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveCount(0);
  });
}

test('hover revalidates a changed note without refreshing its list; detail still receives scoped changes', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'hover preview is pointer-only');
  const { state, tasks, notes } = await fixture(page);
  await page.goto('/today');
  const title = page.getByRole('button', { name: `打开任务 ${tasks[0]!.title}`, exact: true });
  await title.scrollIntoViewIfNeeded();
  await page.waitForLoadState('networkidle');
  await frames(page, 30);
  const before = state.requests;
  notes[0]!.contentMarkdown = '服务器刚更新的备注，不应触发整张列表重新加载';
  notes[0]!.version = 2;
  await observeRows(page, surfaces[0]!.rows);
  await title.hover();
  await expect.poll(() => state.details).toBeGreaterThan(0);
  await expect(page.locator('.task-hover-preview')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await frames(page, 30);
  expect(state.requests, 'real detail response changed only the note').toBe(before);
  await expectStable(page);
  await title.click();
  await page.mouse.move(4, 4);
  const note = page.getByRole('textbox', { name: '任务备注', exact: true });
  await expect(note).toHaveValue(notes[0]!.contentMarkdown);
  await page.waitForLoadState('networkidle');
  notes[0]!.contentMarkdown = '第二次服务器备注更新';
  notes[0]!.version = 3;
  const beforeDetail = state.details;
  const beforeList = state.requests;
  // A detail-scoped notification means the cache was already updated. Drive
  // that real revalidation path, rather than announcing an unreceived edit.
  await page.clock.setFixedTime(new Date(Date.now() + 31_000));
  await title.hover();
  await expect.poll(() => state.details).toBeGreaterThan(beforeDetail);
  await expect(note).toHaveValue(notes[0]!.contentMarkdown);
  await page.waitForLoadState('networkidle');
  expect(state.requests).toBe(beforeList);
});

test('picker retains mounted search results, selection and scroll while held revalidation refreshes actual data', async ({
  page,
}) => {
  const { state, tasks } = await fixture(page);
  await page.goto('/today');
  await page.getByRole('button', { name: '从目录加入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安排任务' });
  const query = dialog.getByRole('searchbox', { name: '搜索任务或目录' });
  await query.fill('稳定任务');
  const results = '[aria-label="任务搜索结果"] .m3e-list-item--picker';
  await expect(page.locator(results)).toHaveCount(
    tasks.filter((task) => task.status !== 'DONE').length,
  );
  const free = tasks[24]!;
  await dialog.getByRole('button', { name: `选择任务 ${free.title}`, exact: true }).click();
  await expect(dialog.getByText('已选择 1 项', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await frames(page, 30);
  // The dialog body, not task-picker-scroll, owns scrolling. Remember that actual ancestor.
  const selected = dialog.getByRole('button', { name: `取消选择任务 ${free.title}`, exact: true });
  const scroll = await selected.evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (
        parent.scrollHeight > parent.clientHeight &&
        /auto|scroll/.test(getComputedStyle(parent).overflowY)
      ) {
        parent.setAttribute('data-layout-scroll', 'picker');
        return parent.scrollTop;
      }
    }
    throw new Error('Expected a scrollable picker body');
  });
  expect(scroll).toBeGreaterThan(0);
  await observeRows(page, results);
  const gate = deferred();
  state.gate = gate.promise;
  const before = state.searches;
  const refreshed = tasks[25]!;
  // Same-length text: prove freshness without introducing a legitimate wrapping reflow.
  refreshed.title = refreshed.title.replace('核对发布清单', '刷新发布清单');
  refreshed.version += 1;
  try {
    await change(page);
    await expect.poll(() => state.searches).toBeGreaterThan(before);
    await frames(page, 30);
    await expect(query).toHaveValue('稳定任务');
    await expect(selected).toHaveCount(1);
    await expect(dialog.getByText('已选择 1 项', { exact: true })).toBeVisible();
    expect(
      await page.locator('[data-layout-scroll="picker"]').evaluate((element) => element.scrollTop),
    ).toBe(scroll);
  } finally {
    gate.release();
    state.gate = Promise.resolve();
  }
  await expect(dialog.getByText(refreshed.title, { exact: true })).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  await frames(page);
  await expect(selected).toHaveCount(1);
  expect(
    Math.abs(
      (await page
        .locator('[data-layout-scroll="picker"]')
        .evaluate((element) => element.scrollTop)) - scroll,
    ),
  ).toBeLessThanOrEqual(1);
  await expectStable(page);
});

test('desktop sidebar may reflow once on opening, but switching tasks preserves the list', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'compact task detail intentionally replaces the workspace');
  await page.setViewportSize({ width: 1440, height: 900 });
  const { tasks } = await fixture(page);
  await page.goto('/tree');
  const open = (index: number) =>
    page.getByRole('button', { name: `打开任务 ${tasks[index]!.title}`, exact: true });
  await open(0).click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(
    tasks[0]!.title,
  );
  await page.waitForLoadState('networkidle');
  await frames(page, 30); // Establish baseline only after the legitimate sidebar reflow.
  await observeRows(page, surfaces[1]!.rows);
  for (const index of [1, 2, 0]) {
    await open(index).click();
    await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(
      tasks[index]!.title,
    );
    await page.waitForLoadState('networkidle');
    await frames(page);
  }
  await expectStable(page);
});
