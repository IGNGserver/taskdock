import type {
  FolderDto,
  NoteDto,
  TaskDetailV2Dto,
  TaskStepDto,
  TreeTaskDto,
} from '@devtodo/contracts';
import { expect, test, type Page, type Route } from '@playwright/test';

// These cases exercise deliberately delayed and rejected API requests.
test.skip(
  process.env['E2E_REAL'] === '1',
  'failure and concurrency cases use a mutable API fixture',
);

async function workspace(page: Page) {
  const createdAt = '2026-10-02T10:00:00.000Z';
  const user = {
    id: '00000000-0000-7000-8000-000000000701',
    username: 'workspace-owner',
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
  const folder = (
    suffix: number,
    title: string,
    parentFolderId: string | null = null,
  ): FolderDto => ({
    id: `00000000-0000-7000-8000-${suffix.toString().padStart(12, '0')}`,
    title,
    parentFolderId,
    rank: String(suffix),
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const work = folder(711, '工作');
  const personal = folder(712, '个人');
  const folders = [
    work,
    personal,
    folder(713, '发布', work.id),
    folder(714, '发布', personal.id),
    folder(715, '文档', '00000000-0000-7000-8000-000000000713'),
  ];
  const task = (suffix: number, title: string): TreeTaskDto => ({
    id: `00000000-0000-7000-8000-${suffix.toString().padStart(12, '0')}`,
    referenceId: `TASK-${suffix}`,
    title,
    parentFolderId: null,
    status: 'TODO',
    rank: String(suffix),
    version: 1,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  const tasks = [task(721, '整理发布清单'), task(722, '核对文档')];
  const notes = new Map<string, NoteDto>(
    tasks.map((item, index) => [
      item.id,
      {
        id: `00000000-0000-7000-8000-${(731 + index).toString().padStart(12, '0')}`,
        taskId: item.id,
        contentMarkdown: '',
        version: 1,
        updatedAt: createdAt,
      },
    ]),
  );
  const steps = new Map<string, TaskStepDto[]>();
  const state = {
    stepRequests: 0,
    rejectStep: false,
    titleRequests: 0,
    captureRequests: 0,
    rejectTitle: false,
    rejectMove: false,
    rejectDelete: false,
    rejectSearch: false,
    titleGate: Promise.resolve(),
    captureGate: Promise.resolve(),
    patches: [] as Array<{ id: string; baseVersion: number; title?: string; status?: string }>,
    deletes: [] as string[],
  };
  let authenticated = false;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const rejected = (route: Route, message: string) =>
    json(route, { code: 'MUTATION_REJECTED', message }, 409);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap/status')) return json(route, { initialized: true });
    if (path.endsWith('/auth/refresh'))
      return json(
        route,
        authenticated ? { accessToken: 'workspace-token' } : {},
        authenticated ? 200 : 401,
      );
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, {
        accessToken: 'workspace-token',
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
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v2', '');
    const method = request.method();
    if (path === '/sync/snapshot')
      return json(route, {
        folders,
        tasks,
        notes: [...notes.values()],
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
    if (path === '/folders') return json(route, { items: folders });
    if (path.endsWith('/path')) {
      const current = folders.find((item) => item.id === path.split('/')[2]);
      const crumbs: FolderDto[] = [];
      let parent = current;
      while (parent) {
        crumbs.unshift(parent);
        parent = folders.find((item) => item.id === parent!.parentFolderId);
      }
      return json(route, { items: crumbs.map(({ id, title }) => ({ id, title })) });
    }
    if (path === '/tree/children') {
      const parent = url.searchParams.get('parentFolderId');
      return json(route, {
        items: [
          ...folders
            .filter((item) => (item.parentFolderId ?? 'root') === parent)
            .map((item) => ({
              kind: 'FOLDER',
              folder: item,
              aggregate: {
                status: 'TODO',
                todoCount: 0,
                inProgressCount: 0,
                doneCount: 0,
                totalCount: 0,
              },
            })),
          ...[...tasks]
            .sort((left, right) => Number(BigInt(left.rank) - BigInt(right.rank)))
            .filter((item) => !item.deletedAt && (item.parentFolderId ?? 'root') === parent)
            .map((item) => ({ kind: 'TASK', task: item })),
        ],
      });
    }
    if (path === '/tasks' && method === 'POST') {
      state.captureRequests += 1;
      const body = request.postDataJSON() as { title: string; parentFolderId: string | null };
      await state.captureGate;
      const item = {
        ...task(740 + state.captureRequests, body.title),
        parentFolderId: body.parentFolderId,
      };
      tasks.push(item);
      const note = {
        id: `note-${item.id}`,
        taskId: item.id,
        contentMarkdown: '',
        version: 1,
        updatedAt: createdAt,
      };
      notes.set(item.id, note);
      return json(route, { task: item, note }, 201);
    }
    if (path === '/tasks') {
      if (state.rejectSearch) return rejected(route, '搜索暂时不可用');
      const q = url.searchParams.get('q') ?? '';
      return json(route, {
        items: tasks.filter(
          (item) => !item.deletedAt && `${item.title} ${item.referenceId}`.includes(q),
        ),
      });
    }
    if (path === '/tree/items/move') {
      const body = request.postDataJSON() as {
        item: { kind: string; id: string };
        parentFolderId: string | null;
        baseVersion: number;
        before?: { id: string };
        after?: { id: string };
      };
      const item =
        body.item.kind === 'TASK'
          ? tasks.find((candidate) => candidate.id === body.item.id)!
          : folders.find((candidate) => candidate.id === body.item.id)!;
      if (state.rejectMove && item.id === tasks[1]!.id) {
        state.rejectMove = false;
        return rejected(route, '这项任务暂时无法移动');
      }
      if (body.baseVersion !== item.version) return rejected(route, '版本已变化');
      item.parentFolderId = body.parentFolderId;
      const anchor = [...tasks, ...folders].find(
        (candidate) => candidate.id === (body.before?.id ?? body.after?.id),
      );
      if (anchor) item.rank = String(BigInt(anchor.rank) + (body.after ? 1n : -1n));
      item.version += 1;
      return json(
        route,
        body.item.kind === 'TASK'
          ? { kind: 'TASK', task: item }
          : {
              kind: 'FOLDER',
              folder: item,
              aggregate: {
                status: 'TODO',
                todoCount: 0,
                inProgressCount: 0,
                doneCount: 0,
                totalCount: 0,
              },
            },
      );
    }
    const taskId = path.split('/')[2];
    const item = tasks.find((candidate) => candidate.id === taskId);
    if (item && path.endsWith('/steps') && method === 'POST') {
      state.stepRequests += 1;
      if (state.rejectStep) {
        state.rejectStep = false;
        return rejected(route, '步骤暂时无法保存');
      }
      const body = request.postDataJSON() as { title: string; noteMarkdown: string };
      const step: TaskStepDto = {
        id: `step-${state.stepRequests}`,
        taskId: item.id,
        ...body,
        status: 'TODO',
        rank: String(state.stepRequests),
        version: 1,
        completedAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      steps.set(item.id, [...(steps.get(item.id) ?? []), step]);
      return json(route, step, 201);
    }
    if (path.endsWith('/note') && method === 'PATCH' && item) {
      const body = request.postDataJSON() as { contentMarkdown: string; baseVersion: number };
      const note = notes.get(item.id)!;
      if (note.version !== body.baseVersion) return rejected(route, '备注版本已变化');
      note.contentMarkdown = body.contentMarkdown;
      note.version += 1;
      return json(route, note);
    }
    if (item && method === 'PATCH') {
      const body = request.postDataJSON() as {
        baseVersion: number;
        title?: string;
        status?: TreeTaskDto['status'];
      };
      state.patches.push({ id: item.id, ...body });
      if (body.title !== undefined) {
        state.titleRequests += 1;
        await state.titleGate;
        if (state.rejectTitle) {
          state.rejectTitle = false;
          return rejected(route, '标题暂时无法保存');
        }
      }
      if (body.baseVersion !== item.version) return rejected(route, '任务版本已变化');
      if (body.title !== undefined) item.title = body.title;
      if (body.status) item.status = body.status;
      item.version += 1;
      return json(route, item);
    }
    if (item && method === 'DELETE') {
      state.deletes.push(item.id);
      if (state.rejectDelete && item.id === tasks[1]!.id) {
        state.rejectDelete = false;
        return rejected(route, '任务暂时无法删除');
      }
      item.deletedAt = createdAt;
      return json(route, { deleted: true });
    }
    if (item) {
      const detail: TaskDetailV2Dto = {
        task: item,
        note: notes.get(item.id)!,
        steps: steps.get(item.id) ?? [],
        placements: [],
        workflowMemberships: [],
        folderPath: [],
      };
      return json(route, detail);
    }
    return json(route, { items: [] });
  });
  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('workspace-fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.goto('/tree');
  await expect(
    page.getByRole('button', { name: '打开任务 整理发布清单', exact: true }),
  ).toBeVisible();
  return { state, tasks, notes, folders };
}

test('desktop detail stays nonmodal and serializes saves across task switches', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop parallel editor; compact detail is intentionally modal');
  await page.setViewportSize({ width: 1440, height: 900 });
  const { state, tasks, notes } = await workspace(page);
  let release!: () => void;
  state.titleGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByRole('button', { name: '打开任务 整理发布清单', exact: true }).click();
    await page
      .getByRole('textbox', { name: '任务标题', exact: true })
      .fill('整理发布清单 · 已修改');
    await page.getByRole('textbox', { name: '任务备注', exact: true }).fill('切换任务前写下的备注');
    await expect.poll(() => state.titleRequests).toBe(1);
    await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(
      '整理发布清单 · 已修改',
    );
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await page
      .locator('.workspace-editor')
      .getByRole('radio', { name: '进行中', exact: true })
      .click();
    await page.getByRole('button', { name: '打开任务 核对文档', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(
      '核对文档',
    );
    release();
    await expect.poll(() => tasks[0]!.status).toBe('IN_PROGRESS');
    await expect.poll(() => notes.get(tasks[0]!.id)!.contentMarkdown).toBe('切换任务前写下的备注');
    const titlePatch = state.patches.find((patch) => patch.title);
    const statusPatch = state.patches.find((patch) => patch.status);
    expect(titlePatch?.baseVersion).toBe(1);
    expect(statusPatch?.baseVersion).toBe(2);
    await page.getByRole('button', { name: '打开任务 整理发布清单 · 已修改', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue(
      '切换任务前写下的备注',
    );
    await expect(page.locator('.task-save-state')).toContainText('已保存');
    if (process.env['TASKDOCK_VISUAL_ARTIFACT_DIR'])
      await page.screenshot({
        path: `${process.env['TASKDOCK_VISUAL_ARTIFACT_DIR']}/workspace-desktop.png`,
      });
  } finally {
    release();
  }
});

test('failed title saves retain the draft and retry only after a visible error', async ({
  page,
}) => {
  const { state, tasks } = await workspace(page);
  state.rejectTitle = true;
  await page.getByRole('button', { name: '打开任务 整理发布清单', exact: true }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('保留这条编辑');
  await page.getByRole('textbox', { name: '任务备注', exact: true }).focus();
  await expect(page.locator('.workspace-editor .m3e-alert--error')).toContainText(
    '标题暂时无法保存',
  );
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(
    '保留这条编辑',
  );
  expect(tasks[0]!.title).toBe('整理发布清单');
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect.poll(() => tasks[0]!.title).toBe('保留这条编辑');
  await expect(page.locator('.workspace-editor .m3e-alert--error')).toHaveCount(0);
});

test('step capture survives task switches and clears only after a successful retry', async ({
  page,
  isMobile,
}) => {
  const { state } = await workspace(page);
  await page.getByRole('button', { name: '打开任务 整理发布清单', exact: true }).click();
  await page.getByRole('textbox', { name: '新增执行步骤', exact: true }).fill('验证构建文件');
  if (isMobile) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '打开任务 核对文档', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '新增执行步骤', exact: true })).toHaveValue('');
  if (isMobile) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '打开任务 整理发布清单', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '新增执行步骤', exact: true })).toHaveValue(
    '验证构建文件',
  );
  state.rejectStep = true;
  await page
    .locator('.workspace-editor')
    .getByRole('button', { name: '添加', exact: true })
    .click();
  await expect(page.locator('.workspace-editor .m3e-alert--error')).toContainText(
    '步骤暂时无法保存',
  );
  await expect(page.getByRole('textbox', { name: '新增执行步骤', exact: true })).toHaveValue(
    '验证构建文件',
  );
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '编辑步骤 验证构建文件', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '新增执行步骤', exact: true })).toHaveValue('');
  await expect(
    page.locator('.workspace-editor').getByRole('heading', { name: '步骤 0/1', exact: true }),
  ).toBeVisible();
  expect(state.stepRequests).toBe(2);
});

test('slow capture preserves the next typed task and blocks duplicate submissions', async ({
  page,
}) => {
  const { state, tasks } = await workspace(page);
  let release!: () => void;
  state.captureGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const input = page.getByRole('textbox', { name: '新建任务', exact: true });
    await input.fill('第一条录入');
    await input.press('Enter');
    await expect.poll(() => state.captureRequests).toBe(1);
    await input.fill('第二条录入');
    await input.press('Enter');
    expect(state.captureRequests).toBe(1);
    release();
    await expect(
      page.getByRole('button', { name: '打开任务 第一条录入', exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue('第二条录入');
    await input.press('Enter');
    await expect(
      page.getByRole('button', { name: '打开任务 第二条录入', exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue('');
    expect(tasks.filter((item) => item.title === '第一条录入')).toHaveLength(1);
    for (let index = 3; index <= 10; index += 1) {
      await input.fill(`连续录入 ${index}`);
      await input.press('Enter');
      await expect(
        page.getByRole('button', { name: `打开任务 连续录入 ${index}`, exact: true }),
      ).toBeVisible();
      await expect(input).toBeFocused();
    }
  } finally {
    release();
  }
});

test('bulk move distinguishes full paths and retains only failures for retry and undo', async ({
  page,
}) => {
  const { state, tasks, folders } = await workspace(page);
  state.rejectMove = true;
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 整理发布清单', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 核对文档', exact: true }).check();
  await page
    .getByRole('region', { name: '批量操作' })
    .getByRole('button', { name: '移动', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '目标文件夹', exact: true }).click();
  await expect(dialog.getByRole('option', { name: '个人 / 发布', exact: true })).toBeVisible();
  await dialog.getByRole('option', { name: '工作 / 发布', exact: true }).click();
  await dialog.getByRole('button', { name: '移动', exact: true }).click();
  await expect(dialog).toContainText('1 项失败');
  expect(tasks[0]!.parentFolderId).toBe(folders[2]!.id);
  expect(tasks[1]!.parentFolderId).toBeNull();
  await expect(page.getByRole('checkbox', { name: '选择 核对文档', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '重试失败项', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(tasks[1]!.parentFolderId).toBe(folders[2]!.id);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => tasks[1]!.parentFolderId).toBeNull();
  await expect(page.getByRole('button', { name: '打开任务 核对文档', exact: true })).toBeVisible();
});

test('bulk deletion reports partial failures without deleting successful items twice', async ({
  page,
}) => {
  const { state, tasks } = await workspace(page);
  state.rejectDelete = true;
  await page.getByRole('button', { name: '选择', exact: true }).click();
  for (const item of tasks)
    await page.getByRole('checkbox', { name: `选择 ${item.title}`, exact: true }).check();
  await page
    .getByRole('region', { name: '批量操作' })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog).toContainText('1 项未删除');
  expect(state.deletes.filter((id) => id === tasks[0]!.id)).toHaveLength(1);
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.deletes.filter((id) => id === tasks[0]!.id)).toHaveLength(1);
  await expect(page.getByRole('button', { name: '打开任务 核对文档', exact: true })).toHaveCount(0);
});

test('directory navigation and move targets exclude descendants of the moved folder', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop directory tree');
  await page.setViewportSize({ width: 1440, height: 900 });
  const { folders } = await workspace(page);
  await page.getByRole('button', { name: '打开 工作 的操作菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '移动到其他目录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '目标文件夹', exact: true }).click();
  await expect(dialog.getByRole('option', { name: '工作 / 发布', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('option', { name: '工作 / 发布 / 文档', exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByRole('option', { name: '个人 / 发布', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: '目录树', exact: true });
  await navigation.getByRole('button', { name: '展开 工作', exact: true }).click();
  await navigation.getByRole('link', { name: '发布', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/tree/${folders[2]!.id}$`));
  await expect(page.getByRole('heading', { name: '发布', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: '收起 工作', exact: true }).click();
  await expect(navigation.getByRole('link', { name: '发布', exact: true })).toHaveCount(0);
});

test('search failures show retry instead of an empty result', async ({ page }) => {
  const { state } = await workspace(page);
  state.rejectSearch = true;
  await page.getByRole('button', { name: '搜索任务和备注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '搜索和命令面板' });
  await dialog.getByRole('searchbox', { name: '搜索任务、备注或引用 ID' }).fill('清单');
  await expect(dialog).toContainText('搜索暂时不可用');
  await expect(dialog.getByText('没有找到匹配任务', { exact: true })).toHaveCount(0);
  state.rejectSearch = false;
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: '打开任务 整理发布清单', exact: true }),
  ).toBeVisible();
});

test('workspace stays usable at narrow widths with a full compact detail sheet', async ({
  page,
  isMobile,
}) => {
  await workspace(page);
  const widths = isMobile ? [390, 320] : [1440, 1024, 768, 390, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('textbox', { name: '新建任务', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: '打开任务 整理发布清单', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width < 600 || isMobile) {
      await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toHaveAttribute(
        'aria-modal',
        'true',
      );
      if (width === 390 && process.env['TASKDOCK_VISUAL_ARTIFACT_DIR'])
        await page.screenshot({
          path: `${process.env['TASKDOCK_VISUAL_ARTIFACT_DIR']}/workspace-mobile.png`,
        });
      await page
        .getByRole('dialog', { name: '任务详情', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
    } else {
      await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    }
  }
});

test('directory tasks reorder by drag and rename from F2 without a modal', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop drag and F2');
  await page.setViewportSize({ width: 1440, height: 900 });
  await workspace(page);
  const first = page.getByRole('button', { name: '打开任务 整理发布清单', exact: true });
  const second = page.getByRole('button', { name: '打开任务 核对文档', exact: true });
  await first.dragTo(second);
  await expect(page.locator('.tree-page .m3e-list-item[aria-label^="打开任务"]')).toHaveText([
    '核对文档',
    '整理发布清单',
  ]);
  await first.focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('键盘改名');
  await page.keyboard.press('Enter');
  const renamed = page.getByRole('button', { name: '打开任务 键盘改名', exact: true });
  await expect(renamed).toBeVisible();
  await renamed.focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toBeFocused();
});
