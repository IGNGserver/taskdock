import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';
import { splitBootstrapPages, type BootstrapChange } from '../src/sync-bootstrap.js';

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
});
