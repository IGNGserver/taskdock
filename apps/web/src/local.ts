import type {
  LocalTaskDto,
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TaskDto,
  TimePointDto,
  TreeTaskDto,
  V2SettingsDto,
  UserDto,
} from '@devtodo/contracts';
import { uuidSchema, uuidv7 } from '@devtodo/contracts';
import { isValidIanaTimezone, validateLocalDate } from '@devtodo/domain';
import { ApiError } from './api.js';
import {
  captureLocalStateImage,
  type DevTodoDatabase,
  type LocalFolder,
  type LocalNote,
  type LocalPlacement,
  type LocalTaskStep,
  type LocalTimePoint,
  type LocalTreeTask,
  type LocalWorkflow,
  type LocalWorkflowStage,
  type LocalWorkflowTaskMembership,
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
    db.folders,
    db.taskSteps,
    db.workflows,
    db.workflowStages,
    db.workflowTaskMemberships,
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

  if (cleanPath.startsWith('/v2/'))
    return applyOfflineV2Write(
      context,
      mutationId,
      clientId,
      cleanPath.slice(3),
      method,
      body,
      now,
    );

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
    }
    const task = createLocalTask(
      taskId,
      body,
      now,
      (await context.db.tasks.toArray()) as LocalTaskDto[],
    );
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
      (point) => point.type === 'DATE' && point.localDate === localDate && !point.deletedAt,
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
    if (!task || task.deletedAt) throw new Error('任务不存在');
    if (!point || point.deletedAt) throw new Error('时间点不存在');
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

  const taskAction = /^\/tasks\/([^/]+)\/(duplicate)$/.exec(cleanPath);
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
    void action;
    throw new Error('v1 归档写入已关闭');
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
      (task) => task.projectId === first.projectId && task.category === first.category,
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

  if (method === 'POST' && /^\/projects\/[^/]+\/(archive|restore)$/.test(cleanPath)) {
    // The archive mechanism was removed; these v1 writes are closed.
    throw new Error('v1 归档写入已关闭');
  }

  if (method === 'POST' && cleanPath === '/projects/reorder') {
    const ids = requiredStringArray(body['ids']);
    if (new Set(ids).size !== ids.length) throw new Error('本地排序列表不能有重复项');
    const projects = await context.db.projects.toArray();
    const selected = ids.map((id) => projects.find((project) => project.id === id));
    if (selected.some((project) => !project)) throw new Error('本地项目不存在');
    const expected = projects;
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

  const pointAction = /^\/time-points\/([^/]+)\/(reach)$/.exec(cleanPath);
  if (method === 'POST' && pointAction) {
    const pointId = pointAction[1]!;
    const action = pointAction[2]!;
    const point = await context.db.timePoints.get(pointId);
    if (!point || point.type !== 'EVENT') throw new Error('本地事件不存在');
    assertBaseVersion(point.version, body['baseVersion']);
    const next: TimePointDto = {
      ...point,
      reachedAt: action === 'reach' ? (point.reachedAt ?? timestamp()) : point.reachedAt,
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
    const expected = points.filter((point) => point.type === 'EVENT' && !point.deletedAt);
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
    if (!target || target.deletedAt) throw new Error('目标时间点不存在');
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

async function applyOfflineV2Write(
  context: LocalContext,
  mutationId: string,
  clientId: string,
  path: string,
  method: string,
  body: Record<string, unknown>,
  now: string,
): Promise<OfflineResult | undefined> {
  const db = context.db;
  const timestamp = () => new Date().toISOString();
  const payload = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'baseVersion'));
  const task = async (id: string): Promise<LocalTreeTask> => {
    const row = await db.tasks.get(id);
    const treeRow = row as LocalTreeTask | undefined;
    if (!treeRow || treeRow.parentFolderId === undefined) throw new Error('本地 v2 任务不存在');
    return treeRow;
  };
  const folder = async (id: string): Promise<LocalFolder> => {
    const row = await db.folders.get(id);
    if (!row) throw new Error('本地 v2 文件夹不存在');
    return row as LocalFolder;
  };
  const baseVersion = typeof body['baseVersion'] === 'number' ? body['baseVersion'] : null;
  const enqueueV2 = (
    command: string,
    entityId: string,
    version: number | null,
    commandPayload: Record<string, unknown>,
    write: () => Promise<unknown>,
  ) => enqueue(context, mutationId, clientId, command, entityId, version, commandPayload, write);

  if (method === 'POST' && path === '/folders') {
    const id = typeof body['id'] === 'string' ? body['id'] : uuidv7();
    const parentFolderId =
      body['parentFolderId'] === null ? null : requiredString(body['parentFolderId']);
    if (parentFolderId) await folder(parentFolderId);
    const title = boundedTrimmedString(body['title'], 160, '文件夹名称无效');
    const folders = await db.folders.toArray();
    const created: LocalFolder = {
      id,
      parentFolderId,
      title,
      rank: nextRank(folders.filter((candidate) => candidate.parentFolderId === parentFolderId)),
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
    return enqueueV2('folder.create', id, null, { parentFolderId, title }, async () => {
      await db.folders.put(created);
      return created;
    });
  }

  const folderUpdate = /^\/folders\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && folderUpdate) {
    const current = await folder(folderUpdate[1]!);
    assertBaseVersion(current.version, baseVersion);
    const next: LocalFolder = {
      ...current,
      title:
        body['title'] === undefined
          ? current.title
          : boundedTrimmedString(body['title'], 160, '文件夹名称无效'),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'folder.update',
      current.id,
      current.version,
      { title: next.title },
      async () => {
        await db.folders.put(next);
        return next;
      },
    );
  }

  const treeMove = path === '/tree/items/move' && method === 'POST';
  if (treeMove) {
    if (!isRecord(body['item'])) throw new Error('目录项无效');
    const item = body['item'];
    const kind = item['kind'] === 'FOLDER' || item['kind'] === 'TASK' ? item['kind'] : null;
    const id = typeof item['id'] === 'string' ? item['id'] : null;
    if (!kind || !id) throw new Error('目录项无效');
    const targetParent =
      body['parentFolderId'] === null ? null : requiredString(body['parentFolderId']);
    if (targetParent) await folder(targetParent);
    const current = kind === 'FOLDER' ? await folder(id) : await task(id);
    assertBaseVersion(current.version, baseVersion);
    const nextRankValue = nextRank([
      ...(await db.folders.toArray())
        .filter((candidate) => candidate.parentFolderId === targetParent && candidate.id !== id)
        .map((candidate) => ({ rank: candidate.rank })),
      ...(await db.tasks.toArray())
        .map((candidate) => candidate as LocalTreeTask)
        .filter((candidate) => candidate.parentFolderId === targetParent && candidate.id !== id)
        .map((candidate) => ({ rank: candidate.rank })),
    ]);
    const next = {
      ...current,
      parentFolderId: targetParent,
      rank: nextRankValue,
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'tree.move',
      id,
      current.version,
      { ...payload, item: { kind, id }, parentFolderId: targetParent },
      async () => {
        if (kind === 'FOLDER') await db.folders.put(next as LocalFolder);
        else await db.tasks.put(next as LocalTreeTask);
        return next;
      },
    );
  }

  // Deleting a whole folder tree is online-only: it is irreversible and needs a
  // server-signed preview token. Fail closed here so the user sees clear
  // guidance instead of a generic network error. This must run before the
  // DELETE guard because the UI previews first.
  if (method === 'POST' && /^\/folders\/[^/]+\/delete-preview$/.test(path)) {
    throw new ApiError(
      'OFFLINE_TREE_DELETE_FORBIDDEN',
      '离线状态禁止删除整棵目录及其内容；请恢复网络并在线预览后再执行永久删除。',
      { suggestion: 'RETRY_ONLINE' },
      400,
    );
  }
  if (method === 'DELETE' && /^\/folders\/[^/]+\/tree$/.test(path)) {
    throw new ApiError(
      'OFFLINE_TREE_DELETE_FORBIDDEN',
      '离线状态禁止删除整棵目录及其内容；请恢复网络并在线预览后再执行永久删除。',
      { suggestion: 'RETRY_ONLINE' },
      400,
    );
  }

  // Batch rollover needs the authoritative set of the source date's active
  // placements, which offline cache cannot prove is current. Refuse rather than
  // create a divergent local batch that would later conflict on sync.
  if (method === 'POST' && /^\/dates\/[^/]+\/rollover$/.test(path)) {
    throw new ApiError(
      'OFFLINE_ROLLOVER_FORBIDDEN',
      '离线状态无法批量安排到明天；请恢复网络后重试。',
      { suggestion: 'RETRY_ONLINE' },
      400,
    );
  }
  if (method === 'POST' && path === '/rollovers/undo') {
    throw new ApiError(
      'OFFLINE_ROLLOVER_FORBIDDEN',
      '离线状态无法撤销批量安排；请恢复网络后重试。',
      { suggestion: 'RETRY_ONLINE' },
      400,
    );
  }

  if (method === 'POST' && path === '/tasks') {
    const id = typeof body['id'] === 'string' ? body['id'] : uuidv7();
    const parentFolderId =
      body['parentFolderId'] === null ? null : requiredString(body['parentFolderId']);
    const title = boundedTrimmedString(body['title'], 500, '任务标题无效');
    const tasks = (await db.tasks.toArray()).map((candidate) => candidate as LocalTreeTask);
    const created: LocalTreeTask = {
      id,
      referenceId: `TASK-LOCAL-${id.slice(-8)}`,
      parentFolderId,
      title,
      status: 'TODO',
      rank: nextRank(tasks.filter((candidate) => candidate.parentFolderId === parentFolderId)),
      version: 1,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
    const note: LocalNote = {
      id: uuidv7(),
      taskId: id,
      contentMarkdown: '',
      version: 1,
      updatedAt: now,
      pendingSync: true,
    };
    return enqueueV2(
      'task.create',
      id,
      null,
      { parentFolderId, title, __localNoteId: note.id },
      async () => {
        await db.tasks.put(created);
        await db.notes.put(note);
        return { task: created, note };
      },
    );
  }

  const taskUpdate = /^\/tasks\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && taskUpdate) {
    const current = await task(taskUpdate[1]!);
    assertBaseVersion(current.version, baseVersion);
    const nextStatus =
      body['status'] === 'TODO' || body['status'] === 'IN_PROGRESS' || body['status'] === 'DONE'
        ? body['status']
        : current.status;
    const next: LocalTreeTask = {
      ...current,
      title:
        body['title'] === undefined
          ? current.title
          : boundedTrimmedString(body['title'], 500, '任务标题无效'),
      status: nextStatus,
      completedAt: nextStatus === 'DONE' ? (current.completedAt ?? timestamp()) : null,
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'task.update',
      current.id,
      current.version,
      { title: next.title, status: next.status },
      async () => {
        await db.tasks.put(next);
        return next;
      },
    );
  }
  const taskNote = /^\/tasks\/([^/]+)\/note$/.exec(path);
  if (method === 'PATCH' && taskNote) {
    const note = await db.notes.where('taskId').equals(taskNote[1]!).first();
    if (!note) throw new Error('本地备注不存在');
    assertBaseVersion(note.version, baseVersion);
    const next: LocalNote = {
      ...note,
      contentMarkdown: markdownString(body['contentMarkdown']),
      version: note.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'note.update',
      taskNote[1]!,
      note.version,
      { taskId: taskNote[1], contentMarkdown: next.contentMarkdown },
      async () => {
        await db.notes.put(next);
        return next;
      },
    );
  }
  const taskDelete = /^\/tasks\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && taskDelete) {
    const current = await task(taskDelete[1]!);
    assertBaseVersion(current.version, baseVersion);
    const deletedAt = timestamp();
    const notes = (await db.notes.where('taskId').equals(current.id).toArray()) as LocalNote[];
    const steps = (await db.taskSteps.where('taskId').equals(current.id).toArray()).filter(
      (step) => !step.deletedAt,
    );
    const placements = (await db.placements.where('taskId').equals(current.id).toArray()).filter(
      (placement) => !placement.deletedAt,
    );
    const memberships = (await db.workflowTaskMemberships.toArray()).filter(
      (membership) => membership.taskId === current.id && !membership.deletedAt,
    );
    const next: LocalTreeTask = {
      ...current,
      deletedAt,
      version: current.version + 1,
      updatedAt: deletedAt,
      pendingSync: true,
    };
    return enqueueV2('task.delete', current.id, current.version, {}, async () => {
      await db.tasks.put(next);
      await db.notes.bulkPut(
        notes.map((note) => ({
          ...note,
          deletedAt,
          version: note.version + 1,
          updatedAt: deletedAt,
          pendingSync: true,
        })),
      );
      await db.taskSteps.bulkPut(
        steps.map((step) => ({
          ...step,
          deletedAt,
          version: step.version + 1,
          updatedAt: deletedAt,
          pendingSync: true,
        })),
      );
      await db.placements.bulkPut(
        placements.map((placement) => ({
          ...placement,
          deletedAt,
          version: placement.version + 1,
          updatedAt: deletedAt,
          pendingSync: true,
        })),
      );
      await db.workflowTaskMemberships.bulkPut(
        memberships.map((membership) => ({
          ...membership,
          deletedAt,
          version: membership.version + 1,
          updatedAt: deletedAt,
          pendingSync: true,
        })),
      );
      return next;
    });
  }
  const taskDuplicate = /^\/tasks\/([^/]+)\/duplicate$/.exec(path);
  if (method === 'POST' && taskDuplicate) {
    const source = await task(taskDuplicate[1]!);
    const sourceNote = await db.notes.where('taskId').equals(source.id).first();
    const copiedTaskId = uuidv7();
    const copiedNoteId = uuidv7();
    const sourceSteps = (await db.taskSteps.where('taskId').equals(source.id).toArray()).filter(
      (step) => !step.deletedAt,
    );
    const copiedStepIds = sourceSteps.map(() => uuidv7());
    const copiedTask: LocalTreeTask = {
      ...source,
      id: copiedTaskId,
      referenceId: `TASK-LOCAL-${copiedTaskId.slice(-8)}`,
      title: source.title,
      status: 'TODO',
      rank: nextRank(
        (await db.tasks.toArray())
          .map((candidate) => candidate as LocalTreeTask)
          .filter((candidate) => candidate.parentFolderId === source.parentFolderId),
      ),
      version: 1,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
    const copiedNote: LocalNote = {
      id: copiedNoteId,
      taskId: copiedTaskId,
      contentMarkdown: sourceNote?.contentMarkdown ?? '',
      version: 1,
      updatedAt: now,
      pendingSync: true,
    };
    const copiedSteps: LocalTaskStep[] = sourceSteps.map((step, index) => ({
      ...step,
      id: copiedStepIds[index]!,
      taskId: copiedTaskId,
      status: 'TODO',
      completedAt: null,
      rank: String((index + 1) * 1024),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pendingSync: true,
    }));
    return enqueueV2(
      'task.duplicate',
      source.id,
      null,
      {
        taskId: copiedTaskId,
        noteId: copiedNoteId,
        stepIds: copiedStepIds,
        __localTaskId: copiedTaskId,
        __localNoteId: copiedNoteId,
      },
      async () => {
        await db.tasks.put(copiedTask);
        await db.notes.put(copiedNote);
        await db.taskSteps.bulkPut(copiedSteps);
        return { task: copiedTask, note: copiedNote, steps: copiedSteps };
      },
    );
  }

  const taskSteps = /^\/tasks\/([^/]+)\/steps$/.exec(path);
  if (method === 'POST' && taskSteps) {
    const taskRow = await task(taskSteps[1]!);
    const id = typeof body['id'] === 'string' ? body['id'] : uuidv7();
    const title = boundedTrimmedString(body['title'], 500, '步骤标题无效');
    const noteMarkdown = markdownString(body['noteMarkdown'] ?? '');
    const step: LocalTaskStep = {
      id,
      taskId: taskRow.id,
      title,
      noteMarkdown,
      status: 'TODO',
      rank: nextRank(await db.taskSteps.where('taskId').equals(taskRow.id).toArray()),
      completedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pendingSync: true,
    };
    return enqueueV2(
      'taskStep.create',
      id,
      null,
      { taskId: taskRow.id, title, noteMarkdown },
      async () => {
        await db.taskSteps.put(step);
        return step;
      },
    );
  }
  const stepUpdate = /^\/task-steps\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && stepUpdate) {
    const current = await db.taskSteps.get(stepUpdate[1]!);
    if (!current || current.deletedAt) throw new Error('本地步骤不存在');
    assertBaseVersion(current.version, baseVersion);
    const nextStatus =
      body['status'] === 'TODO' || body['status'] === 'IN_PROGRESS' || body['status'] === 'DONE'
        ? body['status']
        : current.status;
    const next: LocalTaskStep = {
      ...current,
      title:
        body['title'] === undefined
          ? current.title
          : boundedTrimmedString(body['title'], 500, '步骤标题无效'),
      noteMarkdown:
        body['noteMarkdown'] === undefined
          ? current.noteMarkdown
          : markdownString(body['noteMarkdown']),
      status: nextStatus,
      completedAt: nextStatus === 'DONE' ? (current.completedAt ?? timestamp()) : null,
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'taskStep.update',
      current.id,
      current.version,
      { title: next.title, noteMarkdown: next.noteMarkdown, status: next.status },
      async () => {
        await db.taskSteps.put(next);
        return next;
      },
    );
  }
  const stepMove = /^\/task-steps\/([^/]+)\/move$/.exec(path);
  if (method === 'POST' && stepMove) {
    const current = await db.taskSteps.get(stepMove[1]!);
    if (!current || current.deletedAt) throw new Error('本地步骤不存在');
    assertBaseVersion(current.version, baseVersion);
    const beforeId =
      body['beforeId'] === null
        ? null
        : typeof body['beforeId'] === 'string'
          ? body['beforeId']
          : undefined;
    const afterId =
      body['afterId'] === null
        ? null
        : typeof body['afterId'] === 'string'
          ? body['afterId']
          : undefined;
    const siblings = (await db.taskSteps.where('taskId').equals(current.taskId).toArray()).filter(
      (step) => step.id !== current.id && !step.deletedAt,
    );
    const next: LocalTaskStep = {
      ...current,
      rank: rankForMove(siblings, beforeId, afterId),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'taskStep.move',
      current.id,
      current.version,
      { beforeId, afterId },
      async () => {
        await db.taskSteps.put(next);
        return next;
      },
    );
  }
  const stepDelete = /^\/task-steps\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && stepDelete) {
    const current = await db.taskSteps.get(stepDelete[1]!);
    if (!current || current.deletedAt) throw new Error('本地步骤不存在');
    assertBaseVersion(current.version, baseVersion);
    const next: LocalTaskStep = {
      ...current,
      deletedAt: timestamp(),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2('taskStep.delete', current.id, current.version, {}, async () => {
      await db.taskSteps.put(next);
      return next;
    });
  }

  if (method === 'POST' && path === '/workflows') {
    const id = typeof body['id'] === 'string' ? body['id'] : uuidv7();
    const stageId = uuidv7();
    const name = boundedTrimmedString(body['name'], 200, '流程名称无效');
    const workflow: LocalWorkflow = {
      id,
      name,
      rank: nextRank(await db.workflows.toArray()),
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
    const stage: LocalWorkflowStage = {
      id: stageId,
      workflowId: id,
      name: '阶段 1',
      rank: '1024',
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pendingSync: true,
    };
    return enqueueV2('workflow.create', id, null, { name, defaultStageId: stageId }, async () => {
      await db.workflows.put(workflow);
      await db.workflowStages.put(stage);
      return { ...workflow, stages: [{ ...stage, tasks: [] }] };
    });
  }
  const workflowUpdate = /^\/workflows\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && workflowUpdate) {
    const current = await db.workflows.get(workflowUpdate[1]!);
    if (!current || current.deletedAt) throw new Error('本地流程不存在');
    assertBaseVersion(current.version, baseVersion);
    const next: LocalWorkflow = {
      ...current,
      name: boundedTrimmedString(body['name'], 200, '流程名称无效'),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'workflow.update',
      current.id,
      current.version,
      { name: next.name },
      async () => {
        await db.workflows.put(next);
        return next;
      },
    );
  }
  const workflowDelete = /^\/workflows\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && workflowDelete) {
    const current = await db.workflows.get(workflowDelete[1]!);
    if (!current || current.deletedAt) throw new Error('本地流程不存在');
    assertBaseVersion(current.version, baseVersion);
    const at = timestamp();
    const next: LocalWorkflow = {
      ...current,
      deletedAt: at,
      version: current.version + 1,
      updatedAt: at,
      pendingSync: true,
    };
    return enqueueV2('workflow.delete', current.id, current.version, {}, async () => {
      await db.workflows.put(next);
      const stages = await db.workflowStages.where('workflowId').equals(current.id).toArray();
      const stageIds = new Set(stages.map((stage) => stage.id));
      await db.workflowStages.bulkPut(
        stages.map((stage) => ({
          ...stage,
          deletedAt: at,
          version: stage.version + 1,
          updatedAt: at,
          pendingSync: true,
        })),
      );
      const memberships = (
        await db.workflowTaskMemberships.where('workflowId').equals(current.id).toArray()
      ).filter((membership) => stageIds.has(membership.stageId));
      await db.workflowTaskMemberships.bulkPut(
        memberships.map((membership) => ({
          ...membership,
          deletedAt: at,
          version: membership.version + 1,
          updatedAt: at,
          pendingSync: true,
        })),
      );
      return next;
    });
  }
  const workflowStages = /^\/workflows\/([^/]+)\/stages$/.exec(path);
  if (method === 'POST' && workflowStages) {
    const workflow = await db.workflows.get(workflowStages[1]!);
    if (!workflow || workflow.deletedAt) throw new Error('本地流程不可用');
    const id = typeof body['id'] === 'string' ? body['id'] : uuidv7();
    const name = boundedTrimmedString(body['name'], 200, '阶段名称无效');
    const stage: LocalWorkflowStage = {
      id,
      workflowId: workflow.id,
      name,
      rank: nextRank(await db.workflowStages.where('workflowId').equals(workflow.id).toArray()),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pendingSync: true,
    };
    return enqueueV2(
      'workflowStage.create',
      id,
      null,
      { workflowId: workflow.id, name },
      async () => {
        await db.workflowStages.put(stage);
        return stage;
      },
    );
  }
  const stageUpdate = /^\/workflow-stages\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && stageUpdate) {
    const current = await db.workflowStages.get(stageUpdate[1]!);
    if (!current || current.deletedAt) throw new Error('本地阶段不存在');
    assertBaseVersion(current.version, baseVersion);
    const next: LocalWorkflowStage = {
      ...current,
      name: boundedTrimmedString(body['name'], 200, '阶段名称无效'),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'workflowStage.update',
      current.id,
      current.version,
      { name: next.name },
      async () => {
        await db.workflowStages.put(next);
        return next;
      },
    );
  }
  const stageMove = /^\/workflow-stages\/([^/]+)\/move$/.exec(path);
  if (method === 'POST' && stageMove) {
    const current = await db.workflowStages.get(stageMove[1]!);
    const beforeId =
      body['beforeId'] === null
        ? null
        : typeof body['beforeId'] === 'string'
          ? body['beforeId']
          : undefined;
    const afterId =
      body['afterId'] === null
        ? null
        : typeof body['afterId'] === 'string'
          ? body['afterId']
          : undefined;
    if (!current || current.deletedAt) throw new Error('本地阶段不存在');
    assertBaseVersion(current.version, baseVersion);
    const siblings = (
      await db.workflowStages.where('workflowId').equals(current.workflowId).toArray()
    ).filter((stage) => stage.id !== current.id && !stage.deletedAt);
    const next: LocalWorkflowStage = {
      ...current,
      rank: rankForMove(siblings, beforeId, afterId),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'workflowStage.move',
      current.id,
      current.version,
      { beforeId, afterId },
      async () => {
        await db.workflowStages.put(next);
        return next;
      },
    );
  }
  const stageDelete = /^\/workflow-stages\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && stageDelete) {
    const current = await db.workflowStages.get(stageDelete[1]!);
    if (!current || current.deletedAt) throw new Error('本地阶段不存在');
    assertBaseVersion(current.version, baseVersion);
    const at = timestamp();
    const next: LocalWorkflowStage = {
      ...current,
      deletedAt: at,
      version: current.version + 1,
      updatedAt: at,
      pendingSync: true,
    };
    return enqueueV2('workflowStage.delete', current.id, current.version, {}, async () => {
      await db.workflowStages.put(next);
      const memberships = await db.workflowTaskMemberships
        .where('stageId')
        .equals(current.id)
        .toArray();
      await db.workflowTaskMemberships.bulkPut(
        memberships.map((membership) => ({
          ...membership,
          deletedAt: at,
          version: membership.version + 1,
          updatedAt: at,
          pendingSync: true,
        })),
      );
      return next;
    });
  }
  const addWorkflowTask = /^\/workflow-stages\/([^/]+)\/tasks$/.exec(path);
  if (method === 'POST' && addWorkflowTask) {
    const stage = await db.workflowStages.get(addWorkflowTask[1]!);
    const taskRow = typeof body['taskId'] === 'string' ? await task(body['taskId']) : null;
    if (!stage || stage.deletedAt || !taskRow) throw new Error('流程阶段或任务不可用');
    const workflow = await db.workflows.get(stage.workflowId);
    if (!workflow || workflow.deletedAt) throw new Error('本地流程不可用');
    const duplicate = (
      await db.workflowTaskMemberships.where('workflowId').equals(workflow.id).toArray()
    ).find((membership) => membership.taskId === taskRow.id && !membership.deletedAt);
    if (duplicate) return { value: duplicate };
    const id = typeof body['id'] === 'string' ? body['id'] : uuidv7();
    const membership: LocalWorkflowTaskMembership = {
      id,
      workflowId: workflow.id,
      stageId: stage.id,
      taskId: taskRow.id,
      rank: nextRank(await db.workflowTaskMemberships.where('stageId').equals(stage.id).toArray()),
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pendingSync: true,
    };
    return enqueueV2(
      'workflowTask.add',
      id,
      null,
      { workflowId: workflow.id, stageId: stage.id, taskId: taskRow.id },
      async () => {
        await db.workflowTaskMemberships.put(membership);
        return membership;
      },
    );
  }
  const membershipMove = /^\/workflow-memberships\/([^/]+)\/move$/.exec(path);
  if (method === 'POST' && membershipMove) {
    const current = await db.workflowTaskMemberships.get(membershipMove[1]!);
    const stageId = requiredString(body['stageId']);
    const stage = await db.workflowStages.get(stageId);
    if (
      !current ||
      current.deletedAt ||
      !stage ||
      stage.deletedAt ||
      stage.workflowId !== current.workflowId
    )
      throw new Error('目标流程阶段无效');
    assertBaseVersion(current.version, baseVersion);
    const beforeId =
      body['beforeId'] === null
        ? null
        : typeof body['beforeId'] === 'string'
          ? body['beforeId']
          : undefined;
    const afterId =
      body['afterId'] === null
        ? null
        : typeof body['afterId'] === 'string'
          ? body['afterId']
          : undefined;
    const siblings = await db.workflowTaskMemberships.where('stageId').equals(stageId).toArray();
    const next: LocalWorkflowTaskMembership = {
      ...current,
      stageId,
      rank: rankForMove(siblings, beforeId, afterId),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'workflowTask.move',
      current.id,
      current.version,
      { stageId, beforeId, afterId },
      async () => {
        await db.workflowTaskMemberships.put(next);
        return next;
      },
    );
  }
  const membershipDelete = /^\/workflow-memberships\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && membershipDelete) {
    const current = await db.workflowTaskMemberships.get(membershipDelete[1]!);
    if (!current || current.deletedAt) throw new Error('本地流程任务不存在');
    assertBaseVersion(current.version, baseVersion);
    const next: LocalWorkflowTaskMembership = {
      ...current,
      deletedAt: timestamp(),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2('workflowTask.remove', current.id, current.version, {}, async () => {
      await db.workflowTaskMemberships.put(next);
      return next;
    });
  }

  if (method === 'POST' && path === '/time-points/date') {
    const localDate = requiredString(body['localDate']);
    validateLocalDate(localDate);
    const existing = (await db.timePoints.toArray()).find(
      (point) => point.type === 'DATE' && point.localDate === localDate && !point.deletedAt,
    );
    if (existing) return { value: existing };
    const point = createLocalTimePoint(uuidv7(), 'DATE', localDate, undefined, now);
    return enqueueV2('timePoint.date.create', point.id, null, { localDate }, async () => {
      await db.timePoints.put({ ...point, pendingSync: true });
      return point;
    });
  }
  if (method === 'POST' && path === '/time-points/events') {
    const point = createLocalTimePoint(
      uuidv7(),
      'EVENT',
      undefined,
      boundedTrimmedString(body['title'], 200, '时间点名称无效'),
      now,
    );
    return enqueueV2('timePoint.event.create', point.id, null, { title: point.title }, async () => {
      await db.timePoints.put({ ...point, pendingSync: true });
      return point;
    });
  }
  const pointUpdate = /^\/time-points\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && pointUpdate) {
    const current = await db.timePoints.get(pointUpdate[1]!);
    if (!current || current.type !== 'EVENT') throw new Error('本地事件不存在');
    assertBaseVersion(current.version, baseVersion);
    const next: LocalTimePoint = {
      ...current,
      title: boundedTrimmedString(body['title'], 200, '时间点名称无效'),
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      'timePoint.update',
      current.id,
      current.version,
      { title: next.title },
      async () => {
        await db.timePoints.put(next);
        return next;
      },
    );
  }
  const pointAction = /^\/time-points\/([^/]+)\/(reach)$/.exec(path);
  if (method === 'POST' && pointAction) {
    const current = await db.timePoints.get(pointAction[1]!);
    if (!current || current.type !== 'EVENT') throw new Error('本地事件不存在');
    assertBaseVersion(current.version, baseVersion);
    const action = pointAction[2]!;
    const next: LocalTimePoint = {
      ...current,
      reachedAt: action === 'reach' ? (current.reachedAt ?? timestamp()) : current.reachedAt,
      version: current.version + 1,
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(`timePoint.${action}`, current.id, current.version, {}, async () => {
      await db.timePoints.put(next);
      return next;
    });
  }
  const pointDelete = /^\/time-points\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && pointDelete) {
    const current = await db.timePoints.get(pointDelete[1]!);
    if (!current || current.type !== 'EVENT') throw new Error('本地事件不存在');
    assertBaseVersion(current.version, baseVersion);
    const at = timestamp();
    const next: LocalTimePoint = {
      ...current,
      deletedAt: at,
      version: current.version + 1,
      updatedAt: at,
      pendingSync: true,
    };
    return enqueueV2('timePoint.delete', current.id, current.version, {}, async () => {
      await db.timePoints.put(next);
      const placements = await db.placements
        .where('timePointId')
        .equals(current.id)
        .toArray()
        .then((rows) => rows.filter((row) => !row.deletedAt));
      await db.placements.bulkPut(
        placements.map((placement) => ({
          ...placement,
          deletedAt: at,
          version: placement.version + 1,
          updatedAt: at,
          pendingSync: true,
        })),
      );
      return next;
    });
  }
  if (method === 'POST' && path === '/time-points/events/reorder') {
    const ids = requiredStringArray(body['ids']);
    const points = await db.timePoints.toArray();
    const selected = ids.map((id) => points.find((point) => point.id === id));
    if (selected.some((point) => !point || point.type !== 'EVENT'))
      throw new Error('本地事件不存在');
    return enqueueV2('timePoint.reorder', clientId, null, { ids }, async () => {
      const updated = selected.map((point, index) => ({
        ...point!,
        rank: String((index + 1) * 1024),
        version: point!.version + 1,
        updatedAt: timestamp(),
        pendingSync: true,
      }));
      await db.timePoints.bulkPut(updated);
      return updated;
    });
  }

  if (method === 'POST' && path === '/placements') {
    const taskId = requiredString(body['taskId']);
    const timePointId = requiredString(body['timePointId']);
    const taskRow = await task(taskId);
    const point = await db.timePoints.get(timePointId);
    if (taskRow.deletedAt || !point || point.deletedAt) throw new Error('任务或时间点不可安排');
    const existing = (await db.placements.toArray()).find(
      (candidate) => candidate.taskId === taskId && candidate.timePointId === timePointId,
    );
    if (existing) return { value: existing };
    const placement: LocalPlacement = {
      id: uuidv7(),
      taskId,
      timePointId,
      rank: nextRank(
        (await db.placements.toArray()).filter(
          (candidate) => candidate.timePointId === timePointId,
        ),
      ),
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
    return enqueueV2('placement.create', placement.id, null, { taskId, timePointId }, async () => {
      await db.placements.put(placement);
      return { placement, existed: false };
    });
  }
  const placementDelete = /^\/placements\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && placementDelete) {
    const current = await db.placements.get(placementDelete[1]!);
    if (!current) throw new Error('本地安排不存在');
    assertBaseVersion(current.version, baseVersion);
    return enqueueV2('placement.remove', current.id, current.version, {}, async () => {
      await db.placements.delete(current.id);
      return current;
    });
  }
  const placementAction = /^\/placements\/([^/]+)\/(move|copy)$/.exec(path);
  if (method === 'POST' && placementAction) {
    const current = await db.placements.get(placementAction[1]!);
    const targetTimePointId = requiredString(body['timePointId']);
    if (!current) throw new Error('本地安排不存在');
    const target = await db.timePoints.get(targetTimePointId);
    if (!target || target.deletedAt) throw new Error('目标时间点不可用');
    if (placementAction[2] === 'move') assertBaseVersion(current.version, baseVersion);
    const duplicate = (await db.placements.toArray()).find(
      (candidate) =>
        candidate.taskId === current.taskId && candidate.timePointId === targetTimePointId,
    );
    if (duplicate && placementAction[2] === 'copy') return { value: duplicate };
    const next: LocalPlacement = duplicate ?? {
      id: uuidv7(),
      taskId: current.taskId,
      timePointId: targetTimePointId,
      rank: nextRank(
        (await db.placements.toArray()).filter(
          (candidate) => candidate.timePointId === targetTimePointId,
        ),
      ),
      version: 1,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      pendingSync: true,
    };
    return enqueueV2(
      `placement.${placementAction[2]}`,
      current.id,
      placementAction[2] === 'move' ? current.version : null,
      { timePointId: targetTimePointId, __localId: next.id },
      async () => {
        if (!duplicate) await db.placements.put(next);
        if (placementAction[2] === 'move') await db.placements.delete(current.id);
        return { placement: next, existed: Boolean(duplicate) };
      },
    );
  }
  const placementReorder = /^\/time-points\/([^/]+)\/placements\/reorder$/.exec(path);
  if (method === 'POST' && placementReorder) {
    const ids = requiredStringArray(body['ids']);
    const placements = await db.placements.toArray();
    const selected = ids.map((id) => placements.find((placement) => placement.id === id));
    if (selected.some((placement) => !placement || placement.timePointId !== placementReorder[1]))
      throw new Error('本地安排不存在');
    return enqueueV2(
      'placement.reorder',
      placementReorder[1]!,
      null,
      { timePointId: placementReorder[1], ids },
      async () => {
        const updated = selected.map((placement, index) => ({
          ...placement!,
          rank: String((index + 1) * 1024),
          version: placement!.version + 1,
          updatedAt: timestamp(),
          pendingSync: true,
        }));
        await db.placements.bulkPut(updated);
        return updated;
      },
    );
  }

  if (method === 'PATCH' && path === '/settings') {
    const current = await db.settings.toCollection().first();
    if (!current) throw new Error('本地设置不存在');
    assertBaseVersion(current.version, baseVersion);
    const target = body['defaultCaptureTarget'];
    if (target !== undefined && target !== 'ROOT' && target !== 'RECENT_FOLDER')
      throw new Error('默认捕获位置无效');
    const next: V2SettingsDto = {
      ...current,
      timezone: typeof body['timezone'] === 'string' ? body['timezone'] : current.timezone,
      weekStartsOn:
        body['weekStartsOn'] === 0 || body['weekStartsOn'] === 1
          ? body['weekStartsOn']
          : current.weekStartsOn,
      defaultCaptureTarget:
        target === 'ROOT' || target === 'RECENT_FOLDER'
          ? target
          : (current.defaultCaptureTarget as V2SettingsDto['defaultCaptureTarget']),
      version: current.version + 1,
      updatedAt: timestamp(),
    };
    return enqueueV2(
      'settings.update',
      current.ownerId,
      current.version,
      {
        timezone: next.timezone,
        weekStartsOn: next.weekStartsOn,
        defaultCaptureTarget: next.defaultCaptureTarget,
      },
      async () => {
        await db.settings.put(next);
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
  const [pathname = ''] = path.split('?');
  if (pathname.startsWith('/v2/')) {
    await cacheV2ResponseInTransaction(db, pathname, value);
    return;
  }
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
  if (/^\/tasks\/[^/]+$/.test(pathname ?? '') && isRecord(value) && isTaskDto(value)) {
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
  const timePointAction = /^\/time-points\/[^/]+\/(reach)$/.exec(pathname ?? '');
  if (timePointAction && isTimePointDto(value)) {
    await db.timePoints.put(value as TimePointDto);
    return;
  }
  if (/^\/time-points\/[^/]+$/.test(pathname ?? '') && isRecord(value)) {
    await db.timePoints.put(value as unknown as TimePointDto);
  }
}

async function cacheV2ResponseInTransaction(
  db: DevTodoDatabase,
  pathname: string,
  value: unknown,
): Promise<void> {
  if (!isRecord(value)) return;
  if (pathname === '/v2/settings') {
    await db.settings.put(value as unknown as SettingsDto);
    return;
  }
  if (pathname === '/v2/sync/snapshot') {
    await putV2Snapshot(db, value);
    return;
  }
  const items = value['items'];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item['kind'] === 'FOLDER' && isRecord(item['folder']))
        await db.folders.put(item['folder'] as unknown as LocalFolder);
      else if (item['kind'] === 'TASK' && isRecord(item['task']))
        await db.tasks.put(item['task'] as unknown as LocalTreeTask);
      else if (typeof item['taskId'] === 'string' && typeof item['timePointId'] === 'string')
        await db.placements.put(item as unknown as LocalPlacement);
      else if (typeof item['id'] === 'string' && typeof item['type'] === 'string')
        await db.timePoints.put(item as unknown as LocalTimePoint);
      else if (
        typeof item['parentFolderId'] !== 'undefined' &&
        typeof item['status'] === 'string' &&
        typeof item['title'] === 'string'
      )
        await db.tasks.put(item as unknown as LocalTreeTask);
      else if (
        typeof item['parentFolderId'] !== 'undefined' &&
        typeof item['title'] === 'string' &&
        typeof item['rank'] === 'string'
      )
        await db.folders.put(item as unknown as LocalFolder);
      else if (typeof item['workflowId'] === 'string' && typeof item['taskId'] === 'string')
        await db.workflowTaskMemberships.put(item as unknown as LocalWorkflowTaskMembership);
      else if (typeof item['workflowId'] === 'string' && typeof item['name'] === 'string')
        await db.workflowStages.put(item as unknown as LocalWorkflowStage);
      else if (typeof item['name'] === 'string' && typeof item['rank'] === 'string')
        await db.workflows.put(item as unknown as LocalWorkflow);
    }
  }
  if (isRecord(value['task'])) await db.tasks.put(value['task'] as unknown as LocalTreeTask);
  if (isRecord(value['note'])) await db.notes.put(value['note'] as unknown as LocalNote);
  if (Array.isArray(value['steps'])) await db.taskSteps.bulkPut(value['steps'] as LocalTaskStep[]);
  if (Array.isArray(value['placements']))
    await db.placements.bulkPut(value['placements'] as LocalPlacement[]);
  if (isRecord(value['folder'])) await db.folders.put(value['folder'] as unknown as LocalFolder);
  if (isRecord(value['placement']))
    await db.placements.put(value['placement'] as unknown as LocalPlacement);
  if (isRecord(value['workflow']))
    await db.workflows.put(value['workflow'] as unknown as LocalWorkflow);
  if (isRecord(value['stage']))
    await db.workflowStages.put(value['stage'] as unknown as LocalWorkflowStage);
  if (isRecord(value['membership']))
    await db.workflowTaskMemberships.put(
      value['membership'] as unknown as LocalWorkflowTaskMembership,
    );
  if (typeof value['id'] === 'string' && typeof value['type'] === 'string' && 'localDate' in value)
    await db.timePoints.put(value as unknown as LocalTimePoint);
  if (
    typeof value['id'] === 'string' &&
    typeof value['parentFolderId'] !== 'undefined' &&
    typeof value['title'] === 'string' &&
    typeof value['status'] === 'string'
  )
    await db.tasks.put(value as unknown as LocalTreeTask);
}

