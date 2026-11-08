import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@devtodo/contracts';
import {
  DevTodoDatabase,
  V2SyncEngine,
  captureLocalStateImage,
  type LocalTreeTask,
  type V2SnapshotResult,
  type V2SyncTransport,
} from '../src/index.js';

const databases: DevTodoDatabase[] = [];
const now = '2026-10-20T00:00:00.000Z';
const ownerId = uuidv7();

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()));
  vi.unstubAllGlobals();
});

function database(): DevTodoDatabase {
  vi.stubGlobal('navigator', { onLine: true });
  const db = new DevTodoDatabase('https://resolution.test', uuidv7());
  databases.push(db);
  return db;
}

function task(id: string, title: string, version = 1): LocalTreeTask {
  return {
    id,
    referenceId: `TASK-${id.slice(0, 6)}`,
    parentFolderId: null,
    title,
    status: 'TODO',
    rank: '1024',
    version,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function snapshot(tasks: LocalTreeTask[] = []): V2SnapshotResult {
  return {
    folders: [],
    tasks,
    notes: [],
    taskSteps: [],
    timePoints: [],
    placements: [],
    workflows: [],
    workflowStages: [],
    workflowTaskMemberships: [],
    settings: {
      ownerId,
      timezone: 'Asia/Shanghai',
      weekStartsOn: 1,
      defaultCaptureTarget: 'ROOT',
      version: 1,
      updatedAt: now,
    },
    cursor: '99',
  };
}

function transport(remote: V2SnapshotResult = snapshot()): V2SyncTransport {
  return {
    snapshot: vi.fn(async () => remote),
    pull: vi.fn(async (cursor) => ({ changes: [], nextCursor: cursor, hasMore: false })),
    push: vi.fn(async (request) => ({
      results: request.mutations.map((mutation) => ({
        mutationId: mutation.mutationId,
        status: 'applied' as const,
      })),
    })),
  };
}

describe('v2 conflict and rejection recovery', () => {
  it('stores editable conflict intent instead of an internal state-image envelope', async () => {
    const db = database();
    await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
    const local = task(uuidv7(), 'local', 2);
    const remote = { ...task(local.id, 'remote', 3) };
    const tx = transport(snapshot([remote]));
    tx.push = async (request) => ({
      results: request.mutations.map((mutation) => ({
        mutationId: mutation.mutationId,
        status: 'conflict' as const,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'conflict',
          details: { server: remote },
        },
      })),
    });
    const engine = new V2SyncEngine(db, uuidv7(), tx);
    await engine.queue({
      command: 'task.update',
      entityId: local.id,
      baseVersion: 1,
      occurredAt: now,
      payload: { title: 'local' },
      afterImage: { rows: [{ table: 'tasks', id: local.id, value: local }] },
    });
    await engine.sync();
    const conflict = await db.conflicts.toCollection().first();
    expect(conflict?.local).toEqual({ title: 'local' });
    expect(conflict?.local).not.toHaveProperty('rows');
  });

  it('atomically replaces rejected optimistic state and replays only independent mutations', async () => {
    const db = database();
    const first = task(uuidv7(), 'optimistic first');
    const second = task(uuidv7(), 'remote second', 2);
    const stale = task(uuidv7(), 'stale row');
    const placementId = uuidv7();
    const pointId = uuidv7();
    const localSecond = { ...second, title: 'independent edit', pendingSync: true };
    await db.tasks.bulkPut([first, localSecond, stale]);
    await db.placements.put({
      id: placementId,
      taskId: first.id,
      timePointId: pointId,
      rank: '1024',
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    });
    const engine = new V2SyncEngine(
      db,
      uuidv7(),
      transport(snapshot([{ ...first, title: 'authoritative first', version: 8 }, second])),
    );
    const rootId = await engine.queue({
      command: 'task.create',
      entityId: first.id,
      baseVersion: null,
      occurredAt: now,
      payload: { title: first.title },
      beforeImage: { rows: [{ table: 'tasks', id: first.id, value: null }] },
      afterImage: { rows: [{ table: 'tasks', id: first.id, value: first }] },
    });
    await engine.queue({
      command: 'placement.create',
      entityId: placementId,
      baseVersion: null,
      occurredAt: now,
      payload: { taskId: first.id, timePointId: pointId },
      afterImage: {
        rows: [
          {
            table: 'placements',
            id: placementId,
            value: await db.placements.get(placementId),
          },
        ],
      },
    });
    await engine.queue({
      command: 'task.update',
      entityId: second.id,
      baseVersion: 2,
      occurredAt: now,
      payload: { title: 'independent edit' },
      afterImage: { rows: [{ table: 'tasks', id: second.id, value: localSecond }] },
    });
    const root = await db.outbox.where('mutationId').equals(rootId).first();
    await db.outbox.update(root!.id!, {
      lastError: 'MUTATION_REJECTED',
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    });

    await engine.discardRejectedMutation(rootId);

    expect((await db.tasks.get(first.id))?.title).toBe('authoritative first');
    expect((await db.tasks.get(first.id))?.version).toBe(8);
    expect((await db.tasks.get(second.id))?.title).toBe('independent edit');
    expect(await db.tasks.get(stale.id)).toBeUndefined();
    expect(await db.placements.get(placementId)).toBeUndefined();
    expect(await db.outbox.count()).toBe(1);
    expect((await db.outbox.toCollection().first())?.entityId).toBe(second.id);
    expect((await db.syncMeta.get('v2:cursor'))?.value).toBe('99');
  });

  it('keeps every optimistic row and outbox item when authoritative recovery is unavailable', async () => {
    const db = database();
    const local = task(uuidv7(), 'keep me');
    await db.tasks.put(local);
    const tx = transport();
    tx.snapshot = async () => {
      throw new TypeError('offline');
    };
    const engine = new V2SyncEngine(db, uuidv7(), tx);
    const mutationId = await engine.queue({
      command: 'task.create',
      entityId: local.id,
      baseVersion: null,
      occurredAt: now,
      payload: { title: local.title },
      beforeImage: { rows: [{ table: 'tasks', id: local.id, value: null }] },
      afterImage: { rows: [{ table: 'tasks', id: local.id, value: local }] },
    });
    await expect(engine.discardRejectedMutation(mutationId)).rejects.toThrow('均未丢弃');
    expect(await db.outbox.count()).toBe(1);
    expect((await db.tasks.get(local.id))?.title).toBe('keep me');
  });

  it('replaces conflict retries in one transaction and filters merged payload fields', async () => {
    const db = database();
    const local = task(uuidv7(), 'local');
    const remote = { ...task(local.id, 'remote', 4) };
    await db.tasks.put(local);
    const mutationId = uuidv7();
    await db.outbox.add({
      mutationId,
      clientId: uuidv7(),
      command: 'task.update',
      entityId: local.id,
      baseVersion: 1,
      occurredAt: now,
      payload: { title: 'local' },
      attempts: 0,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      afterImage: { rows: [{ table: 'tasks', id: local.id, value: local }] },
    });
    const conflictId = await db.conflicts.add({
      mutationId,
      command: 'task.update',
      entityType: 'task',
      entityId: local.id,
      local: { title: 'local' },
      server: { server: remote },
      createdAt: now,
    });
    const engine = new V2SyncEngine(db, uuidv7(), transport(snapshot([remote])));
    await engine.resolveConflict(conflictId, 'merged', {
      title: 'merged',
      version: 999,
      rows: [],
    });
    const next = await db.outbox.toCollection().first();
    expect(await db.outbox.count()).toBe(1);
    expect(next?.mutationId).not.toBe(mutationId);
    expect(next?.baseVersion).toBe(4);
    expect(next?.payload).toEqual({ title: 'merged' });
    expect(next?.beforeImage?.rows[0]?.value).toMatchObject({ title: 'remote', version: 4 });
    expect(next?.afterImage?.rows[0]?.value).toMatchObject({ title: 'merged', version: 5 });
    expect((await db.tasks.get(local.id))?.title).toBe('merged');
    expect((await db.conflicts.get(conflictId))?.resolvedAt).toBeTruthy();
  });

  it('captures every dependent row for folder-tree rollback images', async () => {
    const db = database();
    const folderId = uuidv7();
    const childFolderId = uuidv7();
    const taskId = uuidv7();
    const noteId = uuidv7();
    const stepId = uuidv7();
    const placementId = uuidv7();
    const membershipId = uuidv7();
    await db.folders.bulkPut([
      {
        id: folderId,
        parentFolderId: null,
        title: 'root',
        rank: '1024',
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: childFolderId,
        parentFolderId: folderId,
        title: 'child',
        rank: '1024',
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.tasks.put({ ...task(taskId, 'child task'), parentFolderId: childFolderId });
    await db.notes.put({
      id: noteId,
      taskId,
      contentMarkdown: 'note',
      version: 1,
      updatedAt: now,
    });
    await db.taskSteps.put({
      id: stepId,
      taskId,
      title: 'step',
      noteMarkdown: '',
      status: 'TODO',
      rank: '1024',
      completedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.placements.put({
      id: placementId,
      taskId,
      timePointId: uuidv7(),
      rank: '1024',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.workflowTaskMemberships.put({
      id: membershipId,
      workflowId: uuidv7(),
      stageId: uuidv7(),
      taskId,
      rank: '1024',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const image = await captureLocalStateImage(db, 'folder.deleteTree', folderId, {});
    expect(new Set(image.rows.map((row) => `${row.table}:${row.id}`))).toEqual(
      new Set([
        `folders:${folderId}`,
        `folders:${childFolderId}`,
        `tasks:${taskId}`,
        `notes:${noteId}`,
        `taskSteps:${stepId}`,
        `placements:${placementId}`,
        `workflowTaskMemberships:${membershipId}`,
      ]),
    );
  });
});
