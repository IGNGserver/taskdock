import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';

type PwaFixture = { origin: string; deployUpdate: () => void };
const test = base.extend<{ pwaFixture: PwaFixture }>({
  pwaFixture: async ({ browserName }, provideFixture) => {
    const dist = resolve(
      process.env['PWA_MULTITAB_DIST_DIR'] ?? fileURLToPath(new URL('../dist/', import.meta.url)),
    );
    let version = 1;
    const user = {
      id: '00000000-0000-7000-8000-000000000994',
      username: `pwa-update-fixture-${browserName}`,
      createdAt: '2026-10-26T00:00:00.000Z',
    };
    const settings = {
      ownerId: user.id,
      timezone: 'Asia/Shanghai',
      weekStartsOn: 1,
      defaultCaptureTarget: 'ROOT',
      version: 1,
      updatedAt: user.createdAt,
    };
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json',
    };
    const server: Server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path.startsWith('/api/')) {
          response.setHeader('Cache-Control', 'private, no-store');
          response.setHeader('Content-Type', 'application/json');
          let body: unknown = { items: [] };
          if (path.endsWith('/bootstrap/status')) body = { initialized: true };
          else if (path.endsWith('/auth/refresh'))
            body = { accessToken: 'pwa-update-synthetic-token' };
          else if (path.endsWith('/me'))
            body = {
              user,
              settings,
              capabilities: { syncProtocolVersion: 2, websocket: false, offline: true },
            };
          else if (/\/sync\/(preview|bootstrap)/.test(path) || path.endsWith('/today')) {
            response.writeHead(404);
            response.end('{"code":"NOT_FOUND"}');
            return;
          } else if (path.endsWith('/sync/snapshot'))
            body = {
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
              cursor: '0',
            };
          else if (path.endsWith('/sync/pull'))
            body = { changes: [], nextCursor: '0', hasMore: false };
          else if (path.endsWith('/sync/push')) body = { protocolVersion: 2, results: [] };
          else if (path.endsWith('/settings')) body = settings;
          else if (path.endsWith('/devices')) body = [];
          response.end(JSON.stringify(body));
          return;
        }
        const navigation = !extname(path);
        const file = resolve(dist, navigation ? 'index.html' : '.' + path);
        if (!file.startsWith(dist + sep) || !(await stat(file)).isFile()) {
          response.writeHead(404);
          response.end();
          return;
        }
        let bytes = await readFile(file);
        if (path === '/sw.js') {
          bytes = Buffer.from(
            bytes.toString() +
              `\nself.addEventListener('message',event=>{if(event.data?.type==='PWA_FIXTURE_VERSION')event.ports[0]?.postMessage(${version})});\n`,
          );
          response.setHeader('Service-Worker-Allowed', '/');
        }
        response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
        response.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
        response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    server.on('upgrade', (_request, socket) => socket.destroy());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('PWA fixture did not bind');
    try {
      await provideFixture({
        origin: `http://127.0.0.1:${address.port}`,
        deployUpdate: () => {
          version += 1;
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
  },
});

test.use({
  serviceWorkers: 'allow',
  reducedMotion: 'reduce',
  viewport: { width: 1280, height: 900 },
});
test.beforeEach(() => {
  test.skip(
    !['chromium', 'webkit'].includes(test.info().project.name),
    'real multi-tab Service Worker lifecycle in Chromium and WebKit',
  );
});
const documentToken = async (page: Page) => {
  try {
    return await page.evaluate(
      () => (window as Window & { pwaDocumentToken: string }).pwaDocumentToken,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /Execution context was destroyed|Cannot find context/.test(error.message)
    )
      return undefined;
    throw error;
  }
};
const controllerVersion = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = window.setTimeout(
          () => reject(new Error('worker version reply timed out')),
          5000,
        );
        channel.port1.onmessage = (event) => {
          window.clearTimeout(timeout);
          resolve(event.data as number);
        };
        navigator.serviceWorker.controller?.postMessage({ type: 'PWA_FIXTURE_VERSION' }, [
          channel.port2,
        ]);
      }),
  );

test('a consented update reloads only its tab and another tab can finish its draft before reopening', async ({
  context,
  pwaFixture,
}) => {
  test.setTimeout(60_000);
  await context.addInitScript(() => {
    (window as Window & { pwaDocumentToken: string }).pwaDocumentToken = crypto.randomUUID();
  });
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto(pwaFixture.origin + '/tree');
  await expect(first.locator('.app-frame')).toBeVisible();
  await first.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  // Both pages now start under an existing controller, as installed PWA windows do.
  await first.reload();
  await expect(first.getByRole('button', { name: '新建文件夹', exact: true })).toBeVisible();
  await second.goto(pwaFixture.origin + '/tree');
  await expect(second.getByRole('button', { name: '新建文件夹', exact: true })).toBeVisible();
  await expect.poll(() => controllerVersion(first)).toBe(1);
  await expect.poll(() => controllerVersion(second)).toBe(1);
  const firstToken = await documentToken(first);
  const secondToken = await documentToken(second);
  await second.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const draft = second.getByRole('textbox', { name: '文件夹名称', exact: true });
  await draft.fill('Keep this unsaved folder draft');
  pwaFixture.deployUpdate();
  await first.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await first.getByRole('button', { name: '查看更新', exact: true }).click();
  first.once('dialog', (dialog) => void dialog.accept());
  await first.getByRole('button', { name: '更新并重新打开', exact: true }).click();
  await expect
    .poll(async () => {
      const token = await documentToken(first);
      return Boolean(token && token !== firstToken);
    })
    .toBe(true);
  await expect(first.locator('.app-frame')).toBeVisible();
  await expect.poll(() => controllerVersion(second)).toBe(2);
  expect(await documentToken(second)).toBe(secondToken);
  await expect(draft).toHaveValue('Keep this unsaved folder draft');
  // The other window has no waiting worker now. Its explicit confirmation must
  // still reopen it after the local draft is deliberately closed by the user.
  await second
    .getByRole('dialog', { name: '新建文件夹', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await second.getByRole('button', { name: '查看更新', exact: true }).click();
  second.once('dialog', (dialog) => void dialog.accept());
  await second.getByRole('button', { name: '更新并重新打开', exact: true }).click();
  await expect
    .poll(async () => {
      const token = await documentToken(second);
      return Boolean(token && token !== secondToken);
    })
    .toBe(true);
  await expect(second.locator('.app-frame')).toBeVisible();
  await expect.poll(() => controllerVersion(second)).toBe(2);
});
