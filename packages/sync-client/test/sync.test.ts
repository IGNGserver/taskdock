import 'fake-indexeddb/auto';

import type {
  LocalTaskDto,
  NoteDto,
  PlacementDto,
  ProjectDto,
  SettingsDto,
  TimePointDto,
} from '@devtodo/contracts';
import { uuidv7 } from '@devtodo/contracts';
import { describe, expect, it } from 'vitest';

import {
  DevTodoDatabase,
  isMergeableConflictCommand,
  SyncEngine,
  type OutboxItem,
  type LocalStateImage,
  type PullResult,
  type SnapshotResult,
  type SyncTransport,
} from '../src/index.js';

const ownerId = '00000000-0000-7000-8000-000000000001';
const hubOrigin = 'https://hub.example.test';

function now(): string {
  return '2026-09-04T10:00:00.000Z';
}

function task(id: string): LocalTaskDto {
  return {
    id,
    referenceId: null,
    projectId: null,
    category: 'MISC',
    title: '离线任务',
    status: 'TODO',
    priority: 'NONE',
    rank: '1024',
    version: 1,
    completedAt: null,
    archivedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function datePoint(id: string, localDate = '2026-09-04'): TimePointDto {
  return {
    id,
    type: 'DATE',
    localDate,
    title: null,
    rank: '1024',
    version: 1,
    reachedAt: null,
    archivedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function project(id: string): ProjectDto {
  return {
    id,
    name: '测试项目',
    taskPrefix: 'TEST',
    rank: '1024',
    version: 1,
    archivedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function settings(ownerId: string): SettingsDto {
  return {
    ownerId,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1,
    defaultCaptureTarget: 'GLOBAL_MISC',
    version: 1,
    updatedAt: now(),
  };
}

function placement(id: string, taskId: string, timePointId: string): PlacementDto {
  return {
    id,
    taskId,
    timePointId,
    rank: '1024',
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  };
}

function outboxItem(
  command: string,
  entityId: string,
  payload: Record<string, unknown>,
  baseVersion: number | null = null,
): OutboxItem {
  return {
    mutationId: uuidv7(),
    clientId: uuidv7(),
    command,
    entityId,
    baseVersion,
    occurredAt: now(),
    payload,
    attempts: 0,
    nextAttemptAt: 0,
  };
}

function online(): () => void {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  return () =>
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: previous,
    });
}

function emptyPull(cursor = '0'): PullResult {
  return { changes: [], nextCursor: cursor, hasMore: false };
}

function snapshot(): SnapshotResult {
  return {
    projects: [],
    tasks: [],
    notes: [],
    timePoints: [],
    placements: [],
    settings: null,
    cursor: '0',
  };
}

async function withDatabase<T>(run: (db: DevTodoDatabase) => Promise<T>): Promise<T> {
  const db = new DevTodoDatabase(hubOrigin, ownerId);
  try {
    return await run(db);
  } finally {
    await db.delete();
  }
}

describe('SyncEngine', () => {
  it('never lets a later due mutation pass an earlier delayed head', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const first = outboxItem('task.update', uuidv7(), { title: '先处理' }, 1);
        const second = outboxItem('task.update', uuidv7(), { title: '后处理' }, 1);
        const firstId = await db.outbox.add({ ...first, nextAttemptAt: Date.now() + 60_000 });
        await db.outbox.add({ ...second, nextAttemptAt: 0 });
        const pushed: string[] = [];
        const transport: SyncTransport = {
          push: async ({ mutations }) => {
            pushed.push(mutations[0]!.mutationId);
            return {
              results: [
                {
                  mutationId: mutations[0]!.mutationId,
                  status: 'rejected',
                  error: { code: 'MUTATION_REJECTED', message: '测试拒绝' },
                },
              ],
            };
          },
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        expect(pushed).toEqual([]);
        expect(await db.outbox.get(firstId)).toBeTruthy();
        const firstRow = await db.outbox.orderBy('id').first();
        await db.outbox.update(firstRow!.id!, { nextAttemptAt: 0 });
        await engine.sync();
        expect(pushed).toEqual([first.mutationId]);
      });
    } finally {
      restoreNavigator();
    }
  });

  it('reconciles a rejected mutation from the server snapshot without leaving a ghost row', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const taskId = uuidv7();
        const serverTask = task(taskId);
        const localTask = { ...serverTask, title: '本地乐观修改', version: 2, pendingSync: true };
        const beforeImage: LocalStateImage = {
          rows: [{ table: 'tasks', id: taskId, value: serverTask }],
        };
        const afterImage: LocalStateImage = {
          rows: [{ table: 'tasks', id: taskId, value: localTask }],
        };
        const item = {
          ...outboxItem('task.update', taskId, { title: localTask.title }, 1),
          beforeImage,
          afterImage,
        };
        await db.tasks.put(localTask);
        await db.outbox.add(item);
        const transport: SyncTransport = {
          push: async ({ mutations }) => ({
            results: [
              {
                mutationId: mutations[0]!.mutationId,
                status: 'rejected',
                error: { code: 'MUTATION_REJECTED', message: '服务端拒绝' },
              },
            ],
          }),
          pull: async () => emptyPull(),
          snapshot: async () => ({ ...snapshot(), tasks: [serverTask], cursor: '4' }),
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        await engine.discardRejectedMutation(item.mutationId);
        expect(await db.outbox.count()).toBe(0);
        expect(await db.tasks.get(taskId)).toEqual(serverTask);
      });
    } finally {
      restoreNavigator();
    }
  });

  it('pushes dependent mutations sequentially and remaps a duplicate date id', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const localDateId = uuidv7();
        const serverDateId = uuidv7();
        const taskId = uuidv7();
        const localPlacementId = uuidv7();
        const serverPlacementId = uuidv7();
        const dateMutation = outboxItem('timePoint.date.create', localDateId, {
          localDate: '2026-09-04',
          __localId: localDateId,
        });
        const placementMutation = outboxItem('placement.create', localPlacementId, {
          taskId,
          timePointId: localDateId,
          __localId: localPlacementId,
        });
        await db.timePoints.put({ ...datePoint(localDateId), pendingSync: true });
        await db.tasks.put(task(taskId));
        await db.placements.put({
          ...placement(localPlacementId, taskId, localDateId),
          pendingSync: true,
        });
        await db.outbox.bulkAdd([dateMutation, placementMutation]);

        const pushed: Array<Parameters<SyncTransport['push']>[0]> = [];
        const transport: SyncTransport = {
          push: async (request) => {
            pushed.push(request);
            const mutation = request.mutations[0]!;
            if (mutation.command === 'timePoint.date.create') {
              return {
                results: [
                  {
                    mutationId: mutation.mutationId,
                    status: 'applied',
                    result: datePoint(serverDateId),
                  },
                ],
              };
            }
            expect(mutation.payload['timePointId']).toBe(serverDateId);
            return {
              results: [
                {
                  mutationId: mutation.mutationId,
                  status: 'applied',
                  result: { placement: placement(serverPlacementId, taskId, serverDateId) },
                },
              ],
            };
          },
          pull: async () => emptyPull(),
          snapshot,
        };

        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        expect(pushed).toHaveLength(2);
        expect(pushed.map(({ clientId }) => clientId)).toEqual([
          dateMutation.clientId,
          placementMutation.clientId,
        ]);
        expect(await db.outbox.count()).toBe(0);
        expect(await db.timePoints.get(localDateId)).toBeUndefined();
        expect((await db.timePoints.get(serverDateId))?.localDate).toBe('2026-09-04');
        expect((await db.placements.get(serverPlacementId))?.timePointId).toBe(serverDateId);
        expect(await db.placements.get(localPlacementId)).toBeUndefined();
      });
    } finally {
      restoreNavigator();
    }
  });

  it('remaps every created entity and all dependent offline graph references', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const localProjectId = uuidv7();
        const serverProjectId = uuidv7();
        const localTaskId = uuidv7();
        const serverTaskId = uuidv7();
        const localNoteId = uuidv7();
        const serverNoteId = uuidv7();
        const localDateId = uuidv7();
        const serverDateId = uuidv7();
        const localPlacementId = uuidv7();
        const serverPlacementId = uuidv7();
        const localCopyId = uuidv7();
        const serverCopyId = uuidv7();
        const localMoveId = uuidv7();
        const serverMoveId = uuidv7();

        const projectMutation = outboxItem(
          'project.create',
          localProjectId,
          { name: '服务器项目', taskPrefix: 'SRV', __localId: localProjectId },
          null,
        );
        const taskMutation = outboxItem(
          'task.create',
          localTaskId,
          {
            projectId: localProjectId,
            category: 'FEATURE',
            title: '服务器任务',
            priority: 'NONE',
            __localId: localTaskId,
            __localNoteId: localNoteId,
          },
          null,
        );
        const dateMutation = outboxItem(
          'timePoint.date.create',
          localDateId,
          { localDate: '2026-09-06', __localId: localDateId },
          null,
        );
        const placementMutation = outboxItem(
          'placement.create',
          localPlacementId,
          {
            taskId: localTaskId,
            timePointId: localDateId,
            __localId: localPlacementId,
          },
          null,
        );
        const noteMutation = outboxItem(
          'note.update',
          localTaskId,
          { contentMarkdown: '后续备注' },
          1,
        );
        const copyMutation = outboxItem(
          'placement.copy',
          localPlacementId,
          {
            timePointId: localDateId,
            __localId: localCopyId,
            nested: { placementId: localPlacementId, timePointId: localDateId },
          },
          null,
        );
        const moveMutation = outboxItem(
          'placement.move',
          localPlacementId,
          {
            timePointId: localDateId,
            __localId: localMoveId,
            nested: { taskId: localTaskId, placementId: localPlacementId },
          },
          1,
        );

        const localProject = { ...project(localProjectId), name: '本地项目', pendingSync: true };
        const localTask = {
          ...task(localTaskId),
          projectId: localProjectId,
          category: 'FEATURE' as const,
          pendingSync: true,
        };
        const localNote: NoteDto = {
          id: localNoteId,
          taskId: localTaskId,
          contentMarkdown: '',
          version: 1,
          updatedAt: now(),
        };
        const localDate = { ...datePoint(localDateId, '2026-09-06'), pendingSync: true };
        const localPlacement = {
          ...placement(localPlacementId, localTaskId, localDateId),
          pendingSync: true,
        };
        await db.projects.put(localProject);
        await db.tasks.put(localTask);
        await db.notes.put({ ...localNote, pendingSync: true });
        await db.timePoints.put(localDate);
        await db.placements.put(localPlacement);
        await db.outbox.bulkAdd([
          projectMutation,
          taskMutation,
          dateMutation,
          placementMutation,
          noteMutation,
          copyMutation,
          moveMutation,
        ]);

        const pushed: string[] = [];
        const transport: SyncTransport = {
          push: async ({ mutations }) => {
            const mutation = mutations[0]!;
            pushed.push(mutation.command);
            switch (mutation.command) {
              case 'project.create':
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: { ...localProject, id: serverProjectId, pendingSync: undefined },
                    },
                  ],
                };
              case 'task.create': {
                expect(mutation.payload.projectId).toBe(serverProjectId);
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: {
                        task: {
                          ...localTask,
                          id: serverTaskId,
                          projectId: serverProjectId,
                          referenceId: 'SRV-1',
                          pendingSync: undefined,
                        },
                        note: {
                          ...localNote,
                          id: serverNoteId,
                          taskId: serverTaskId,
                          pendingSync: undefined,
                        },
                      },
                    },
                  ],
                };
              }
              case 'timePoint.date.create':
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: { ...localDate, id: serverDateId, pendingSync: undefined },
                    },
                  ],
                };
              case 'placement.create':
                expect(mutation.entityId).toBe(localPlacementId);
                expect(mutation.payload).toMatchObject({
                  taskId: serverTaskId,
                  timePointId: serverDateId,
                });
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: {
                        placement: {
                          ...localPlacement,
                          id: serverPlacementId,
                          taskId: serverTaskId,
                          timePointId: serverDateId,
                          pendingSync: undefined,
                        },
                      },
                    },
                  ],
                };
              case 'note.update':
                expect(mutation.entityId).toBe(serverTaskId);
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: {
                        ...localNote,
                        id: serverNoteId,
                        taskId: serverTaskId,
                        contentMarkdown: '后续备注',
                        version: 2,
                      },
                    },
                  ],
                };
              case 'placement.copy':
                expect(mutation.entityId).toBe(serverPlacementId);
                expect(mutation.payload).toMatchObject({
                  timePointId: serverDateId,
                  nested: { placementId: serverPlacementId, timePointId: serverDateId },
                });
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: {
                        placement: {
                          ...localPlacement,
                          id: serverCopyId,
                          taskId: serverTaskId,
                          timePointId: serverDateId,
                          pendingSync: undefined,
                        },
                      },
                    },
                  ],
                };
              case 'placement.move':
                expect(mutation.entityId).toBe(serverPlacementId);
                expect(mutation.payload).toMatchObject({
                  timePointId: serverDateId,
                  nested: { taskId: serverTaskId, placementId: serverPlacementId },
                });
                return {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: {
                        placement: {
                          ...localPlacement,
                          id: serverMoveId,
                          taskId: serverTaskId,
                          timePointId: serverDateId,
                          pendingSync: undefined,
                        },
                        sourcePlacementId: serverPlacementId,
                      },
                    },
                  ],
                };
              default:
                throw new Error(`unexpected command ${mutation.command}`);
            }
          },
          pull: async () => emptyPull(),
          snapshot,
        };

        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();

        expect(pushed).toEqual([
          'project.create',
          'task.create',
          'timePoint.date.create',
          'placement.create',
          'note.update',
          'placement.copy',
          'placement.move',
        ]);
        expect(await db.outbox.count()).toBe(0);
        expect(await db.projects.get(localProjectId)).toBeUndefined();
        expect(await db.projects.get(serverProjectId)).toBeTruthy();
        expect(await db.tasks.get(localTaskId)).toBeUndefined();
        expect((await db.tasks.get(serverTaskId))?.projectId).toBe(serverProjectId);
        expect(await db.notes.get(localNoteId)).toBeUndefined();
        expect((await db.notes.get(serverNoteId))?.taskId).toBe(serverTaskId);
        expect(await db.timePoints.get(localDateId)).toBeUndefined();
        expect(await db.timePoints.get(serverDateId)).toBeTruthy();
        expect(await db.placements.get(localPlacementId)).toBeUndefined();
        expect(await db.placements.get(serverPlacementId)).toBeUndefined();
        expect((await db.placements.get(serverCopyId))?.taskId).toBe(serverTaskId);
        expect((await db.placements.get(serverMoveId))?.timePointId).toBe(serverDateId);
      });
    } finally {
      restoreNavigator();
    }
  });

  it('retains rejected mutations in a visible retry queue across full resync', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const taskId = uuidv7();
        const localTask = task(taskId);
        const item = outboxItem('task.create', taskId, {
          category: 'MISC',
          title: localTask.title,
          priority: 'NONE',
          __localId: taskId,
        });
        await db.tasks.put({ ...localTask, pendingSync: true });
        await db.outbox.add(item);
        let pushCalls = 0;
        let pullCalls = 0;
        const transport: SyncTransport = {
          push: async () => {
            pushCalls += 1;
            return {
              results: [
                pushCalls === 1
                  ? {
                      mutationId: item.mutationId,
                      status: 'rejected',
                      error: { code: 'MUTATION_REJECTED', message: '暂时拒绝' },
                    }
                  : {
                      mutationId: item.mutationId,
                      status: 'applied',
                      result: { task: { ...localTask, referenceId: 'MISC-1' } },
                    },
              ],
            };
          },
          pull: async () => {
            pullCalls += 1;
            if (pullCalls === 1) {
              const error = new Error('SYNC_CURSOR_EXPIRED');
              Object.assign(error, { code: 'SYNC_CURSOR_EXPIRED' });
              throw error;
            }
            return emptyPull('12');
          },
          snapshot: async () => ({ ...snapshot(), cursor: '12' }),
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        expect(pushCalls).toBe(1);
        expect(pullCalls).toBe(2);
        expect(await db.outbox.count()).toBe(1);
        expect((await db.tasks.get(taskId))?.title).toBe('离线任务');
        expect(engine.getStatus()).toBe('error');
        await engine.retryRejectedMutation(item.mutationId);
        await engine.sync();
        expect(pushCalls).toBe(2);
        expect(await db.outbox.count()).toBe(0);
        expect((await db.tasks.get(taskId))?.referenceId).toBe('MISC-1');
      });
    } finally {
      restoreNavigator();
    }
  });

  it('records a conflict and allows the local mutation to be retried at the server version', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const taskId = uuidv7();
        const localTask = task(taskId);
        const item = outboxItem('task.update', taskId, { title: '本地修改' }, 1);
        await db.tasks.put({ ...localTask, title: '本地修改', pendingSync: true });
        await db.outbox.add(item);
        let call = 0;
        const serverTask = { ...localTask, title: '服务器修改', version: 2 };
        const transport: SyncTransport = {
          push: async ({ mutations }) => {
            call += 1;
            const mutation = mutations[0]!;
            return call === 1
              ? {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'conflict',
                      error: {
                        code: 'VERSION_CONFLICT',
                        message: '版本冲突',
                        details: { server: serverTask },
                      },
                    },
                  ],
                }
              : {
                  results: [
                    {
                      mutationId: mutation.mutationId,
                      status: 'applied',
                      result: { ...serverTask, title: '本地修改', version: 3 },
                    },
                  ],
                };
          },
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        expect(engine.getStatus()).toBe('conflict');
        expect(await db.conflicts.count()).toBe(1);
        const conflict = await db.conflicts.toCollection().first();
        expect(conflict?.mutationId).toBe(item.mutationId);
        expect(conflict?.command).toBe(item.command);
        await engine.resolveConflict(conflict!.id!, 'local');
        await engine.sync();
        expect(await db.outbox.count()).toBe(0);
        expect((await db.tasks.get(taskId))?.title).toBe('本地修改');
        expect((await db.tasks.get(taskId))?.version).toBe(3);
      });
    } finally {
      restoreNavigator();
    }
  });

  it('supports merged retries for project, time point, and settings updates', async () => {
    const restoreNavigator = online();
    try {
      const cases = [
        {
          command: 'project.update',
          entityId: uuidv7(),
          payload: { name: '本地项目' },
          merged: { name: '合并项目' },
          setup: async (db: DevTodoDatabase, entityId: string) => {
            await db.projects.put({ ...project(entityId), name: '本地项目', version: 2 });
          },
          server: (entityId: string) => ({ ...project(entityId), name: '服务器项目', version: 2 }),
          read: async (db: DevTodoDatabase, entityId: string) =>
            (await db.projects.get(entityId))?.name,
        },
        {
          command: 'timePoint.update',
          entityId: uuidv7(),
          payload: { title: '本地时间点' },
          merged: { title: '合并时间点' },
          setup: async (db: DevTodoDatabase, entityId: string) => {
            await db.timePoints.put({
              ...datePoint(entityId),
              type: 'EVENT',
              localDate: null,
              title: '本地时间点',
              version: 2,
            });
          },
          server: (entityId: string) => ({
            ...datePoint(entityId),
            type: 'EVENT',
            localDate: null,
            title: '服务器时间点',
            version: 2,
          }),
          read: async (db: DevTodoDatabase, entityId: string) =>
            (await db.timePoints.get(entityId))?.title,
        },
        {
          command: 'settings.update',
          entityId: ownerId,
          payload: { timezone: 'UTC' },
          merged: { timezone: 'America/Los_Angeles' },
          setup: async (db: DevTodoDatabase, entityId: string) => {
            await db.settings.put({
              ...settings(entityId),
              timezone: 'UTC',
              version: 2,
            });
          },
          server: (entityId: string) => ({
            ...settings(entityId),
            timezone: 'Asia/Tokyo',
            version: 2,
          }),
          read: async (db: DevTodoDatabase, entityId: string) =>
            (await db.settings.get(entityId))?.timezone,
        },
      ] as const;

      for (const candidate of cases) {
        await withDatabase(async (db) => {
          const serverValue = candidate.server(candidate.entityId);
          const item = outboxItem(candidate.command, candidate.entityId, candidate.payload, 1);
          await candidate.setup(db, candidate.entityId);
          await db.outbox.add(item);
          let pushCount = 0;
          const transport: SyncTransport = {
            push: async ({ mutations }) => {
              pushCount += 1;
              const mutation = mutations[0]!;
              return {
                results: [
                  pushCount === 1
                    ? {
                        mutationId: mutation.mutationId,
                        status: 'conflict',
                        error: {
                          code: 'VERSION_CONFLICT',
                          message: '版本冲突',
                          details: { server: serverValue },
                        },
                      }
                    : {
                        mutationId: mutation.mutationId,
                        status: 'applied',
                        result: {
                          ...serverValue,
                          ...candidate.merged,
                          version: 3,
                        },
                      },
                ],
              };
            },
            pull: async () => emptyPull(),
            snapshot,
          };
          const engine = new SyncEngine(db, uuidv7(), transport);
          await engine.sync();
          const conflict = await db.conflicts.toCollection().first();
          expect(conflict?.command).toBe(candidate.command);
          await engine.resolveConflict(conflict!.id!, 'merged', candidate.merged);
          const retry = await db.outbox.orderBy('id').first();
          expect(retry?.baseVersion).toBe(2);
          expect(retry?.payload).toEqual(candidate.merged);
          await engine.sync();
          expect(await db.outbox.count()).toBe(0);
          expect(await candidate.read(db, candidate.entityId)).toBe(
            Object.values(candidate.merged)[0],
          );
        });
      }
    } finally {
      restoreNavigator();
    }
  });

  it('does not mark placement reorder conflicts as mergeable', () => {
    expect(isMergeableConflictCommand('project.update')).toBe(true);
    expect(isMergeableConflictCommand('task.update')).toBe(true);
    expect(isMergeableConflictCommand('note.update')).toBe(true);
    expect(isMergeableConflictCommand('timePoint.update')).toBe(true);
    expect(isMergeableConflictCommand('settings.update')).toBe(true);
    expect(isMergeableConflictCommand('placement.reorder')).toBe(false);
  });

  it('restores an archived task before retrying its local mutation', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const taskId = uuidv7();
        const localTask = { ...task(taskId), title: '本地标题', version: 2, pendingSync: true };
        const serverTask = {
          ...task(taskId),
          title: '服务器标题',
          version: 3,
          archivedAt: now(),
        };
        const item = {
          ...outboxItem('task.update', taskId, { title: '本地标题' }, 1),
          beforeImage: { rows: [{ table: 'tasks' as const, id: taskId, value: task(taskId) }] },
          afterImage: { rows: [{ table: 'tasks' as const, id: taskId, value: localTask }] },
        };
        await db.tasks.put(localTask);
        await db.outbox.add(item);
        const pushed: string[] = [];
        let pushCount = 0;
        const transport: SyncTransport = {
          push: async ({ mutations }) => {
            const mutation = mutations[0]!;
            pushed.push(mutation.command);
            pushCount += 1;
            if (pushCount === 1) {
              expect(mutation.command).toBe('task.update');
              return {
                results: [
                  {
                    mutationId: mutation.mutationId,
                    status: 'conflict',
                    error: {
                      code: 'VERSION_CONFLICT',
                      message: '任务已归档',
                      details: { server: serverTask },
                    },
                  },
                ],
              };
            }
            if (mutation.command === 'task.restore') {
              return {
                results: [
                  {
                    mutationId: mutation.mutationId,
                    status: 'applied',
                    result: { ...serverTask, archivedAt: null, version: 4 },
                  },
                ],
              };
            }
            expect(mutation.command).toBe('task.update');
            expect(mutation.baseVersion).toBe(4);
            return {
              results: [
                {
                  mutationId: mutation.mutationId,
                  status: 'applied',
                  result: { ...serverTask, title: '本地标题', archivedAt: null, version: 5 },
                },
              ],
            };
          },
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        const conflict = await db.conflicts.toCollection().first();
        expect(conflict).toBeTruthy();
        await engine.resolveConflict(conflict!.id!, 'restore');
        expect(await db.outbox.count()).toBe(2);
        await engine.sync();

        expect(pushed).toEqual(['task.update', 'task.restore', 'task.update']);
        expect(await db.outbox.count()).toBe(0);
        expect((await db.tasks.get(taskId))?.title).toBe('本地标题');
        expect((await db.tasks.get(taskId))?.archivedAt).toBeNull();
        expect((await db.tasks.get(taskId))?.version).toBe(5);
      });
    } finally {
      restoreNavigator();
    }
  });

  it('discards a deleted conflict and its dependent optimistic graph', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const taskId = uuidv7();
        const note: NoteDto = {
          id: uuidv7(),
          taskId,
          contentMarkdown: '本地备注',
          version: 1,
          updatedAt: now(),
        };
        const point = datePoint(uuidv7());
        const localPlacement = placement(uuidv7(), taskId, point.id);
        const item = outboxItem('task.update', taskId, { title: '本地改动' }, 1);
        const dependent = outboxItem(
          'placement.create',
          localPlacement.id,
          { taskId, timePointId: point.id, __localId: localPlacement.id },
          null,
        );
        await db.tasks.put({ ...task(taskId), title: '本地改动', pendingSync: true });
        await db.notes.put(note);
        await db.timePoints.put(point);
        await db.placements.put({ ...localPlacement, pendingSync: true });
        await db.outbox.bulkAdd([item, dependent]);
        const transport: SyncTransport = {
          push: async ({ mutations }) => ({
            results: [
              {
                mutationId: mutations[0]!.mutationId,
                status: 'conflict',
                error: {
                  code: 'VERSION_CONFLICT',
                  message: '服务端实体已删除',
                  details: { server: null },
                },
              },
            ],
          }),
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        const conflict = await db.conflicts.toCollection().first();
        expect(conflict).toBeTruthy();
        await engine.resolveConflict(conflict!.id!, 'discard');

        expect(await db.outbox.count()).toBe(0);
        expect(await db.tasks.get(taskId)).toBeUndefined();
        expect(await db.notes.get(note.id)).toBeUndefined();
        expect(await db.placements.get(localPlacement.id)).toBeUndefined();
        expect((await db.conflicts.get(conflict!.id!))?.resolvedAt).toBeTruthy();
      });
    } finally {
      restoreNavigator();
    }
  });

  it('discards a deleted project and pending child mutations without resurrecting them', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const projectId = uuidv7();
        const taskId = uuidv7();
        const noteId = uuidv7();
        const point = datePoint(uuidv7());
        const placementId = uuidv7();
        const project = {
          id: projectId,
          name: '即将删除的项目',
          taskPrefix: 'DEL',
          rank: '1024',
          version: 1,
          archivedAt: null,
          createdAt: now(),
          updatedAt: now(),
        };
        const projectMutation = outboxItem(
          'project.update',
          projectId,
          { name: '本地项目改动' },
          1,
        );
        const taskMutation = outboxItem('task.update', taskId, { title: '本地任务改动' }, 1);
        const noteMutation = outboxItem(
          'note.update',
          taskId,
          { contentMarkdown: '本地备注改动' },
          1,
        );
        const placementMutation = outboxItem(
          'placement.remove',
          placementId,
          { baseVersion: 1 },
          1,
        );
        const placementBeforeImage: LocalStateImage = {
          rows: [
            {
              table: 'placements',
              id: placementId,
              value: placement(placementId, taskId, point.id),
            },
          ],
        };
        placementMutation.beforeImage = placementBeforeImage;
        placementMutation.afterImage = {
          rows: [{ table: 'placements', id: placementId, value: null }],
        };
        await db.projects.put(project);
        await db.tasks.put({
          ...task(taskId),
          projectId,
          title: '本地任务改动',
          pendingSync: true,
        });
        await db.notes.put({
          id: noteId,
          taskId,
          contentMarkdown: '本地备注改动',
          version: 2,
          updatedAt: now(),
          pendingSync: true,
        });
        await db.timePoints.put(point);
        await db.placements.put({ ...placement(placementId, taskId, point.id), pendingSync: true });
        await db.outbox.bulkAdd([projectMutation, taskMutation, noteMutation, placementMutation]);

        const transport: SyncTransport = {
          push: async ({ mutations }) => ({
            results: [
              {
                mutationId: mutations[0]!.mutationId,
                status: 'conflict',
                error: {
                  code: 'VERSION_CONFLICT',
                  message: '服务端项目已删除',
                  details: { server: null },
                },
              },
            ],
          }),
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        const conflict = await db.conflicts.toCollection().first();
        expect(conflict).toBeTruthy();
        await engine.resolveConflict(conflict!.id!, 'discard');

        expect(await db.outbox.count()).toBe(0);
        expect(await db.projects.get(projectId)).toBeUndefined();
        expect(await db.tasks.get(taskId)).toBeUndefined();
        expect(await db.notes.get(noteId)).toBeUndefined();
        expect(await db.placements.get(placementId)).toBeUndefined();
      });
    } finally {
      restoreNavigator();
    }
  });

  it('discards a deleted note without discarding later task or placement work', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const taskId = uuidv7();
        const noteId = uuidv7();
        const point = datePoint(uuidv7());
        const placementId = uuidv7();
        const root = outboxItem('note.update', taskId, { contentMarkdown: '旧备注' }, 1);
        const taskMutation = outboxItem('task.update', taskId, { title: '保留任务修改' }, 1);
        const laterNoteMutation = outboxItem(
          'note.update',
          taskId,
          { contentMarkdown: '再次修改备注' },
          1,
        );
        const placementMutation = outboxItem(
          'placement.create',
          placementId,
          { taskId, timePointId: point.id, __localId: placementId },
          null,
        );
        await db.tasks.put({ ...task(taskId), title: '保留任务修改', pendingSync: true });
        await db.notes.put({
          id: noteId,
          taskId,
          contentMarkdown: '再次修改备注',
          version: 2,
          updatedAt: now(),
          pendingSync: true,
        });
        await db.timePoints.put(point);
        await db.placements.put({ ...placement(placementId, taskId, point.id), pendingSync: true });
        await db.outbox.bulkAdd([root, taskMutation, laterNoteMutation, placementMutation]);
        const rootId = (await db.outbox.where('mutationId').equals(root.mutationId).first())!.id!;
        const laterNote = await db.outbox
          .where('mutationId')
          .equals(laterNoteMutation.mutationId)
          .first();
        if (laterNote?.id !== undefined)
          await db.outbox.update(laterNote.id, {
            beforeImage: { rows: [{ table: 'notes', id: noteId, value: null }] },
            afterImage: {
              rows: [
                {
                  table: 'notes',
                  id: noteId,
                  value: {
                    id: noteId,
                    taskId,
                    contentMarkdown: '再次修改备注',
                    version: 2,
                    updatedAt: now(),
                    pendingSync: true,
                  },
                },
              ],
            },
          });
        expect(rootId).toBeDefined();

        const transport: SyncTransport = {
          push: async ({ mutations }) => ({
            results: [
              {
                mutationId: mutations[0]!.mutationId,
                status: 'conflict',
                error: {
                  code: 'VERSION_CONFLICT',
                  message: '服务端备注已删除',
                  details: { server: null },
                },
              },
            ],
          }),
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        await engine.sync();
        const conflict = await db.conflicts.toCollection().first();
        await engine.resolveConflict(conflict!.id!, 'discard');

        expect(await db.tasks.get(taskId)).toBeTruthy();
        expect(await db.placements.get(placementId)).toBeTruthy();
        expect(await db.notes.get(noteId)).toBeUndefined();
        expect(await db.outbox.where('mutationId').equals(taskMutation.mutationId).count()).toBe(1);
        expect(
          await db.outbox.where('mutationId').equals(laterNoteMutation.mutationId).count(),
        ).toBe(0);
        expect(
          await db.outbox.where('mutationId').equals(placementMutation.mutationId).count(),
        ).toBe(1);
      });
    } finally {
      restoreNavigator();
    }
  });

  it('keeps a failed push queued with exponential backoff metadata', async () => {
    const restoreNavigator = online();
    try {
      await withDatabase(async (db) => {
        const item = outboxItem('task.update', uuidv7(), { title: '稍后重试' }, 1);
        const itemId = await db.outbox.add(item);
        const transport: SyncTransport = {
          push: async () => {
            throw new TypeError('network unavailable');
          },
          pull: async () => emptyPull(),
          snapshot,
        };
        const engine = new SyncEngine(db, uuidv7(), transport);
        const before = Date.now();
        await expect(engine.sync()).rejects.toThrow('network unavailable');
        const queued = await db.outbox.get(itemId);
        expect(queued?.attempts).toBe(1);
        expect(queued?.lastError).toBe('NETWORK_ERROR');
        expect(queued?.nextAttemptAt).toBeGreaterThan(before);
        expect(engine.getStatus()).toBe('offline');
      });
    } finally {
      restoreNavigator();
    }
  });
});
