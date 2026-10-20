import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevTodoDatabase } from '@devtodo/sync-client';
import { uuidv7 } from '@devtodo/contracts';
import { requestV2 } from '../src/api.js';
import {
  activateLocalCache,
  cacheResponse,
  deactivateLocalCache,
  readCachedV2,
} from '../src/local.js';

let db: DevTodoDatabase;
beforeEach(() => {
  db = new DevTodoDatabase('https://hub.test', uuidv7());
  activateLocalCache(db, uuidv7());
  vi.stubGlobal('location', { origin: 'https://hub.test', protocol: 'https:' });
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(async () => {
  deactivateLocalCache(db);
  await db.delete();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('v2 local-first reads', () => {
  it('reopens only exact covered directory pages during bootstrap and projects pending edits', async () => {
    const id = uuidv7();
    const speculative = uuidv7();
    await db.syncMeta.put({ key: 'v2:bootstrap', value: '{"page":0}' });
    const task = {
      id,
      parentFolderId: null,
      title: 'covered',
      status: 'TODO' as const,
      rank: '1',
      version: 1,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
    await cacheResponse('/v2/tree/children?parentFolderId=root&limit=100', {
      items: [{ kind: 'TASK', task }],
      parentFolderId: null,
      nextCursor: 'server-next',
    });
    await db.tasks.put({ ...task, id: speculative, title: 'preview only' });
    await db.tasks.update(id, { title: 'pending edit', pendingSync: true });
    db.close();
    await db.open();
    expect(await readCachedV2('/tree/children?limit=100&parentFolderId=root')).toMatchObject({
      items: [{ task: { id, title: 'pending edit' } }],
      nextCursor: 'server-next',
    });
    expect(
      await readCachedV2('/tree/children?parentFolderId=root&limit=100&cursor=server-next'),
    ).toBeUndefined();
    expect(await readCachedV2('/tree/children?parentFolderId=root')).toBeUndefined();
    expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
    await db.tasks.delete(id);
    expect(await readCachedV2('/tree/children?parentFolderId=root&limit=100')).toBeUndefined();
  });

  it('paginates complete local data and never sends local cursors to the server', async () => {
    await db.syncMeta.put({ key: 'v2:cursor', value: '10' });
    const now = '2026-10-20T00:00:00.000Z';
    await db.tasks.bulkPut(
      Array.from({ length: 3 }, (_, index) => ({
        id: uuidv7(),
        parentFolderId: null,
        title: `task ${index}`,
        status: 'TODO' as const,
        rank: String(index + 1),
        version: 1,
        createdAt: now,
        updatedAt: now,
      })),
    );
    vi.stubGlobal('navigator', { onLine: false });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const first = await requestV2<{ items: unknown[]; nextCursor: string }>(
      '/tree/children?parentFolderId=root&limit=2',
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^local\./);
    const second = await requestV2<{ items: unknown[]; nextCursor: null }>(
      `/tree/children?parentFolderId=root&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const row = await db.tasks.toCollection().first();
    await db.tasks.update(row!.id, { title: 'changed', version: 2 });
    await expect(
      requestV2(
        `/tree/children?parentFolderId=root&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_CURSOR_EXPIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reopens an authoritative Today page before global bootstrap has completed', async () => {
    const date = '2026-10-20';
    const pointId = uuidv7();
    const taskId = uuidv7();
    const placementId = uuidv7();
    await db.syncMeta.put({ key: 'v2:bootstrap', value: '{"page":0}' });
    await cacheResponse(`/v2/today?localDate=${date}`, {
      point: { id: pointId, type: 'DATE', localDate: date, rank: '1', version: 1 },
      items: [
        {
          id: placementId,
          taskId,
          timePointId: pointId,
          rank: '1',
          version: 1,
          task: {
            id: taskId,
            parentFolderId: null,
            title: 'cached',
            status: 'TODO',
            rank: '1',
            version: 1,
          },
        },
      ],
    });
    await db.tasks.update(taskId, { title: 'local edit' });
    expect(await readCachedV2(`/today?localDate=${date}`)).toMatchObject({
      point: { id: pointId },
      items: [{ task: { title: 'local edit' } }],
    });
    expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
    expect(await readCachedV2('/today?localDate=2026-10-21')).toBeUndefined();
    expect(await readCachedV2('/tree/children?parentFolderId=root')).toBeUndefined();
    await db.tasks.delete(taskId);
    expect(await readCachedV2(`/today?localDate=${date}`)).toBeUndefined();
  });

  it('extends a covered empty Today with offline edits and survives reopening the database', async () => {
    const date = '2026-10-20';
    await cacheResponse(`/v2/today?localDate=${date}`, { point: null, items: [] });
    expect(await readCachedV2(`/today?localDate=${date}`)).toEqual({ point: null, items: [] });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    const point = await requestV2<{ id: string }>('/time-points/date', {
      method: 'POST',
      body: JSON.stringify({ localDate: date }),
    });
    const result = await requestV2<{ task: { id: string } }>('/tasks', {
      method: 'POST',
      body: JSON.stringify({ parentFolderId: null, title: 'offline capture' }),
    });
    await requestV2('/placements', {
      method: 'POST',
      body: JSON.stringify({ taskId: result.task.id, timePointId: point.id }),
    });
    db.close();
    await db.open();
    expect(await readCachedV2(`/today?localDate=${date}`)).toMatchObject({
      items: [{ task: { title: 'offline capture' } }],
    });
    expect(await db.outbox.count()).toBe(3);
    expect(await db.syncMeta.get('v2:cursor')).toBeUndefined();
  });

  it('does not mistake speculative preview rows for membership in the covered Today page', async () => {
    const pointId = uuidv7();
    const date = '2026-10-20';
    await cacheResponse(`/v2/today?localDate=${date}`, {
      point: { id: pointId, type: 'DATE', localDate: date, rank: '1', version: 1 },
      items: [],
    });
    await db.placements.put({
      id: uuidv7(),
      timePointId: pointId,
      taskId: uuidv7(),
      rank: '1',
      version: 1,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(await readCachedV2(`/today?localDate=${date}`)).toMatchObject({ items: [] });
    await db.syncMeta.put({ key: 'v2:read-invalidated', value: 'delete-in-progress' });
    expect(await readCachedV2(`/today?localDate=${date}`)).toBeUndefined();
  });

  it('does not invalidate a cold page read when immutable bootstrap begins in parallel', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/sync/bootstrap')
          ? Promise.resolve(new Response('{"snapshotId":"immutable"}'))
          : new Promise<Response>((resolve) => {
              finish = resolve;
            }),
      ),
    );
    const pending = requestV2('/today?localDate=2026-10-20');
    await vi.waitFor(() => expect(finish).toBeDefined());
    await requestV2('/sync/bootstrap', { method: 'POST', body: '{"localDate":"2026-10-20"}' });
    finish(new Response('{"point":null,"items":[]}'));
    expect(await pending).toEqual({ point: null, items: [] });
  });

  it('invalidates derived reads after acknowledged deletion without moving the sync cursor', async () => {
    const id = uuidv7();
    await db.syncMeta.put({ key: 'v2:cursor', value: '9' });
    await db.tasks.put({
      id,
      parentFolderId: null,
      title: 'delete me',
      status: 'TODO',
      rank: '1',
      version: 1,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"deleted":true}')),
    );
    await requestV2(`/tasks/${id}`, { method: 'DELETE', body: '{"baseVersion":1}' });
    expect((await db.tasks.get(id))?.deletedAt).toBeTruthy();
    expect((await db.syncMeta.get('v2:cursor'))?.value).toBe('9');
    expect(await readCachedV2('/tree/children?parentFolderId=root')).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it('does not let a pre-mutation read overwrite the acknowledged version', async () => {
    const id = uuidv7();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init: RequestInit) =>
        init.method === 'PATCH'
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  id,
                  parentFolderId: null,
                  title: 'new',
                  status: 'TODO',
                  rank: '1',
                  version: 2,
                }),
              ),
            )
          : new Promise<Response>((resolve) => {
              finish = resolve;
            }),
      ),
    );
    const pending = requestV2(`/tasks/${id}`);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await requestV2(`/tasks/${id}`, { method: 'PATCH', body: '{"title":"new","baseVersion":1}' });
    finish(new Response(JSON.stringify({ task: { id, title: 'old', version: 1 } })));
    await expect(pending).rejects.toThrow('读取期间数据已变化');
    expect(await db.tasks.get(id)).toMatchObject({ title: 'new', version: 2 });
  });

  it('preserves authoritative online validation instead of falsely acknowledging a rejected edit', async () => {
    const id = uuidv7();
    await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
    await db.settings.put({
      ownerId: uuidv7(),
      timezone: 'Asia/Shanghai',
      weekStartsOn: 1,
      defaultCaptureTarget: 'ROOT',
      version: 1,
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    await db.tasks.put({
      id,
      parentFolderId: null,
      title: 'before',
      status: 'TODO',
      rank: '1024',
      version: 1,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const fetch = vi.fn(
      async () => new Response('{"code":"VERSION_CONFLICT","message":"版本冲突"}', { status: 409 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      requestV2(`/tasks/${id}`, {
        method: 'PATCH',
        body: '{"title":"edited","baseVersion":1}',
      }),
    ).rejects.toThrow('版本冲突');
    expect(fetch).toHaveBeenCalledOnce();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.tasks.get(id)).toMatchObject({ title: 'before', version: 1 });
  });

  it('renders a complete cached empty list without waiting for blackholed network', async () => {
    await db.syncMeta.put({ key: 'v2:cursor', value: '0' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(await requestV2('/tree/children?parentFolderId=root')).toMatchObject({ items: [] });
    await vi.advanceTimersByTimeAsync(15_001);
  });

  it('does not turn an empty partial cache into authoritative empty data', async () => {
    expect(await readCachedV2('/tree/children?parentFolderId=root')).toBeUndefined();
    await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
    await db.syncMeta.put({ key: 'v2:bootstrap', value: '{}' });
    expect(await readCachedV2('/tree/children?parentFolderId=root')).toBeUndefined();
  });

  it('keeps search, unsupported filters and deletion previews on the network', async () => {
    await db.syncMeta.put({ key: 'v2:cursor', value: '1' });
    expect(await readCachedV2('/tasks?q=needle')).toBeUndefined();
    expect(await readCachedV2('/tasks?status=DONE')).toBeUndefined();
    expect(await readCachedV2('/folders/unknown/delete-preview')).toBeUndefined();
  });

  it('aborts the underlying transfer at deadline instead of returning partial local data', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let aborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(init.signal?.reason);
            });
          }),
      ),
    );
    const result = expect(requestV2('/tree/children?parentFolderId=root')).rejects.toThrow(
      '请求超时',
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_001);
    await result;
    expect(aborted).toBe(true);
  });

  it('does not write an old response into a newly active account', async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = requestV2('/tasks');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const other = new DevTodoDatabase('https://hub.test', uuidv7());
    activateLocalCache(other, uuidv7());
    try {
      finish!(new Response('{"items":[]}'));
      await expect(pending).rejects.toThrow('会话已变化');
      expect(await other.tasks.count()).toBe(0);
    } finally {
      deactivateLocalCache(other);
      await other.delete();
    }
  });
});
