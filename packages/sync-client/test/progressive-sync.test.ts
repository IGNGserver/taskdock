import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@devtodo/contracts';
import {
  DevTodoDatabase,
  V2SyncEngine,
  type V2SyncTransport,
  type V2BootstrapManifest,
  type PullResult,
  type LocalTreeTask,
} from '../src/index.js';

const databases: DevTodoDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()));
  vi.unstubAllGlobals();
});
function database() {
  vi.stubGlobal('navigator', { onLine: true });
  const db = new DevTodoDatabase('https://progressive.test', uuidv7());
  databases.push(db);
  return db;
}
const ownerId = uuidv7();
const manifest: V2BootstrapManifest = {
  snapshotId: uuidv7(),
  cursor: '41',
  expiresAt: '2099-01-01T00:00:00.000Z',
  pageCount: 2,
  protocolVersion: 2,
};
function task(id = uuidv7(), title = 'remote'): LocalTreeTask {
  return {
    id,
    parentFolderId: null,
    title,
    status: 'TODO',
    rank: '1024',
    version: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}
function change(row: LocalTreeTask): PullResult['changes'][number] {
  return {
    seq: '41',
    entityType: 'task',
    entityId: row.id,
    entityVersion: row.version,
    operation: 'upsert',
    snapshot: row,
  };
}
function transport(): V2SyncTransport {
  return {
    snapshot: vi.fn(async () => ({
      folders: [],
      tasks: [],
      notes: [],
      taskSteps: [],
      timePoints: [],
      placements: [],
      workflows: [],
      workflowStages: [],
      workflowTaskMemberships: [],
      cursor: '41',
      settings: {
        ownerId,
        timezone: 'Asia/Shanghai',
        weekStartsOn: 1,
        defaultCaptureTarget: 'ROOT',
        version: 1,
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
    })),
    beginBootstrap: vi.fn(async () => manifest),
    bootstrapPage: vi.fn(async (_id, page) => ({
      ...manifest,
      page,
      nextPage: page === 0 ? 1 : null,
      changes: [],
    })),
    preview: vi.fn(async () => ({ complete: false, changes: [] })),
    pull: vi.fn(async (cursor) => ({ changes: [], nextCursor: cursor, hasMore: false })),
    push: vi.fn(async (request) => ({
      results: request.mutations.map((mutation) => ({
        mutationId: mutation.mutationId,
        status: 'applied',
      })),
    })),
  };
}

describe('v2 progressive sync', () => {
  it('restarts an expired immutable snapshot once and drops old seen rows, not local edits', async () => {
    const db = database();
    const tx = transport();
    const old = task();
    const replacement = task();
    let current = manifest;
    let creates = 0;
    tx.beginBootstrap = async () => {
      creates++;
      current = { ...manifest, snapshotId: uuidv7(), cursor: String(40 + creates) };
      return current;
    };
    tx.bootstrapPage = async (_id, page) => {
      if (creates === 1 && page === 1) throw { code: 'SYNC_CURSOR_EXPIRED' };
      return {
        ...current,
        page,
        nextPage: page === 0 ? 1 : null,
        changes: page === 0 ? [change(creates === 1 ? old : replacement)] : [],
      };
    };
    await new V2SyncEngine(db, uuidv7(), tx).sync();
    expect(creates).toBe(2);
    expect(await db.tasks.get(old.id)).toBeUndefined();
    expect(await db.tasks.get(replacement.id)).toBeDefined();
    expect((await db.syncMeta.get('v2:cursor'))?.value).toBe('42');
    expect(await db.syncMeta.where('key').startsWith('v2:seen:').count()).toBe(0);
  });

  it('bounds expiry restarts and keeps an interrupted checkpoint for the next round', async () => {
    const db = database();
    const tx = transport();
    tx.bootstrapPage = async () => {
      throw { code: 'SYNC_CURSOR_EXPIRED' };
    };
    await expect(new V2SyncEngine(db, uuidv7(), tx).sync()).rejects.toMatchObject({
      code: 'SYNC_CURSOR_EXPIRED',
    });
    expect(tx.beginBootstrap).toHaveBeenCalledTimes(2);
    expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
    expect(await db.syncMeta.get('v2:bootstrap')).toBeDefined();
  });

  it('resumes the committed page without advancing cursor or pruning on partial failure', async () => {
    const db = database();
    const stale = task();
    const first = task();
    const second = task();
    const pending = task(uuidv7(), 'local');
    await db.tasks.bulkPut([stale, pending]);
    const tx = transport();
    const pages: number[] = [];
    let failed = false;
    tx.bootstrapPage = async (_id, page) => {
      pages.push(page);
      if (page === 1 && !failed) {
        failed = true;
        throw new TypeError('network interrupted');
      }
      return {
        ...manifest,
        page,
        nextPage: page === 0 ? 1 : null,
        changes: [change(page === 0 ? first : second)],
      };
    };
    const engine = new V2SyncEngine(db, uuidv7(), tx);
    await engine.queue({
      command: 'task.create',
      entityId: pending.id,
      baseVersion: null,
      occurredAt: pending.createdAt,
      payload: { title: pending.title },
      afterImage: { rows: [{ table: 'tasks', id: pending.id, value: pending }] },
    });
    await expect(engine.sync()).rejects.toThrow('network interrupted');
    expect(await db.tasks.get(first.id)).toBeDefined();
    expect(await db.tasks.get(stale.id)).toBeDefined();
    expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
    expect(tx.push).not.toHaveBeenCalled();
    await engine.sync();
    expect(pages).toEqual([0, 1, 1]);
    expect(tx.beginBootstrap).toHaveBeenCalledTimes(1);
    expect(tx.preview).toHaveBeenCalledTimes(1);
    expect(tx.snapshot).not.toHaveBeenCalled();
    expect(await db.tasks.get(stale.id)).toBeUndefined();
    expect(await db.tasks.get(pending.id)).toMatchObject({ title: 'local' });
    expect(await db.tasks.get(second.id)).toBeDefined();
    expect((await db.syncMeta.get('v2:cursor'))?.value).toBe('41');
    expect(await db.syncMeta.get('v2:bootstrap')).toBeUndefined();
  });

  it('rejects an invalid page without losing its checkpoint or cached rows', async () => {
    const db = database();
    const tx = transport();
    const stale = task();
    await db.tasks.put(stale);
    tx.bootstrapPage = async () => ({
      ...manifest,
      cursor: '99',
      page: 0,
      nextPage: 1,
      changes: [],
    });
    await expect(new V2SyncEngine(db, uuidv7(), tx).sync()).rejects.toThrow('快照页面无效');
    expect(await db.tasks.get(stale.id)).toBeDefined();
    expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
    expect(JSON.parse((await db.syncMeta.get('v2:bootstrap'))!.value).page).toBe(0);
  });

  it('falls back only for missing paged routes, never for a network error', async () => {
    const db = database();
    const tx = transport();
    tx.preview = async () => {
      throw new TypeError('fetch failed');
    };
    const engine = new V2SyncEngine(db, uuidv7(), tx);
    await expect(engine.sync()).rejects.toThrow('fetch failed');
    expect(tx.snapshot).not.toHaveBeenCalled();
    tx.preview = async () => {
      throw { status: 404 };
    };
    await engine.sync();
    expect(tx.snapshot).toHaveBeenCalledOnce();
  });

  it('commits pull cursor per page so a later failure does not replay the whole feed', async () => {
    const db = database();
    const tx = transport();
    await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
    tx.pull = vi.fn(async (cursor) => {
      if (cursor === '2') throw new TypeError('offline');
      return { changes: [change(task())], nextCursor: '2', hasMore: true };
    });
    await expect(new V2SyncEngine(db, uuidv7(), tx).sync()).rejects.toThrow('offline');
    expect((await db.syncMeta.get('v2:cursor'))?.value).toBe('2');
    expect(tx.push).not.toHaveBeenCalled();
  });

  it('bounds UTF-8 upload bytes and gives reads the first turn', async () => {
    const db = database();
    const tx = transport();
    const order: string[] = [];
    await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
    tx.pull = async (cursor) => {
      order.push('read');
      return { changes: [], nextCursor: cursor, hasMore: false };
    };
    const batches: number[] = [];
    tx.push = async (request) => {
      order.push('push');
      batches.push(new TextEncoder().encode(JSON.stringify(request)).byteLength);
      return {
        results: request.mutations.map((row) => ({
          mutationId: row.mutationId,
          status: 'applied',
        })),
      };
    };
    const engine = new V2SyncEngine(db, uuidv7(), tx);
    for (let i = 0; i < 5; i++)
      await engine.queue({
        command: 'note.update',
        entityId: uuidv7(),
        baseVersion: 1,
        occurredAt: '2026-10-20T00:00:00.000Z',
        payload: { contentMarkdown: '中'.repeat(30_000) },
      });
    await engine.sync();
    expect(order).toEqual(['read', 'push', 'read']);
    expect(batches[0]).toBeLessThan(256_000);
    expect(await db.outbox.count()).toBe(3);
  });
});
