import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';
import {
  BootstrapSnapshots,
  splitBootstrapPages,
  type BootstrapChange,
} from '../src/sync-bootstrap.js';
import { MemoryTreeStore } from '../src/tree-store.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function boot() {
  const token = randomUUID();
  const password = randomUUID();
  const { app } = await buildServer({
    store: new MemoryStore(),
    config: {
      bootstrapToken: token,
      logLevel: 'silent',
      webRoot: '/nonexistent/taskdock-web',
    },
  });
  apps.push(app);
  await app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap',
    payload: { token, username: 'snapshot-owner', password },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'snapshot-owner', password },
  });
  const login = response.json();
  const headers = {
    authorization: `Bearer ${login.accessToken}`,
    'x-client-id': randomUUID(),
    'idempotency-key': randomUUID(),
  };
  return { app, headers, hubId: login.hubId as string };
}

describe('immutable progressive bootstrap', () => {
  it('bounds HTTP incremental responses without skipping large notes or advancing past them', async () => {
    const { app, headers } = await boot();
    const before = (await app.inject({ url: '/api/v2/sync/status', headers })).json()
      .cursor as string;
    for (let index = 0; index < 2; index++) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v2/tasks',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { id: randomUUID(), title: `budget-${index}` },
      });
      expect(created.statusCode).toBe(201);
      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v2/tasks/${created.json().task.id}/note`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { baseVersion: created.json().note.version, contentMarkdown: '待办'.repeat(4000) },
      });
      expect(updated.statusCode).toBe(200);
    }
    const full = (await app.inject({ url: `/api/v2/sync/pull?cursor=${before}`, headers })).json();
    const collected: unknown[] = [];
    let cursor = before;
    let complete = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await app.inject({
        url: `/api/v2/sync/pull?cursor=${cursor}&maxBytes=16384`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const page = response.json();
      collected.push(...page.changes);
      expect(BigInt(page.nextCursor)).toBeGreaterThan(BigInt(cursor));
      if (Buffer.byteLength(response.body) > 16384) expect(page.changes).toHaveLength(1);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(collected).toEqual(full.changes);
    expect(cursor).toBe(full.nextCursor);
    expect((await app.inject({ url: '/api/v2/sync/pull?maxBytes=1', headers })).statusCode).toBe(
      400,
    );
  });

  it('reads Today without creating dates or advancing the account revision', async () => {
    const { app, headers } = await boot();
    const before = (await app.inject({ url: '/api/v2/sync/status', headers })).json();
    const today = await app.inject({ url: '/api/v2/today?localDate=2026-10-20', headers });
    expect(today.statusCode).toBe(200);
    expect(today.json()).toEqual({ point: null, items: [] });
    expect(today.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: '/api/v2/sync/status', headers })).json()).toEqual(before);
    const snapshot = (await app.inject({ url: '/api/v2/sync/snapshot', headers })).json();
    expect(snapshot.timePoints).toHaveLength(0);
    expect((await app.inject({ url: '/api/v2/today?localDate=invalid', headers })).statusCode).toBe(
      400,
    );
  });

  it('advertises capabilities, prioritizes preview, retains immutable pages and catches later changes', async () => {
    const { app, headers, hubId } = await boot();
    expect(hubId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await app.inject({ url: '/api/v2/sync/capabilities', headers })).json()).toMatchObject({
      pagedSnapshot: true,
    });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/tasks',
        headers,
        payload: { id: randomUUID(), title: '首屏任务' },
      })
    ).json();
    const preview = await app.inject({
      url: '/api/v2/sync/preview?localDate=2026-10-13',
      headers,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.json().coverage).toMatchObject({
      limit: 100,
      tasksHasMore: false,
      parentFolderId: null,
    });
    expect(preview.json().cursor).toMatch(/^\d+$/);
    expect(preview.json().complete).toBe(false);
    expect(
      preview.json().changes.some((c: BootstrapChange) => c.entityId === created.task.id),
    ).toBe(true);
    expect(preview.json().changes.some((c: BootstrapChange) => c.entityType === 'note')).toBe(
      false,
    );
    const manifest = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/sync/bootstrap',
        headers,
        payload: { localDate: '2026-10-13' },
      })
    ).json();
    const newTask = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/tasks',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { id: randomUUID(), title: '快照建立后的任务' },
      })
    ).json();
    const first = await app.inject({
      url: `/api/v2/sync/bootstrap/${manifest.snapshotId}?page=0`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      cursor: manifest.cursor,
      snapshotId: manifest.snapshotId,
      pageCount: manifest.pageCount,
    });
    expect(first.json().changes.some((c: BootstrapChange) => c.entityId === newTask.task.id)).toBe(
      false,
    );
    const replay = await app.inject({
      url: `/api/v2/sync/bootstrap/${manifest.snapshotId}?page=0`,
      headers,
    });
    expect(replay.json()).toEqual(first.json());
    const delta = (
      await app.inject({
        url: `/api/v2/sync/pull?cursor=${manifest.cursor}`,
        headers,
      })
    ).json();
    expect(delta.changes.some((c: BootstrapChange) => c.entityId === newTask.task.id)).toBe(true);
    const legacy = await app.inject({ url: '/api/v2/sync/snapshot', headers });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().tasks).toHaveLength(2);
  });

  it('requires authentication and never exposes another Hub snapshot', async () => {
    const first = await boot();
    const second = await boot();
    const manifest = (
      await first.app.inject({
        method: 'POST',
        url: '/api/v2/sync/bootstrap',
        headers: first.headers,
        payload: { localDate: '2026-10-13' },
      })
    ).json();
    expect(
      (
        await first.app.inject({
          url: `/api/v2/sync/bootstrap/${manifest.snapshotId}?page=0`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await second.app.inject({
          url: `/api/v2/sync/bootstrap/${manifest.snapshotId}?page=0`,
          headers: second.headers,
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (
        await first.app.inject({
          url: `/api/v2/sync/bootstrap/${manifest.snapshotId}?page=999`,
          headers: first.headers,
        })
      ).statusCode,
    ).toBe(410);
  });

  it('bounds pages by count and UTF-8 size without losing or duplicating entities', () => {
    const items: BootstrapChange[] = Array.from({ length: 501 }, (_, i) => ({
      seq: '42',
      entityType: 'note',
      entityId: String(i),
      entityVersion: 1,
      operation: 'upsert',
      snapshot: { contentMarkdown: '中'.repeat(1_000) },
    }));
    const pages = splitBootstrapPages(items);
    expect(pages.flat()).toEqual(items);
    expect(pages.every((page) => page.length <= 200)).toBe(true);
    expect(
      pages.every(
        (page) =>
          page.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), 0) <= 512_000,
      ),
    ).toBe(true);
  });

  it('reports truncated preview coverage and coalesces simultaneous snapshot creation', async () => {
    const tree = new MemoryTreeStore();
    const owner = randomUUID();
    for (let i = 0; i < 101; i++)
      tree.createTask(owner, { id: randomUUID(), title: `task ${i}`, parentFolderId: null });
    const bootstrap = new BootstrapSnapshots(tree);
    const preview = await bootstrap.preview(owner, '2026-10-18', null);
    expect(preview.coverage.tasksHasMore).toBe(true);
    expect(preview.changes.filter((item) => item.entityType === 'task')).toHaveLength(100);
    expect(preview.complete).toBe(false);
    const manifests = await Promise.all([
      bootstrap.create(owner, '2026-10-18'),
      bootstrap.create(owner, '2026-10-18'),
    ]);
    expect(manifests[0]!.snapshotId).toBe(manifests[1]!.snapshotId);
    tree.createTask(owner, { id: randomUUID(), title: 'later', parentFolderId: null });
    const next = await bootstrap.create(owner, '2026-10-18');
    expect(next.cursor).not.toBe(manifests[0]!.cursor);
  });
});
