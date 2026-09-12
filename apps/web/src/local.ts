import type {
  LocalTaskDto,
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TaskDto,
  TimePointDto,
  UserDto,
} from '@devtodo/contracts';
import { uuidSchema, uuidv7 } from '@devtodo/contracts';
import { isValidIanaTimezone, validateLocalDate } from '@devtodo/domain';
import {
  captureLocalStateImage,
  type DevTodoDatabase,
  type LocalNote,
  type OutboxItem,
} from '@devtodo/sync-client';

interface LocalContext {
  db: DevTodoDatabase;
  clientId: string;
}

interface OfflineResult {
  value: unknown;
}

let activeContext: LocalContext | null = null;

const entityTables = (db: DevTodoDatabase) =>
  [
    db.projects,
    db.tasks,
    db.notes,
    db.timePoints,
    db.placements,
    db.settings,
    db.syncMeta,
    db.outbox,
  ] as const;

export function activateLocalCache(db: DevTodoDatabase, clientId: string): void {
  activeContext = { db, clientId };
}

export function deactivateLocalCache(db: DevTodoDatabase): void {
  if (activeContext?.db === db) activeContext = null;
}

export async function cacheResponse(path: string, value: unknown): Promise<void> {
  const context = activeContext;
  if (!context) return;
  try {
    await context.db.transaction('rw', entityTables(context.db), async () => {
      await cacheResponseInTransaction(context.db, path, value);
    });
  } catch {
    // A failed local cache write must not make an otherwise successful API call fail.
  }
}

export async function cacheMutationSideEffects(path: string, method: string): Promise<void> {
  const context = activeContext;
  if (!context) return;
  try {
    await context.db.transaction('rw', entityTables(context.db), async () => {
      const [pathname] = path.split('?');
      if (method === 'DELETE') {
        const placement = /^\/placements\/([^/]+)$/.exec(pathname ?? '');
        if (placement) await context.db.placements.delete(placement[1]!);
      }
    });
  } catch {
    // A failed local cache write must not make an otherwise successful API call fail.
  }
}

export async function readLocal(path: string): Promise<unknown | undefined> {
  const context = activeContext;
  if (!context) return undefined;
  return context.db.transaction('r', entityTables(context.db), () =>
    readLocalInTransaction(context.db, path),
  );
}

