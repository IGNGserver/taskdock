import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const root = process.cwd();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('could not allocate a smoke-test port');
  return port;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(url: string, child: ChildProcess): Promise<Response> {
  let lastError = 'not started';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`API process exited early with code ${child.exitCode}: ${lastError}`);
    try {
      const response = await fetchWithTimeout(url);
      if (response.ok || response.status >= 400) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const apiEntry = join(root, 'apps', 'api', 'dist', 'main.js');
  const webIndex = join(root, 'apps', 'web', 'dist', 'index.html');
  try {
    await access(apiEntry);
    await access(webIndex);
  } catch {
    console.error('FAIL: built API or Web artifact is missing; run pnpm build first.');
    process.exitCode = 1;
    return;
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrapToken = 'server-smoke-bootstrap-token-change-before-use-123456';
  const child = spawn('node', [apiEntry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEV_MEMORY_STORE: 'true',
      APP_ORIGIN: baseUrl,
      APP_PORT: String(port),
      BOOTSTRAP_TOKEN: bootstrapToken,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );

  try {
    const live = await waitFor(`${baseUrl}/health/live`, child);
    assert(live.status === 200, `live health returned ${live.status}`);
    const ready = await fetchWithTimeout(`${baseUrl}/health/ready`);
    assert(ready.status === 200, `ready health returned ${ready.status}`);
    let indexBody = '';
    for (const path of ['/', '/today']) {
      const response = await fetchWithTimeout(`${baseUrl}${path}`);
      const body = await response.text();
      assert(response.status === 200, `${path} returned ${response.status}`);
      assert(body.includes('<div id="root">'), `${path} did not return the built SPA shell`);
      if (path === '/') {
        indexBody = body;
        assert(
          body.includes('<script src="/theme-preload.js"></script>'),
          'SPA shell does not load the CSP-safe theme preloader',
        );
        assert(
          !body.includes("window.matchMedia?.('(prefers-color-scheme: dark)')"),
          'SPA shell still contains the blocked inline theme prelude',
        );
        const themePreload = await fetchWithTimeout(`${baseUrl}/theme-preload.js`);
        const themePreloadBody = await themePreload.text();
        assert(themePreload.status === 200, 'theme preloader returned a non-200 response');
        assert(
          themePreloadBody.includes('__DEVTODO_NATIVE_THEME__'),
          'theme preloader does not support native theme state',
        );
        const csp = response.headers.get('content-security-policy') ?? '';
        assert(csp.includes("script-src 'self'"), 'SPA shell is missing the strict script CSP');
      }
    }
    assert(indexBody.length > 0, 'SPA index response was empty');
    const version = await fetchWithTimeout(`${baseUrl}/version`);
    const versionBody = (await version.json()) as { appVersion?: unknown };
    assert(version.status === 200 && typeof versionBody.appVersion === 'string', 'version failed');
    const unknown = await fetchWithTimeout(`${baseUrl}/api/v1/does-not-exist`);
    const unknownBody = (await unknown.json()) as { code?: unknown };
    assert(unknown.status === 404, `unknown API route returned ${unknown.status}`);
    assert(unknownBody.code === 'NOT_FOUND', 'unknown API route was not a JSON API error');

    const bootstrap = await fetchWithTimeout(`${baseUrl}/api/v1/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: bootstrapToken,
        username: 'server-smoke-owner',
        password: 'server-smoke-password-change-me',
      }),
    });
    assert(bootstrap.status === 201, `bootstrap returned ${bootstrap.status}`);
    const login = await fetchWithTimeout(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'server-smoke-owner',
        password: 'server-smoke-password-change-me',
      }),
    });
    const loginBody = (await login.json()) as { accessToken?: unknown };
    assert(login.status === 200 && typeof loginBody.accessToken === 'string', 'login failed');
    const me = await fetchWithTimeout(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${loginBody.accessToken}` },
    });
    const meBody = (await me.json()) as { user?: Record<string, unknown> };
    assert(me.status === 200, `/me returned ${me.status}`);
    assert(!('passwordHash' in (meBody.user ?? {})), '/me leaked a private user field');
    console.log(
      'PASS: built API process stayed alive and separated health, SPA, and JSON API routes.',
    );
  } catch (error) {
    console.error('FAIL: built API/Web process smoke failed.');
    console.error(error);
    console.error(output);
    process.exitCode = 1;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    const result = await Promise.race([
      exit,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000)),
    ]);
    if (result && result.code !== null && result.code !== 0 && process.exitCode === undefined) {
      console.error(`FAIL: API process exited unexpectedly (code=${result.code}).`);
      console.error(output);
      process.exitCode = 1;
    }
  }
}

void main().catch((error: unknown) => {
  console.error('FAIL: built API/Web process smoke crashed.');
  console.error(error);
  process.exitCode = 1;
});
