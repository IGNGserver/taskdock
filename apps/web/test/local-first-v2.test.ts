import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevTodoDatabase } from '@devtodo/sync-client';
import { uuidv7 } from '@devtodo/contracts';
import { requestV2 } from '../src/api.js';
import { activateLocalCache, deactivateLocalCache, readCachedV2 } from '../src/local.js';

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
  it('commits a versioned edit and its Outbox atomically without waiting on network', async () => {
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
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      await requestV2(`/tasks/${id}`, {
        method: 'PATCH',
        body: '{"title":"edited","baseVersion":1}',
      }),
    ).toMatchObject({ title: 'edited', version: 2 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.outbox.count()).toBe(1);
    expect((await db.outbox.toArray())[0]).toMatchObject({
      command: 'task.update',
      baseVersion: 1,
    });
    expect(await db.tasks.get(id)).toMatchObject({ title: 'edited', pendingSync: true });
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