export async function applyOfflineWrite(
  path: string,
  method: string,
  init: RequestInit,
  headers: Headers,
): Promise<OfflineResult | undefined> {
  const context = activeContext;
  if (!context) return undefined;
  const body = parseBody(init.body);
  const mutationId = headers.get('Idempotency-Key');
  const clientId = headers.get('X-Client-Id') ?? context.clientId;
  if (!mutationId || !clientId) return undefined;
  const cleanPath = path.split('?')[0] ?? path;
  const now = new Date().toISOString();
  const timestamp = () => new Date().toISOString();

  if (method === 'POST' && cleanPath === '/projects') {
    const projectId = uuidv7();
    const name = boundedTrimmedString(body['name'], 160, '项目名称无效');
    const taskPrefix = boundedTrimmedString(body['taskPrefix'], 10, '项目代号无效').toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(taskPrefix)) throw new Error('项目代号无效');
    const project: ProjectDto = {
      id: projectId,
      name,
      taskPrefix,
      rank: nextRank(await context.db.projects.toArray()),
      version: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'project.create',
      projectId,
      null,
      { ...body, __localId: projectId },
      async () => {
        await context.db.projects.put({ ...project, pendingSync: true });
        return project;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/tasks') {
    const taskId = uuidv7();
    const projectId =
      body['projectId'] === undefined ? null : optionalNullableString(body['projectId']);
    if (projectId) {
      const project = await context.db.projects.get(projectId);
      if (!project) throw new Error('本地项目不存在');
      if (project.archivedAt) throw new Error('项目已归档');
    }
    const task = createLocalTask(taskId, body, now, await context.db.tasks.toArray());
    const note: NoteDto = {
      id: uuidv7(),
      taskId,
      contentMarkdown: '',
      version: 1,
      updatedAt: now,
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'task.create',
      taskId,
      null,
      { ...body, __localId: taskId, __localNoteId: note.id },
      async () => {
        await context.db.tasks.put({ ...task, pendingSync: true });
        await context.db.notes.put({ ...note, pendingSync: true });
        return task;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/time-points/date') {
    const localDate = requiredString(body['localDate']);
    validateLocalDate(localDate);
    const existing = (await context.db.timePoints.toArray()).find(
      (point) => point.type === 'DATE' && point.localDate === localDate && !point.archivedAt,
    );
    if (existing) return { value: existing };
    const point = createLocalTimePoint(uuidv7(), 'DATE', localDate, undefined, now);
    return enqueue(
      context,
      mutationId,
      clientId,
      'timePoint.date.create',
      point.id,
      null,
      { ...body, __localId: point.id },
      async () => {
        await context.db.timePoints.put({ ...point, pendingSync: true });
        return point;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/time-points/events') {
    const title = boundedTrimmedString(body['title'], 200, '时间点名称无效');
    const point = createLocalTimePoint(uuidv7(), 'EVENT', undefined, title, now);
    return enqueue(
      context,
      mutationId,
      clientId,
      'timePoint.event.create',
      point.id,
      null,
      { ...body, __localId: point.id },
      async () => {
        await context.db.timePoints.put({ ...point, pendingSync: true });
        return point;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/placements') {
    const taskId = requiredString(body['taskId']);
    const timePointId = requiredString(body['timePointId']);
    const task = await context.db.tasks.get(taskId);
    const point = await context.db.timePoints.get(timePointId);
    if (!task || task.archivedAt) throw new Error('任务不存在或已归档');
    if (!point || point.archivedAt) throw new Error('时间点不存在或已归档');
    const existing = (await context.db.placements.toArray()).find(
      (placement) => placement.taskId === taskId && placement.timePointId === timePointId,
    );
    if (existing) return { value: existing };
    const placement: PlacementDto = {
      id: uuidv7(),
      taskId,
      timePointId,
      rank: nextRank(
        (await context.db.placements.toArray()).filter(
          (candidate) => candidate.timePointId === timePointId,
        ),
      ),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'placement.create',
      placement.id,
      null,
      { ...body, __localId: placement.id },
      async () => {
        await context.db.placements.put({ ...placement, pendingSync: true });
        return placement;
      },
    );
  }

  const taskUpdate = /^\/tasks\/([^/]+)$/.exec(cleanPath);
  if (method === 'PATCH' && taskUpdate) {
    const taskId = taskUpdate[1]!;
    const task = await getTask(context.db, taskId);
    assertBaseVersion(task.version, body['baseVersion']);
    const nextProjectId =
      body['projectId'] === null || typeof body['projectId'] === 'string'
        ? (body['projectId'] as string | null)
        : task.projectId;
    const nextCategory = typeof body['category'] === 'string' ? body['category'] : task.category;
    validateTaskFields(
      nextProjectId,
      nextCategory,
      body['title'],
      body['priority'],
      body['status'],
    );
    if (nextProjectId) {
      const project = await context.db.projects.get(nextProjectId);
      if (!project) throw new Error('本地项目不存在');
      if (project.archivedAt && nextProjectId !== task.projectId) throw new Error('项目已归档');
    }
    const next = updateLocalTask(task, body, timestamp());
    return enqueue(
      context,
      mutationId,
      clientId,
      'task.update',
      taskId,
      task.version,
      body,
      async () => {
        await context.db.tasks.put({ ...next, pendingSync: true });
        return next;
      },
    );
  }

  const taskNoteUpdate = /^\/tasks\/([^/]+)\/note$/.exec(cleanPath);
  if (method === 'PUT' && taskNoteUpdate) {
    const taskId = taskNoteUpdate[1]!;
    const note = await getNote(context.db, taskId);
    assertBaseVersion(note.version, body['baseVersion']);
    const next: NoteDto = {
      ...note,
      contentMarkdown: markdownString(body['contentMarkdown']),
      version: note.version + 1,
      updatedAt: timestamp(),
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'note.update',
      taskId,
      note.version,
      body,
      async () => {
        await context.db.notes.put({ ...next, pendingSync: true });
        return next;
      },
    );
  }

  const taskAction = /^\/tasks\/([^/]+)\/(archive|restore|duplicate)$/.exec(cleanPath);
  if (method === 'POST' && taskAction) {
    const taskId = taskAction[1]!;
    const action = taskAction[2]!;
    if (action === 'duplicate') {
      const source = await getTask(context.db, taskId);
      const sourceNote = await getNote(context.db, taskId);
      const duplicate: LocalTaskDto = {
        ...source,
        id: uuidv7(),
        referenceId: null,
        status: 'TODO',
        completedAt: null,
        archivedAt: null,
        rank: nextRank(
          (await context.db.tasks.toArray()).filter(
            (candidate) =>
              candidate.projectId === source.projectId && candidate.category === source.category,
          ),
        ),
        version: 1,
        createdAt: timestamp(),
        updatedAt: timestamp(),
        pendingSync: true,
      };
      const note: LocalNote = {
        ...sourceNote,
        id: uuidv7(),
        taskId: duplicate.id,
        version: 1,
        updatedAt: duplicate.createdAt,
        pendingSync: true,
      };
      return enqueue(
        context,
        mutationId,
        clientId,
        'task.duplicate',
        taskId,
        null,
        { __localTaskId: duplicate.id, __localNoteId: note.id },
        async () => {
          await context.db.tasks.put(duplicate);
          await context.db.notes.put(note);
          return { task: duplicate, note };
        },
      );
    }
    const task = await getTask(context.db, taskId);
    assertBaseVersion(task.version, body['baseVersion']);
    const next: LocalTaskDto = {
      ...task,
      archivedAt: action === 'archive' ? timestamp() : null,
      version: task.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      `task.${action}`,
      taskId,
      task.version,
      body,
      async () => {
        await context.db.tasks.put(next);
        return next;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/tasks/reorder') {
    const ids = requiredStringArray(body['ids']);
    if (new Set(ids).size !== ids.length) throw new Error('本地排序列表不能有重复项');
    const tasks = await context.db.tasks.toArray();
    const selected = ids.map((id) => tasks.find((task) => task.id === id));
    const first = selected[0];
    if (
      !first ||
      selected.some(
        (task) => !task || task.projectId !== first.projectId || task.category !== first.category,
      )
    )
      throw new Error('只能在同一任务分组内排序');
    const expected = tasks.filter(
      (task) =>
        !task.archivedAt && task.projectId === first.projectId && task.category === first.category,
    );
    if (expected.length !== ids.length || expected.some((task) => !ids.includes(task.id)))
      throw new Error('任务排序列表必须包含整个活动分组');
    return enqueue(
      context,
      mutationId,
      clientId,
      'task.reorder',
      clientId,
      null,
      { ...body, ids },
      async () => {
        const updated = selected.map((task, index) => ({
          ...task!,
          rank: String((index + 1) * 1024),
          version: task!.version + 1,
          updatedAt: timestamp(),
          pendingSync: true,
        }));
        await context.db.tasks.bulkPut(updated);
        return updated;
      },
    );
  }

  const projectUpdate = /^\/projects\/([^/]+)$/.exec(cleanPath);
  if (method === 'PATCH' && projectUpdate) {
    const projectId = projectUpdate[1]!;
    const project = await context.db.projects.get(projectId);
    if (!project) throw new Error('本地项目不存在');
    assertBaseVersion(project.version, body['baseVersion']);
    const name =
      typeof body['name'] === 'string'
        ? boundedTrimmedString(body['name'], 160, '项目名称无效')
        : project.name;
    const taskPrefix =
      typeof body['taskPrefix'] === 'string'
        ? boundedTrimmedString(body['taskPrefix'], 10, '项目代号无效').toUpperCase()
        : project.taskPrefix;
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(taskPrefix)) throw new Error('项目代号无效');
    if (
      taskPrefix !== project.taskPrefix &&
      (await context.db.tasks.toArray()).some((task) => task.projectId === projectId)
    )
      throw new Error('项目已有任务后不能修改代号');
    const next: ProjectDto = {
      ...project,
      name,
      taskPrefix,
      version: project.version + 1,
      updatedAt: timestamp(),
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'project.update',
      projectId,
      project.version,
      body,
      async () => {
        await context.db.projects.put({ ...next, pendingSync: true });
        return next;
      },
    );
  }

  const projectAction = /^\/projects\/([^/]+)\/(archive|restore)$/.exec(cleanPath);
  if (method === 'POST' && projectAction) {
    const projectId = projectAction[1]!;
    const action = projectAction[2]!;
    const project = await context.db.projects.get(projectId);
    if (!project) throw new Error('本地项目不存在');
    assertBaseVersion(project.version, body['baseVersion']);
    const next: ProjectDto = {
      ...project,
      archivedAt: action === 'archive' ? timestamp() : null,
      version: project.version + 1,
      updatedAt: timestamp(),
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      `project.${action}`,
      projectId,
      project.version,
      body,
      async () => {
        await context.db.projects.put({ ...next, pendingSync: true });
        return next;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/projects/reorder') {
    const ids = requiredStringArray(body['ids']);
    if (new Set(ids).size !== ids.length) throw new Error('本地排序列表不能有重复项');
    const projects = await context.db.projects.toArray();
    const selected = ids.map((id) => projects.find((project) => project.id === id));
    if (selected.some((project) => !project)) throw new Error('本地项目不存在');
    const expected = projects.filter((project) => !project.archivedAt);
    if (expected.length !== ids.length || expected.some((project) => !ids.includes(project.id)))
      throw new Error('项目排序列表必须包含整个活动列表');
    return enqueue(
      context,
      mutationId,
      clientId,
      'project.reorder',
      clientId,
      null,
      { ...body, ids },
      async () => {
        const updated = selected.map((project, index) => ({
          ...project!,
          rank: String((index + 1) * 1024),
          version: project!.version + 1,
          updatedAt: timestamp(),
          pendingSync: true,
        }));
        await context.db.projects.bulkPut(updated);
        return updated;
      },
    );
  }

  const pointUpdate = /^\/time-points\/([^/]+)$/.exec(cleanPath);
  if (method === 'PATCH' && pointUpdate) {
    const pointId = pointUpdate[1]!;
    const point = await context.db.timePoints.get(pointId);
    if (!point || point.type !== 'EVENT') throw new Error('本地事件不存在');
    assertBaseVersion(point.version, body['baseVersion']);
    const title = boundedTrimmedString(body['title'], 200, '时间点名称无效');
    const next: TimePointDto = {
      ...point,
      title,
      version: point.version + 1,
      updatedAt: timestamp(),
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'timePoint.update',
      pointId,
      point.version,
      body,
      async () => {
        await context.db.timePoints.put({ ...next, pendingSync: true });
        return next;
      },
    );
  }

  const pointAction = /^\/time-points\/([^/]+)\/(reach|archive|restore)$/.exec(cleanPath);
  if (method === 'POST' && pointAction) {
    const pointId = pointAction[1]!;
    const action = pointAction[2]!;
    const point = await context.db.timePoints.get(pointId);
    if (!point || point.type !== 'EVENT') throw new Error('本地事件不存在');
    assertBaseVersion(point.version, body['baseVersion']);
    const next: TimePointDto = {
      ...point,
      reachedAt: action === 'reach' ? (point.reachedAt ?? timestamp()) : point.reachedAt,
      archivedAt:
        action === 'archive' ? timestamp() : action === 'restore' ? null : point.archivedAt,
      version: point.version + 1,
      updatedAt: timestamp(),
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      `timePoint.${action}`,
      pointId,
      point.version,
      body,
      async () => {
        await context.db.timePoints.put({ ...next, pendingSync: true });
        return next;
      },
    );
  }

  if (method === 'POST' && cleanPath === '/time-points/events/reorder') {
    const ids = requiredStringArray(body['ids']);
    if (new Set(ids).size !== ids.length) throw new Error('本地排序列表不能有重复项');
    const points = await context.db.timePoints.toArray();
    const selected = ids.map((id) => points.find((point) => point.id === id));
    if (selected.some((point) => !point || point.type !== 'EVENT'))
      throw new Error('本地事件不存在');
    const expected = points.filter((point) => point.type === 'EVENT' && !point.archivedAt);
    if (expected.length !== ids.length || expected.some((point) => !ids.includes(point.id)))
      throw new Error('时间点排序列表必须包含整个活动列表');
    return enqueue(
      context,
      mutationId,
      clientId,
      'timePoint.reorder',
      clientId,
      null,
      { ...body, ids },
      async () => {
        const updated = selected.map((point, index) => ({
          ...point!,
          rank: String((index + 1) * 1024),
          version: point!.version + 1,
          updatedAt: timestamp(),
          pendingSync: true,
        }));
        await context.db.timePoints.bulkPut(updated);
        return updated;
      },
    );
  }

  const placementDelete = /^\/placements\/([^/]+)$/.exec(cleanPath);
  if (method === 'DELETE' && placementDelete) {
    const placementId = placementDelete[1]!;
    const placement = await context.db.placements.get(placementId);
    if (!placement) throw new Error('本地安排不存在');
    assertBaseVersion(placement.version, body['baseVersion']);
    return enqueue(
      context,
      mutationId,
      clientId,
      'placement.remove',
      placementId,
      placement.version,
      body,
      async () => {
        await context.db.placements.delete(placementId);
        return undefined;
      },
    );
  }

  const placementAction = /^\/placements\/([^/]+)\/(copy|move)$/.exec(cleanPath);
  if (method === 'POST' && placementAction) {
    const placementId = placementAction[1]!;
    const action = placementAction[2]!;
    const source = await context.db.placements.get(placementId);
    if (!source) throw new Error('本地安排不存在');
    const targetTimePointId = requiredString(body['timePointId']);
    if (action === 'move' && targetTimePointId === source.timePointId)
      throw new Error('安排已经位于目标时间点');
    const target = await context.db.timePoints.get(targetTimePointId);
    if (!target || target.archivedAt) throw new Error('目标时间点不存在或已归档');
    const existing = (await context.db.placements.toArray()).find(
      (candidate) =>
        candidate.taskId === source.taskId && candidate.timePointId === targetTimePointId,
    );
    if (action === 'copy' && existing) return { value: existing };
    const next =
      existing ??
      createLocalPlacement(
        uuidv7(),
        source.taskId,
        targetTimePointId,
        nextRank(
          (await context.db.placements.toArray()).filter(
            (candidate) => candidate.timePointId === targetTimePointId,
          ),
        ),
        timestamp(),
      );
    return enqueue(
      context,
      mutationId,
      clientId,
      `placement.${action}`,
      placementId,
      action === 'move' ? source.version : null,
      { ...body, __localId: next.id },
      async () => {
        if (!existing) await context.db.placements.put({ ...next, pendingSync: true });
        if (action === 'move') await context.db.placements.delete(placementId);
        return {
          placement: next,
          ...(action === 'move'
            ? { sourcePlacementId: placementId, existed: Boolean(existing) }
            : {}),
        };
      },
    );
  }

  const placementReorder = /^\/time-points\/([^/]+)\/placements\/reorder$/.exec(cleanPath);
  if (method === 'POST' && placementReorder) {
    const ids = requiredStringArray(body['ids']);
    if (new Set(ids).size !== ids.length) throw new Error('本地排序列表不能有重复项');
    const placements = await context.db.placements.toArray();
    const selected = ids.map((id) => placements.find((placement) => placement.id === id));
    if (selected.some((placement) => !placement || placement.timePointId !== placementReorder[1]))
      throw new Error('本地安排不存在');
    const expected = placements.filter(
      (placement) => placement.timePointId === placementReorder[1],
    );
    if (expected.length !== ids.length || expected.some((placement) => !ids.includes(placement.id)))
      throw new Error('安排排序列表必须包含整个时间点列表');
    return enqueue(
      context,
      mutationId,
      clientId,
      'placement.reorder',
      placementReorder[1]!,
      null,
      { ...body, ids },
      async () => {
        const updated = selected.map((placement, index) => ({
          ...placement!,
          rank: String((index + 1) * 1024),
          version: placement!.version + 1,
          updatedAt: timestamp(),
          pendingSync: true,
        }));
        await context.db.placements.bulkPut(updated);
        return updated;
      },
    );
  }

  if (method === 'PATCH' && cleanPath === '/settings') {
    const settings = await context.db.settings.toCollection().first();
    if (!settings) throw new Error('本地设置不存在');
    assertBaseVersion(settings.version, body['baseVersion']);
    if (typeof body['timezone'] === 'string' && !isValidIanaTimezone(body['timezone']))
      throw new Error('无效的 IANA 时区');
    if (
      body['defaultCaptureTarget'] !== undefined &&
      body['defaultCaptureTarget'] !== 'GLOBAL_MISC' &&
      body['defaultCaptureTarget'] !== 'RECENT_CONTEXT'
    )
      throw new Error('默认捕获位置无效');
    const next: SettingsDto = {
      ...settings,
      ...(typeof body['timezone'] === 'string' ? { timezone: body['timezone'] } : {}),
      ...(body['weekStartsOn'] === 0 || body['weekStartsOn'] === 1
        ? { weekStartsOn: body['weekStartsOn'] }
        : {}),
      ...(typeof body['defaultCaptureTarget'] === 'string'
        ? { defaultCaptureTarget: body['defaultCaptureTarget'] }
        : {}),
      version: settings.version + 1,
      updatedAt: timestamp(),
    };
    return enqueue(
      context,
      mutationId,
      clientId,
      'settings.update',
      settings.ownerId,
      settings.version,
      body,
      async () => {
        await context.db.settings.put(next);
        return next;
      },
    );
  }

  return undefined;
}

async function enqueue(
  context: LocalContext,
  mutationId: string,
  clientId: string,
  command: string,
  entityId: string,
  baseVersion: number | null,
  payload: Record<string, unknown>,
  write: () => Promise<unknown>,
): Promise<OfflineResult> {
  const item: OutboxItem = {
    mutationId,
    clientId,
    command,
    entityId,
    baseVersion,
    occurredAt: new Date().toISOString(),
    payload,
    attempts: 0,
    nextAttemptAt: Date.now(),
  };
  const value = await context.db.transaction('rw', entityTables(context.db), async () => {
    const beforeImage = await captureLocalStateImage(context.db, command, entityId, payload);
    const result = await write();
    const afterImage = await captureLocalStateImage(context.db, command, entityId, payload);
    item.beforeImage = beforeImage;
    item.afterImage = afterImage;
    await context.db.outbox.add(item);
    return result;
  });
  return { value };
}

async function cacheResponseInTransaction(
  db: DevTodoDatabase,
  path: string,
  value: unknown,
): Promise<void> {
  const [pathname] = path.split('?');
  if (pathname === '/me' && isRecord(value)) {
    const settings = value['settings'];
    const user = value['user'];
    if (isRecord(settings)) await db.settings.put(settings as unknown as SettingsDto);
    if (isRecord(user)) await db.syncMeta.put({ key: 'user', value: JSON.stringify(user) });
    return;
  }
  if (pathname === '/settings' && isRecord(value)) {
    await db.settings.put(value as unknown as SettingsDto);
    return;
  }
  if (pathname === '/sync/snapshot' && isRecord(value)) {
    await putSnapshot(db, value);
    return;
  }
  if (pathname === '/projects' && isProjectDto(value)) {
    await db.projects.put(value as ProjectDto);
    return;
  }
  if (pathname === '/projects' && isRecord(value) && Array.isArray(value['items'])) {
    await db.projects.bulkPut(value['items'] as ProjectDto[]);
    return;
  }
  if (pathname === '/tasks' && isTaskDto(value)) {
    await db.tasks.put(value as TaskDto);
    return;
  }
  if (pathname === '/tasks' && isRecord(value) && Array.isArray(value['items'])) {
    await db.tasks.bulkPut(value['items'] as TaskDto[]);
    return;
  }
  if (pathname === '/time-points' && isRecord(value) && Array.isArray(value['items'])) {
    await db.timePoints.bulkPut(value['items'] as TimePointDto[]);
    return;
  }
  if (pathname === '/projects/reorder' && Array.isArray(value)) {
    await db.projects.bulkPut(value as ProjectDto[]);
    return;
  }
  if (pathname === '/tasks/reorder' && Array.isArray(value)) {
    await db.tasks.bulkPut(value as TaskDto[]);
    return;
  }
  if (pathname === '/time-points/events/reorder' && Array.isArray(value)) {
    await db.timePoints.bulkPut(value as TimePointDto[]);
    return;
  }
  if (pathname === '/placements' && isPlacementDto(value)) {
    await db.placements.put(value as PlacementDto);
    return;
  }
  if (pathname?.endsWith('/placements') && isRecord(value) && Array.isArray(value['items'])) {
    const items = value['items'];
    await db.placements.bulkPut(
      items.filter(isRecord).map((item) => stripTask(item) as unknown as PlacementDto),
    );
    for (const item of items) {
      if (isRecord(item) && isRecord(item['task']))
        await db.tasks.put(item['task'] as unknown as TaskDto);
    }
    return;
  }
  if (/^\/time-points\/[^/]+\/placements\/reorder$/.test(pathname ?? '') && Array.isArray(value)) {
    await db.placements.bulkPut(value as PlacementDto[]);
    return;
  }
  const taskAction = /^\/tasks\/([^/]+)\/(archive|restore)$/.exec(pathname ?? '');
  if (taskAction && isTaskDto(value)) {
    await db.tasks.put(value as TaskDto);
    return;
  }
  const taskDuplicate = /^\/tasks\/([^/]+)\/duplicate$/.exec(pathname ?? '');
  if (taskDuplicate && isRecord(value)) {
    if (isRecord(value['task'])) await db.tasks.put(value['task'] as unknown as TaskDto);
    if (isRecord(value['note'])) await db.notes.put(value['note'] as unknown as NoteDto);
    return;
  }
  const placementAction = /^\/placements\/([^/]+)\/(move|copy)$/.exec(pathname ?? '');
  if (placementAction && isRecord(value) && isRecord(value['placement'])) {
    await db.placements.put(value['placement'] as unknown as PlacementDto);
    if (placementAction[2] === 'move' && typeof value['sourcePlacementId'] === 'string')
      await db.placements.delete(value['sourcePlacementId']);
    return;
  }
  const taskDetails = /^\/tasks\/[^/]+$/.test(pathname ?? '');
  if (taskDetails && isRecord(value)) {
    if (isTaskDto(value)) {
      await db.tasks.put(value as TaskDto);
      return;
    }
    if (isRecord(value['task'])) await db.tasks.put(value['task'] as unknown as TaskDto);
    if (isRecord(value['note'])) await db.notes.put(value['note'] as unknown as NoteDto);
    if (Array.isArray(value['placements']))
      await db.placements.bulkPut(value['placements'] as PlacementDto[]);
    return;
  }
  if (/^\/tasks\/[^/]+\/note$/.test(pathname ?? '') && isRecord(value)) {
    await db.notes.put(value as unknown as NoteDto);
    return;
  }
  if (/^\/projects\/[^/]+$/.test(pathname ?? '') && isRecord(value)) {
    await db.projects.put(value as unknown as ProjectDto);
    return;
  }
  const timePointAction = /^\/time-points\/[^/]+\/(reach|archive|restore)$/.exec(pathname ?? '');
  if (timePointAction && isTimePointDto(value)) {
    await db.timePoints.put(value as TimePointDto);
    return;
  }
  if (/^\/time-points\/[^/]+$/.test(pathname ?? '') && isRecord(value)) {
    await db.timePoints.put(value as unknown as TimePointDto);
  }
}

async function readLocalInTransaction(db: DevTodoDatabase, path: string): Promise<unknown> {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if (pathname === '/me') {
    const userMeta = await db.syncMeta.get('user');
    const settings = await db.settings.toCollection().first();
    if (!userMeta || !settings) return undefined;
    return {
      user: JSON.parse(userMeta.value) as UserDto,
      settings,
      capabilities: { syncProtocolVersion: 1, websocket: true, offline: true },
    };
  }
  if (pathname === '/settings') return db.settings.toCollection().first();
  if (pathname === '/projects/task-counts') {
    const archived = params.get('archived') === 'true';
    const projects = (await db.projects.toArray()).filter((project) =>
      archived ? Boolean(project.archivedAt) : !project.archivedAt,
    );
    const counts = new Map(
      projects.map((project) => [
        project.id,
        { projectId: project.id, openCount: 0, doneCount: 0 },
      ]),
    );
    for (const task of await db.tasks.toArray()) {
      if (task.archivedAt || !task.projectId) continue;
      const count = counts.get(task.projectId);
      if (!count) continue;
      if (task.status === 'DONE') count.doneCount += 1;
      else count.openCount += 1;
    }
    return { items: projects.map((project) => counts.get(project.id)) };
  }
  if (pathname === '/projects') {
    const archived = params.get('archived') === 'true';
    const items = (await db.projects.toArray()).filter((project) =>
      archived ? Boolean(project.archivedAt) : !project.archivedAt,
    );
    return { items: sortByRank(items), nextCursor: null };
  }
  if (pathname === '/tasks') {
    let items = await db.tasks.toArray();
    const archived = params.get('archived') === 'true';
    if (params.has('projectId')) {
      const projectId = params.get('projectId');
      items = items.filter((task) => task.projectId === (projectId === 'null' ? null : projectId));
    }
    if (params.has('category'))
      items = items.filter((task) => task.category === params.get('category'));
    if (params.has('status')) items = items.filter((task) => task.status === params.get('status'));
    items = items.filter((task) => (archived ? Boolean(task.archivedAt) : !task.archivedAt));
    const timePointId = params.get('timePointId');
    if (timePointId) {
      const taskIds = new Set(
        (await db.placements.toArray())
          .filter((placement) => placement.timePointId === timePointId)
          .map((placement) => placement.taskId),
      );
      items = items.filter((task) => taskIds.has(task.id));
    }
    return { items: sortByRank(items), nextCursor: null };
  }
  if (pathname === '/search/tasks') {
    const q = (params.get('q') ?? '').trim().toLocaleLowerCase();
    const includeArchived = params.get('includeArchived') === 'true';
    if (!q) return { items: [] };
    const [tasks, projects, notes] = await Promise.all([
      db.tasks.toArray(),
      db.projects.toArray(),
      db.notes.toArray(),
    ]);
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const noteMap = new Map(notes.map((note) => [note.taskId, note]));
    return {
      items: tasks
        .filter((task) => includeArchived || !task.archivedAt)
        .filter((task) => {
          const project = task.projectId ? projectMap.get(task.projectId) : undefined;
          const note = noteMap.get(task.id);
          return [
            task.title,
            task.referenceId ?? '',
            project?.name ?? '',
            note?.contentMarkdown ?? '',
          ]
            .join('\n')
            .toLocaleLowerCase()
            .includes(q);
        })
        .map((task) => ({
          task,
          project: task.projectId ? (projectMap.get(task.projectId) ?? null) : null,
          note: noteMap.get(task.id) ?? {
            id: '',
            taskId: task.id,
            contentMarkdown: '',
            version: 0,
            updatedAt: task.updatedAt,
          },
        })),
    };
  }
  if (pathname === '/time-points') {
    let items = await db.timePoints.toArray();
    const type = params.get('type');
    if (type) items = items.filter((point) => point.type === type);
    const archived = params.get('archived');
    items = items.filter((point) =>
      archived === null ? !point.archivedAt : Boolean(point.archivedAt) === (archived === 'true'),
    );
    return { items: items.sort(timePointSort), nextCursor: null };
  }
  if (pathname === '/time-points/placement-counts') {
    const type = params.get('type');
    const archived = params.get('archived');
    const from = params.get('from');
    const to = params.get('to');
    const points = (await db.timePoints.toArray()).filter(
      (point) =>
        point.type === type &&
        (archived === null || Boolean(point.archivedAt) === (archived === 'true')) &&
        (from === null || (point.localDate ?? '') >= from) &&
        (to === null || (point.localDate ?? '') <= to),
    );
    const tasks = new Map((await db.tasks.toArray()).map((task) => [task.id, task]));
    const counts = new Map(
      points.map((point) => [
        point.id,
        {
          timePointId: point.id,
          localDate: point.localDate,
          totalCount: 0,
          openCount: 0,
          doneCount: 0,
        },
      ]),
    );
    for (const placement of await db.placements.toArray()) {
      const count = counts.get(placement.timePointId);
      const task = tasks.get(placement.taskId);
      if (!count || !task || task.archivedAt) continue;
      count.totalCount += 1;
      if (task.status === 'DONE') count.doneCount += 1;
      else count.openCount += 1;
    }
    return { items: points.map((point) => counts.get(point.id)) };
  }
  if (pathname === '/sync/status') {
    const cursor = (await db.syncMeta.get('cursor'))?.value ?? '0';
    return { cursor, oldestCursor: '0', protocolVersion: 1 };
  }
  const taskDetail = /^\/tasks\/([^/]+)$/.exec(pathname ?? '');
  if (taskDetail) {
    const task = await db.tasks.get(taskDetail[1]!);
    if (!task) return undefined;
    return {
      task,
      note: await getNote(db, task.id),
      placements: (await db.placements.toArray()).filter(
        (placement) => placement.taskId === task.id,
      ),
    };
  }
  const taskNote = /^\/tasks\/([^/]+)\/note$/.exec(pathname ?? '');
  if (taskNote) return getNote(db, taskNote[1]!);
  const projectDetail = /^\/projects\/([^/]+)$/.exec(pathname ?? '');
  if (projectDetail) return db.projects.get(projectDetail[1]!);
  const pointPlacements = /^\/time-points\/([^/]+)\/placements$/.exec(pathname ?? '');
  if (pointPlacements) {
    const tasks = new Map((await db.tasks.toArray()).map((task) => [task.id, task]));
    const items = (await db.placements.where('timePointId').equals(pointPlacements[1]!).toArray())
      .map((placement) => ({ ...placement, task: tasks.get(placement.taskId) }))
      .filter((item): item is PlacementDto & { task: TaskDto } => Boolean(item.task));
    return { items };
  }
  const pointDetail = /^\/time-points\/([^/]+)$/.exec(pathname ?? '');
  if (pointDetail) return db.timePoints.get(pointDetail[1]!);
  if (pathname === '/sync/snapshot') {
    const [projects, tasks, notes, timePoints, placements, settings, cursor] = await Promise.all([
      db.projects.toArray(),
      db.tasks.toArray(),
      db.notes.toArray(),
      db.timePoints.toArray(),
      db.placements.toArray(),
      db.settings.toCollection().first(),
      db.syncMeta.get('cursor'),
    ]);
    if (!settings) return undefined;
    return {
      projects,
      tasks,
      notes,
      timePoints,
      placements,
      settings,
      cursor: cursor?.value ?? '0',
    };
  }
  return undefined;
}

async function putSnapshot(db: DevTodoDatabase, value: Record<string, unknown>): Promise<void> {
  const projects = Array.isArray(value['projects']) ? (value['projects'] as ProjectDto[]) : [];
  const tasks = Array.isArray(value['tasks']) ? (value['tasks'] as TaskDto[]) : [];
  const notes = Array.isArray(value['notes']) ? (value['notes'] as NoteDto[]) : [];
  const timePoints = Array.isArray(value['timePoints'])
    ? (value['timePoints'] as TimePointDto[])
    : [];
  const placements = Array.isArray(value['placements'])
    ? (value['placements'] as PlacementDto[])
    : [];
  await Promise.all([
    db.projects.bulkPut(projects),
    db.tasks.bulkPut(tasks),
    db.notes.bulkPut(notes),
    db.timePoints.bulkPut(timePoints),
    db.placements.bulkPut(placements),
    isRecord(value['settings'])
      ? db.settings.put(value['settings'] as unknown as SettingsDto)
      : Promise.resolve(),
  ]);
  if (typeof value['cursor'] === 'string')
    await db.syncMeta.put({ key: 'cursor', value: value['cursor'] });
}

function createLocalTask(
  id: string,
  body: Record<string, unknown>,
  now: string,
  existing: LocalTaskDto[],
): LocalTaskDto {
  const projectId =
    body['projectId'] === undefined || body['projectId'] === null
      ? null
      : optionalNullableString(body['projectId']);
  const category = body['category'];
  const priority = body['priority'] ?? 'NONE';
  validateTaskFields(projectId, category, body['title'], priority, undefined);
  const normalizedCategory = category as LocalTaskDto['category'];
  return {
    id,
    referenceId: null,
    projectId,
    category: normalizedCategory,
    title: boundedTrimmedString(body['title'], 500, '任务标题无效'),
    status: 'TODO',
    priority: priority as LocalTaskDto['priority'],
    rank: nextRank(
      existing.filter((task) => task.projectId === projectId && task.category === category),
    ),
    version: 1,
    completedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createLocalTimePoint(
  id: string,
  type: TimePointDto['type'],
  localDate: string | undefined,
  title: string | undefined,
  now: string,
): TimePointDto {
  return {
    id,
    type,
    localDate: localDate ?? null,
    title: title?.trim() ?? null,
    rank: '1024',
    version: 1,
    reachedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createLocalPlacement(
  id: string,
  taskId: string,
  timePointId: string,
  rank: string,
  now: string,
): PlacementDto {
  return { id, taskId, timePointId, rank, version: 1, createdAt: now, updatedAt: now };
}

function updateLocalTask(
  task: LocalTaskDto,
  body: Record<string, unknown>,
  now: string,
): LocalTaskDto {
  const projectId =
    body['projectId'] === null || typeof body['projectId'] === 'string'
      ? (body['projectId'] as string | null)
      : task.projectId;
  const category = typeof body['category'] === 'string' ? body['category'] : task.category;
  const status = (
    typeof body['status'] === 'string' ? body['status'] : task.status
  ) as LocalTaskDto['status'];
  const priority = typeof body['priority'] === 'string' ? body['priority'] : task.priority;
  validateTaskFields(projectId, category, body['title'], priority, status);
  if (body['rank'] !== undefined && !/^[1-9]\d*$/.test(String(body['rank'])))
    throw new Error('rank 无效');
  return {
    ...task,
    ...(typeof body['title'] === 'string' ? { title: body['title'].trim() } : {}),
    ...(body['projectId'] === null || typeof body['projectId'] === 'string'
      ? { projectId: body['projectId'] as string | null }
      : {}),
    ...(typeof body['category'] === 'string'
      ? { category: body['category'] as LocalTaskDto['category'] }
      : {}),
    ...(typeof body['priority'] === 'string'
      ? { priority: body['priority'] as LocalTaskDto['priority'] }
      : {}),
    ...(typeof body['rank'] === 'string' ? { rank: body['rank'] } : {}),
    status,
    completedAt: status === 'DONE' ? (task.completedAt ?? now) : null,
    version: task.version + 1,
    updatedAt: now,
  };
}

async function getTask(db: DevTodoDatabase, id: string): Promise<LocalTaskDto> {
  const task = await db.tasks.get(id);
  if (!task) throw new Error('本地任务不存在');
  return task;
}

async function getNote(db: DevTodoDatabase, taskId: string): Promise<NoteDto> {
  const note = await db.notes.where('taskId').equals(taskId).first();
  if (!note) throw new Error('本地备注不存在');
  return note;
}

function assertBaseVersion(actual: number, expected: unknown): void {
  if (actual !== expected) throw new Error('本地实体版本已变化，请刷新后重试');
}

function boundedTrimmedString(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(message);
  return normalized;
}

function markdownString(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 * 1024)
    throw new Error('备注超过 1 MiB 或格式无效');
  return value;
}

function optionalNullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !uuidSchema.safeParse(value).success)
    throw new Error('本地请求参数无效');
  return value;
}

function validateTaskFields(
  projectId: string | null,
  category: unknown,
  title: unknown,
  priority: unknown,
  status: unknown,
): void {
  if (projectId !== null && !uuidSchema.safeParse(projectId).success)
    throw new Error('本地项目 ID 无效');
  if (category !== 'FEATURE' && category !== 'MISC') throw new Error('任务分类无效');
  if (projectId === null && category !== 'MISC') throw new Error('全局任务只能属于杂项分类');
  if (title !== undefined) boundedTrimmedString(title, 500, '任务标题无效');
  if (priority !== 'NONE' && priority !== 'LOW' && priority !== 'MEDIUM' && priority !== 'HIGH')
    throw new Error('任务优先级无效');
  if (status !== undefined && status !== 'TODO' && status !== 'IN_PROGRESS' && status !== 'DONE')
    throw new Error('任务状态无效');
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string' || !body) return {};
  const value: unknown = JSON.parse(body);
  return isRecord(value) ? value : {};
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('本地请求参数无效');
  return value;
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))
    throw new Error('本地请求参数无效');
  return value;
}

function nextRank(rows: Array<{ rank: string }>): string {
  const max = rows.reduce((current, row) => {
    const rank = BigInt(row.rank);
    return rank > current ? rank : current;
  }, 0n);
  return (max + 1024n).toString();
}

function sortByRank<T extends { rank: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => {
    const a = BigInt(left.rank);
    const b = BigInt(right.rank);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function timePointSort(left: TimePointDto, right: TimePointDto): number {
  if (left.type === 'DATE' && right.type === 'DATE')
    return (left.localDate ?? '').localeCompare(right.localDate ?? '');
  return sortByRank([left, right]).indexOf(left) === 0 ? -1 : 1;
}

function stripTask(item: Record<string, unknown>): Record<string, unknown> {
  const placement = { ...item };
  delete placement['task'];
  return placement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskDto(value: unknown): value is TaskDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['category'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['version'] === 'number'
  );
}

function isProjectDto(value: unknown): value is ProjectDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['taskPrefix'] === 'string' &&
    typeof value['version'] === 'number'
  );
}

function isTimePointDto(value: unknown): value is TimePointDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['type'] === 'DATE' || value['type'] === 'EVENT') &&
    typeof value['version'] === 'number'
  );
}

function isPlacementDto(value: unknown): value is PlacementDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['taskId'] === 'string' &&
    typeof value['timePointId'] === 'string' &&
    typeof value['version'] === 'number'
  );
}