async function putV2Snapshot(db: DevTodoDatabase, value: Record<string, unknown>): Promise<void> {
  const folders = Array.isArray(value['folders']) ? (value['folders'] as LocalFolder[]) : [];
  const tasks = Array.isArray(value['tasks']) ? (value['tasks'] as LocalTreeTask[]) : [];
  const notes = Array.isArray(value['notes']) ? (value['notes'] as LocalNote[]) : [];
  const taskSteps = Array.isArray(value['taskSteps'])
    ? (value['taskSteps'] as LocalTaskStep[])
    : [];
  const timePoints = Array.isArray(value['timePoints'])
    ? (value['timePoints'] as LocalTimePoint[])
    : [];
  const placements = Array.isArray(value['placements'])
    ? (value['placements'] as LocalPlacement[])
    : [];
  const workflows = Array.isArray(value['workflows'])
    ? (value['workflows'] as LocalWorkflow[])
    : [];
  const workflowStages = Array.isArray(value['workflowStages'])
    ? (value['workflowStages'] as LocalWorkflowStage[])
    : [];
  const workflowTaskMemberships = Array.isArray(value['workflowTaskMemberships'])
    ? (value['workflowTaskMemberships'] as LocalWorkflowTaskMembership[])
    : [];
  await db.folders.bulkPut(folders);
  await db.tasks.bulkPut(tasks);
  await db.notes.bulkPut(notes);
  await db.taskSteps.bulkPut(taskSteps);
  await db.timePoints.bulkPut(timePoints);
  await db.placements.bulkPut(placements);
  await db.workflows.bulkPut(workflows);
  await db.workflowStages.bulkPut(workflowStages);
  await db.workflowTaskMemberships.bulkPut(workflowTaskMemberships);
  if (isRecord(value['settings']))
    await db.settings.put(value['settings'] as unknown as SettingsDto);
  if (typeof value['cursor'] === 'string')
    await db.syncMeta.put({ key: 'v2:cursor', value: value['cursor'] });
}

