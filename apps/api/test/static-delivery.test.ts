import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';

describe('static delivery cache contract', () => {
  it('compresses immutable hashes but revalidates the shell and never caches private API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskdock-static-fixture-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'assets'));
    const source = 'console.log("taskdock");'.repeat(100);
    await writeFile(join(root, 'index.html'), '<!doctype html><div>TaskDock</div>');
    await writeFile(join(root, 'assets/app-AbCd1234.js'), source);
    await writeFile(join(root, 'assets/app-AbCd1234.js.gz'), gzipSync(source));
    await writeFile(join(root, 'sw.js'), '// service worker');
    const { app } = await buildServer({
      store: new MemoryStore(),
      config: { webRoot: root, logLevel: 'silent' },
    });
    try {
      const asset = await app.inject({
        url: '/assets/app-AbCd1234.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-encoding']).toBe('gzip');
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(asset.headers['vary']).toContain('Accept-Encoding');
      expect((await app.inject('/')).headers['cache-control']).toContain('must-revalidate');
      expect((await app.inject('/sw.js')).headers['cache-control']).toContain('must-revalidate');
      expect((await app.inject('/today')).headers['cache-control']).toContain('must-revalidate');
      const api = await app.inject('/api/v2/today?localDate=2026-10-20');
      expect(api.statusCode).toBe(401);
      expect(api.headers['cache-control']).toBe('private, no-store');
    } finally {
      await app.close();
      await rm(root, { recursive: true });
    }
  });
});
