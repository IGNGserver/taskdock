import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { uuidv7 } from '@devtodo/contracts';
import { describe, expect, it } from 'vitest';
import { DevTodoDatabase, V2SyncEngine, convertV1OutboxForV2 } from '../src/index.js';

const origin = 'https://migration.example.test';
const ownerId = '00000000-0000-7000-8000-000000000099';
const projectId = '00000000-0000-7000-8000-000000000098';
const taskId = '00000000-0000-7000-8000-000000000097';

function dbName(): string {
  return `devtodo:${new URL(origin).origin}:${ownerId}`.slice(0, 240);
}

describe('Dexie v2 migration', () => {
  it('projects tasks and all outbox intents into the v2 tree without clearing data', async () => {
    const legacy = new Dexie(dbName());
    legacy.version(1).stores({
      projects: '&id, rank, archivedAt',
      tasks: '&id, [projectId+category], status, rank, referenceId, archivedAt',
      notes: '&id, taskId, updatedAt',
      timePoints: '&id, [type+localDate], type, rank, archivedAt',
      placements: '&id, [timePointId+rank], [taskId+timePointId]',
      settings: '&ownerId',
      outbox: '++id, mutationId, nextAttemptAt, clientId',
      conflicts: '++id, mutationId, entityId, createdAt',
      syncMeta: '&key',
    });
    legacy.version(2).stores({ deferredChanges: '++id, seq, entityType, entityId' });
    await legacy.open();
    await legacy.table('projects').put({
      id: projectId,
      name: '旧项目',
      taskPrefix: 'OLD',
      rank: '1024',
      version: 1,
      archivedAt: null,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    await legacy.table('tasks').put({
      id: taskId,
      referenceId: 'OLD-1',
      projectId: projectId,
      category: 'FEATURE',
      title: '旧任务',
      status: 'TODO',
      priority: 'HIGH',
      rank: '1024',
      version: 1,
      completedAt: null,
      archivedAt: null,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    await legacy.table('outbox').add({
      mutationId: uuidv7(),
      clientId: uuidv7(),
      command: 'project.create',
      entityId: uuidv7(),
      baseVersion: null,
      occurredAt: '2026-09-13T00:00:00.000Z',
      payload: { name: '新目录', taskPrefix: 'NEW' },
      attempts: 0,
      nextAttemptAt: 0,
    });
    const archiveMutationId = uuidv7();
    await legacy.table('outbox').add({
      mutationId: archiveMutationId,
      clientId: uuidv7(),
      command: 'project.archive',
      entityId: projectId,
      baseVersion: 1,
      occurredAt: '2026-09-13T00:00:00.000Z',
      payload: {},
      attempts: 0,
      nextAttemptAt: 0,
    });
    await legacy.table('outbox').add({
      mutationId: uuidv7(),
      clientId: uuidv7(),
      command: 'project.restore',
      entityId: projectId,
      baseVersion: 2,
      occurredAt: '2026-09-13T00:00:00.000Z',
      payload: {},
      attempts: 0,
      nextAttemptAt: 0,
    });
    await legacy.table('outbox').add({
      mutationId: uuidv7(),
      clientId: uuidv7(),
      command: 'task.create',
      entityId: uuidv7(),
      baseVersion: null,
      occurredAt: '2026-09-13T00:00:00.000Z',
      payload: { projectId, category: 'FEATURE', title: '离线新任务', priority: 'LOW' },
      attempts: 0,
      nextAttemptAt: 0,
    });
    const originalOutbox = await legacy.table('outbox').count();
    await legacy.close();

    const db = new DevTodoDatabase(origin, ownerId);
    try {
      expect(await db.folders.get(projectId)).toMatchObject({
        id: projectId,
        parentFolderId: null,
        title: '旧项目',
      });
      expect(await db.tasks.get(taskId)).toMatchObject({
        id: taskId,
        parentFolderId: projectId,
        referenceId: 'OLD-1',
        priority: 'HIGH',
      });
      expect(await db.outbox.count()).toBe(originalOutbox);
      const pending = await convertV1OutboxForV2(db);
      // The archive mechanism was removed: the queued v1 archive/restore pair
      // can no longer be applied and must surface in the upgrade queue.
      expect(pending.map((item) => item.command)).toEqual(['project.archive', 'project.restore']);
      const commands = (await db.outbox.orderBy('id').toArray()).map((item) => item.command);
      expect(commands).toEqual([
        'folder.create',
        // The archive/restore pair stays queued but blocked (pending upgrade).
        'project.archive',
        'project.restore',
        'task.create',
      ]);
      expect((await db.outbox.orderBy('id').last())?.payload).toMatchObject({
        parentFolderId: projectId,
        title: '离线新任务',
      });
      expect((await db.syncMeta.get('schemaVersion'))?.value).toBe('4');
    } finally {
      await db.delete();
    }
  });

  it('resyncs from a v2 snapshot after cursor expiry and replays pending outbox', async () => {
    const db = new DevTodoDatabase(`${origin}/cursor`, ownerId);
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
    const clientId = uuidv7();
    let pushCount = 0;
    let pullCount = 0;
    let snapshotCount = 0;
    const settings = {
      ownerId,
      timezone: 'Asia/Shanghai',
      weekStartsOn: 1 as const,
      defaultCaptureTarget: 'ROOT' as const,
      version: 1,
      updatedAt: '2026-09-13T00:00:00.000Z',
    };
    const engine = new V2SyncEngine(db, clientId, {
      async push(request) {
        pushCount += 1;
        expect(request.protocolVersion).toBe(2);
        if (pushCount === 1) return { results: [] };
        return {
          results: request.mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            status: 'applied' as const,
          })),
        };
      },
      async pull(cursor) {
        pullCount += 1;
        if (pullCount === 1) throw { code: 'SYNC_CURSOR_EXPIRED' };
        expect(cursor).toBe('41');
        return { changes: [], nextCursor: '41', hasMore: false };
      },
      async snapshot() {
        snapshotCount += 1;
        return {
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
          cursor: '41',
        };
      },
    });
    try {
      // Set initial cursor to simulate expired cursor scenario
      await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
      await engine.queue({
        command: 'folder.create',
        entityId: uuidv7(),
        baseVersion: null,
        occurredAt: '2026-09-13T00:00:00.000Z',
        payload: { parentFolderId: null, title: '离线目录' },
      });
      // A stale legacy Project row must not survive a v2 snapshot resync.
      await db.projects.put({
        id: uuidv7(),
        name: '旧项目',
        taskPrefix: 'OLD',
        rank: '1024',
        version: 1,
        archivedAt: null,
        createdAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z',
      });
      expect(await db.projects.count()).toBe(1);
      await engine.sync();
      expect(pushCount).toBe(2);
      expect(pullCount).toBe(2);
      expect(snapshotCount).toBe(1);
      expect(await db.outbox.count()).toBe(0);
      expect(await db.syncMeta.get('v2:cursor')).toMatchObject({ value: '41' });
      expect(await db.projects.count()).toBe(0);
    } finally {
      await db.delete();
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator,
      });
    }
  });

  it('actively fetches and applies v2 snapshot on initial sync when no v2 cursor exists (P0-5)', async () => {
    const initialDbName = `devtodo:initial-sync-${uuidv7()}`;
    const db = new DevTodoDatabase(initialDbName);
    // Explicitly set navigator to online for fake-indexeddb test environment
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
    let snapshotFetched = false;

    const engine = new V2SyncEngine(db, uuidv7(), {
      async push(request) {
        return {
          protocolVersion: 2,
          results: request.mutations.map((m) => ({
            mutationId: m.mutationId,
            status: 'applied' as const,
            replayed: false,
          })),
        };
      },
      async pull() {
        return { changes: [], nextCursor: '100', hasMore: false };
      },
      async snapshot() {
        snapshotFetched = true;
        return {
          folders: [
            {
              id: 'server-folder-1',
              parentFolderId: null,
              title: '服务端预置目录',
              rank: '1024',
              version: 1,
              archivedAt: null,
              archivedByOperationId: null,
              createdAt: '2026-09-13T00:00:00.000Z',
              updatedAt: '2026-09-13T00:00:00.000Z',
            },
          ],
          tasks: [],
          notes: [],
          taskSteps: [],
          timePoints: [],
          placements: [],
          workflows: [],
          workflowStages: [],
          workflowTaskMemberships: [],
          settings: {
            ownerId: 'owner-1',
            timezone: 'Asia/Shanghai',
            weekStartsOn: 1,
            defaultCaptureTarget: 'ROOT',
            version: 1,
            updatedAt: '2026-09-13T00:00:00.000Z',
          },
          cursor: '100',
        };
      },
    });

    try {
      // Clean DB with no v2 cursor
      expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
      await engine.sync();
      // Must fetch snapshot first
      expect(snapshotFetched).toBe(true);
      expect((await db.folders.get('server-folder-1'))?.title).toBe('服务端预置目录');
      expect((await db.syncMeta.get('v2:cursor'))?.value).toBe('100');
    } finally {
      await db.delete();
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator,
      });
    }
  });

  it('correctly classifies tree.move for Task entity in conflict resolution (P1-9)', async () => {
    const conflictDbName = `devtodo:conflict-task-move-${uuidv7()}`;
    const db = new DevTodoDatabase(conflictDbName);
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
    const taskId = uuidv7();

    const engine = new V2SyncEngine(db, uuidv7(), {
      async push(request) {
        return {
          protocolVersion: 2,
          results: request.mutations.map((m) => ({
            mutationId: m.mutationId,
            status: 'conflict' as const,
            error: {
              code: 'VERSION_CONFLICT',
              message: '版本冲突',
              details: { id: taskId, title: 'Server Task Title', version: 3 },
            },
          })),
        };
      },
      async pull() {
        return { changes: [], nextCursor: '200', hasMore: false };
      },
      async snapshot() {
        return {
          folders: [],
          tasks: [],
          notes: [],
          taskSteps: [],
          timePoints: [],
          placements: [],
          workflows: [],
          workflowStages: [],
          workflowTaskMemberships: [],
          settings: {
            ownerId: 'owner-1',
            timezone: 'Asia/Shanghai',
            weekStartsOn: 1,
            defaultCaptureTarget: 'ROOT',
            version: 1,
            updatedAt: '2026-09-13T00:00:00.000Z',
          },
          cursor: '200',
        };
      },
    });

    try {
      await engine.queue({
        command: 'tree.move',
        entityId: taskId,
        baseVersion: 1,
        occurredAt: new Date().toISOString(),
        payload: {
          item: { kind: 'TASK', id: taskId },
          parentFolderId: null,
          expectedStatus: 'TODO',
          baseVersion: 1,
        },
      });
      await engine.sync();

      const conflicts = await db.conflicts.toArray();
      expect(conflicts).toHaveLength(1);
      // P1-9: Entity type must be 'task' rather than 'folder'
      expect(conflicts[0]?.entityType).toBe('task');

      // Test resolveConflict with 'server' strategy - verifies it writes to tasks table, not folders
      await engine.resolveConflict(conflicts[0]!.id!, 'server');
      const taskInTable = await db.tasks.get(taskId);
      expect(taskInTable).toBeDefined();
      expect((taskInTable as { title?: string })?.title).toBe('Server Task Title');
      const folderInTable = await db.folders.get(taskId);
      expect(folderInTable).toBeUndefined();
    } finally {
      await db.delete();
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator,
      });
    }
  });

  it('does not roll a newer local row back with a stale pulled change', async () => {
    const staleName = `devtodo:stale-change-${uuidv7()}`;
    const db = new DevTodoDatabase(staleName);
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
    const taskId = uuidv7();
    let pullCount = 0;

    const engine = new V2SyncEngine(db, uuidv7(), {
      async push() {
        return { protocolVersion: 2, results: [] };
      },
      async pull() {
        pullCount += 1;
        // First pull delivers version 5, then a duplicated/out-of-order older
        // version 2 would otherwise clobber the row.
        return {
          changes: [
            {
              seq: pullCount,
              entityType: 'task',
              entityId: taskId,
              entityVersion: pullCount === 1 ? 5 : 2,
              operation: 'upsert',
              snapshot: {
                id: taskId,
                referenceId: 'TASK-1',
                parentFolderId: null,
                title: pullCount === 1 ? '新标题' : '旧标题',
                status: 'TODO',
                rank: '1024',
                version: pullCount === 1 ? 5 : 2,
                completedAt: null,
                createdAt: '2026-09-13T00:00:00.000Z',
                updatedAt: '2026-09-13T00:00:00.000Z',
              },
            },
          ],
          nextCursor: String(pullCount),
          hasMore: pullCount < 2,
        };
      },
      async snapshot() {
        return {
          folders: [],
          tasks: [],
          notes: [],
          taskSteps: [],
          timePoints: [],
          placements: [],
          workflows: [],
          workflowStages: [],
          workflowTaskMemberships: [],
          settings: {
            ownerId: 'owner-1',
            timezone: 'Asia/Shanghai',
            weekStartsOn: 1,
            defaultCaptureTarget: 'ROOT',
            version: 1,
            updatedAt: '2026-09-13T00:00:00.000Z',
          },
          cursor: '0',
        };
      },
    });

    try {
      await engine.sync();
      const task = (await db.tasks.get(taskId)) as { title?: string; version?: number } | undefined;
      expect(task?.title).toBe('新标题');
      expect(task?.version).toBe(5);
      expect(pullCount).toBeGreaterThanOrEqual(2);
    } finally {
      await db.delete();
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator,
      });
    }
  });
});