async function readLocalInTransaction(db: DevTodoDatabase, path: string): Promise<unknown> {
  const [pathname = '', query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if (pathname.startsWith('/v2/')) return readV2LocalInTransaction(db, pathname.slice(3), params);
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
    const projects = (await db.projects.toArray()).filter((project) => !project.deletedAt);
    const counts = new Map(
      projects.map((project) => [
        project.id,
        { projectId: project.id, openCount: 0, doneCount: 0 },
      ]),
    );
    for (const task of await db.tasks.toArray()) {
      if (task.deletedAt || !task.projectId) continue;
      const count = counts.get(task.projectId);
      if (!count) continue;
      if (task.status === 'DONE') count.doneCount += 1;
      else count.openCount += 1;
    }
    return { items: projects.map((project) => counts.get(project.id)) };
  }
  if (pathname === '/projects') {
    const items = (await db.projects.toArray()).filter((project) => !project.deletedAt);
    return { items: sortByRank(items), nextCursor: null };
  }
  if (pathname === '/tasks') {
    let items = await db.tasks.toArray();
    if (params.has('projectId')) {
      const projectId = params.get('projectId');
      items = items.filter((task) => task.projectId === (projectId === 'null' ? null : projectId));
    }
    if (params.has('category'))
      items = items.filter((task) => task.category === params.get('category'));
    if (params.has('status')) items = items.filter((task) => task.status === params.get('status'));
    items = items.filter((task) => !task.deletedAt);
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
        .filter((task) => !task.deletedAt)
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
    items = items.filter((point) => !point.deletedAt);
    return { items: items.sort(timePointSort), nextCursor: null };
  }
  if (pathname === '/time-points/placement-counts') {
    const type = params.get('type');
    const from = params.get('from');
    const to = params.get('to');
    const points = (await db.timePoints.toArray()).filter(
      (point) =>
        point.type === type &&
        !point.deletedAt &&
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
      if (!count || !task || task.deletedAt) continue;
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

async function readV2LocalInTransaction(
  db: DevTodoDatabase,
  pathname: string,
  params: URLSearchParams,
): Promise<unknown> {
  const folders = (await db.folders.toArray()) as LocalFolder[];
  const tasks = (await db.tasks.toArray())
    .map((row) => row as LocalTreeTask)
    .filter((row) => row.parentFolderId !== undefined);
  const visibleFolder = (folder: LocalFolder) => !folder.deletedAt;
  const visibleTask = (task: LocalTreeTask) => !task.deletedAt;
  const descendantFolders = (rootId: string): Set<string> => {
    const ids = new Set<string>();
    const stack = [rootId];
    while (stack.length) {
      const current = stack.pop()!;
      if (ids.has(current)) continue;
      ids.add(current);
      folders
        .filter((folder) => folder.parentFolderId === current)
        .forEach((folder) => stack.push(folder.id));
    }
    return ids;
  };
  const aggregate = (folderId: string) => {
    const ids = descendantFolders(folderId);
    const counts = { TODO: 0, IN_PROGRESS: 0, DONE: 0 };
    for (const task of tasks)
      if (task.parentFolderId && ids.has(task.parentFolderId) && !task.deletedAt) {
        let parent: string | null = task.parentFolderId;
        let valid = true;
        const seen = new Set<string>();
        while (parent) {
          if (seen.has(parent)) {
            valid = false;
            break;
          }
          seen.add(parent);
          const ancestor = folders.find((candidate) => candidate.id === parent);
          if (!ancestor || ancestor.deletedAt) {
            valid = false;
            break;
          }
          parent = ancestor.parentFolderId;
        }
        if (valid) counts[task.status] += 1;
      }
    const totalCount = counts.TODO + counts.IN_PROGRESS + counts.DONE;
    return {
      status:
        totalCount === 0 || counts.TODO === totalCount
          ? 'TODO'
          : counts.DONE === totalCount
            ? 'DONE'
            : 'IN_PROGRESS',
      todoCount: counts.TODO,
      inProgressCount: counts.IN_PROGRESS,
      doneCount: counts.DONE,
      totalCount,
    };
  };
  if (pathname === '/settings') return db.settings.toCollection().first();
  if (pathname === '/folders')
    return { items: sortByRank(folders.filter(visibleFolder)), nextCursor: null };
  const folderPath = /^\/folders\/([^/]+)\/path$/.exec(pathname);
  if (folderPath) {
    const pathItems: Array<{ id: string; title: string }> = [];
    let current = folders.find((folder) => folder.id === folderPath[1]);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      pathItems.unshift({ id: current.id, title: current.title });
      current = current.parentFolderId
        ? folders.find((folder) => folder.id === current!.parentFolderId)
        : undefined;
    }
    return { items: pathItems };
  }
  if (pathname === '/tree/children') {
    const parentFolderId =
      params.get('parentFolderId') === 'root' ? null : params.get('parentFolderId');
    const items = [
      ...folders
        .filter((folder) => visibleFolder(folder) && folder.parentFolderId === parentFolderId)
        .map((folder) => ({ kind: 'FOLDER' as const, folder, aggregate: aggregate(folder.id) })),
      ...tasks
        .filter((task) => visibleTask(task) && task.parentFolderId === parentFolderId)
        .map((task) => ({ kind: 'TASK' as const, task })),
    ];
    return {
      items: items.sort((left, right) =>
        BigInt(left.kind === 'FOLDER' ? left.folder.rank : left.task.rank) <
        BigInt(right.kind === 'FOLDER' ? right.folder.rank : right.task.rank)
          ? -1
          : 1,
      ),
      parentFolderId,
    };
  }
  if (pathname === '/tasks')
    return { items: sortByRank(tasks.filter(visibleTask)), nextCursor: null };
  const taskDetail = /^\/tasks\/([^/]+)$/.exec(pathname);
  if (taskDetail) {
    const task = tasks.find((candidate) => candidate.id === taskDetail[1]);
    if (!task) return undefined;
    const note = await db.notes.where('taskId').equals(task.id).first();
    const placements = (await db.placements.toArray()).filter(
      (placement) => placement.taskId === task.id,
    );
    const steps = sortByRank(
      (await db.taskSteps.toArray()).filter((step) => step.taskId === task.id && !step.deletedAt),
    );
    const folderItems: Array<{ id: string; title: string }> = [];
    let current = task.parentFolderId
      ? folders.find((folder) => folder.id === task.parentFolderId)
      : undefined;
    while (current) {
      folderItems.unshift({ id: current.id, title: current.title });
      current = current.parentFolderId
        ? folders.find((folder) => folder.id === current!.parentFolderId)
        : undefined;
    }
    const workflowRows = await db.workflows.toArray();
    const stageRows = await db.workflowStages.toArray();
    const workflowMemberships = (await db.workflowTaskMemberships.toArray())
      .filter((membership) => membership.taskId === task.id && !membership.deletedAt)
      .flatMap((membership) => {
        const workflow = workflowRows.find((candidate) => candidate.id === membership.workflowId);
        const stage = stageRows.find((candidate) => candidate.id === membership.stageId);
        return workflow && stage
          ? [
              {
                ...membership,
                workflow: { id: workflow.id, name: workflow.name },
                stage: { id: stage.id, name: stage.name },
              },
            ]
          : [];
      });
    return {
      task,
      note: note ?? {
        id: `local-note-${task.id}`,
        taskId: task.id,
        contentMarkdown: '',
        version: 0,
        updatedAt: task.updatedAt,
      },
      steps,
      placements,
      workflowMemberships,
      folderPath: folderItems,
    };
  }
  if (pathname === '/time-points')
    return {
      items: (await db.timePoints.toArray())
        .filter((point) => params.get('type') === null || point.type === params.get('type'))
        .filter((point) => !point.deletedAt)
        .sort(timePointSort),
    };
  if (pathname === '/time-points/placement-counts') {
    const points = (await db.timePoints.toArray()).filter(
      (point) =>
        (params.get('type') === null || point.type === params.get('type')) &&
        !point.deletedAt &&
        (!params.get('from') || (point.localDate ?? '') >= params.get('from')!) &&
        (!params.get('to') || (point.localDate ?? '') <= params.get('to')!),
    );
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const allPlacements = await db.placements.toArray();
    return {
      items: points.map((point) => {
        const pointPlacements = allPlacements.filter(
          (placement) => placement.timePointId === point.id,
        );
        const doneCount = pointPlacements.filter(
          (placement) => taskMap.get(placement.taskId)?.status === 'DONE',
        ).length;
        return {
          timePointId: point.id,
          localDate: point.localDate,
          totalCount: pointPlacements.length,
          openCount: pointPlacements.length - doneCount,
          doneCount,
        };
      }),
    };
  }
  const pointPlacements = /^\/time-points\/([^/]+)\/placements$/.exec(pathname);
  if (pointPlacements) {
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const items = (await db.placements.where('timePointId').equals(pointPlacements[1]!).toArray())
      .map((placement) => ({ ...placement, task: taskMap.get(placement.taskId) }))
      .filter((item): item is PlacementDto & { task: TreeTaskDto } => Boolean(item.task));
    return { items };
  }
  const pointDetail = /^\/time-points\/([^/]+)$/.exec(pathname);
  if (pointDetail) return db.timePoints.get(pointDetail[1]!);
  if (pathname === '/workflows') {
    const workflows = (await db.workflows.toArray()).filter((workflow) => !workflow.deletedAt);
    const stages = (await db.workflowStages.toArray()).filter((stage) => !stage.deletedAt);
    const memberships = (await db.workflowTaskMemberships.toArray()).filter(
      (membership) => !membership.deletedAt,
    );
    return {
      items: sortByRank(workflows).map((workflow) => ({
        ...workflow,
        stages: sortByRank(stages.filter((stage) => stage.workflowId === workflow.id)).map(
          (stage) => ({
            ...stage,
            memberships: memberships.filter((membership) => membership.stageId === stage.id),
            tasks: sortByRank(
              memberships
                .filter((membership) => membership.stageId === stage.id)
                .flatMap((membership) => {
                  const task = tasks.find((candidate) => candidate.id === membership.taskId);
                  return task ? [task] : [];
                }),
            ),
          }),
        ),
      })),
    };
  }
  if (pathname === '/sync/status')
    return {
      cursor: (await db.syncMeta.get('v2:cursor'))?.value ?? '0',
      oldestCursor: '0',
      protocolVersion: 2,
    };
  if (pathname === '/sync/snapshot') {
    const [
      notes,
      taskSteps,
      timePoints,
      placements,
      workflows,
      workflowStages,
      workflowTaskMemberships,
      settings,
      cursor,
    ] = await Promise.all([
      db.notes.toArray(),
      db.taskSteps.toArray(),
      db.timePoints.toArray(),
      db.placements.toArray(),
      db.workflows.toArray(),
      db.workflowStages.toArray(),
      db.workflowTaskMemberships.toArray(),
      db.settings.toCollection().first(),
      db.syncMeta.get('v2:cursor'),
    ]);
    if (!settings) return undefined;
    return {
      folders,
      tasks,
      notes,
      taskSteps,
      timePoints,
      placements,
      workflows,
      workflowStages,
      workflowTaskMemberships,
      settings: settings as V2SettingsDto,
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
  return task as LocalTaskDto;
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
  return rows.sort(compareRank);
}

function compareRank(left: { rank: string }, right: { rank: string }): number {
  const a = BigInt(left.rank);
  const b = BigInt(right.rank);
  return a < b ? -1 : a > b ? 1 : 0;
}

function rankForMove(
  siblings: Array<{ rank: string }>,
  beforeId: string | null | undefined,
  afterId: string | null | undefined,
): string {
  const ordered = [...siblings].sort(compareRank);
  const before = beforeId
    ? ordered.find((row) => (row as { id?: string }).id === beforeId)
    : undefined;
  const after = afterId
    ? ordered.find((row) => (row as { id?: string }).id === afterId)
    : undefined;
  const anchor = before ?? after;
  if (anchor) {
    const index = ordered.indexOf(anchor);
    const anchorRank = BigInt(anchor.rank);
    const lower = before
      ? BigInt(ordered[index - 1]?.rank ?? (anchorRank - 1024n).toString())
      : anchorRank;
    const upper = before
      ? anchorRank
      : BigInt(ordered[index + 1]?.rank ?? (anchorRank + 1024n).toString());
    if (upper > lower + 1n) return ((lower + upper) / 2n).toString();
    return (before ? upper - 1n : upper + 1n).toString();
  }
  return nextRank(ordered);
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
