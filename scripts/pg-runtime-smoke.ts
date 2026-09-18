import { access } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '../packages/database/src/index.js';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const databaseUrl = process.env['DATABASE_URL'];
const pgCtl = process.env['PG_CTL'];
const pgData = process.env['PGDATA'] ?? process.env['PG_DATA'];
const apiEntry = join(root, 'apps', 'api', 'dist', 'main.js');

type ApiProcess = {
  child: ChildProcess;
  output: string;
};

type JsonResponse = {
  response: Response;
  body: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('could not allocate a runtime smoke port');
  return port;
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForStatus(
  baseUrl: string,
  path: string,
  status: number,
  child: ApiProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null)
      throw new Error(`API exited early with code ${child.child.exitCode}: ${child.output}`);
    try {
      const result = await requestJson(baseUrl, path, {}, 2_000);
      if (result.response.status === status) return;
      lastError = `HTTP ${result.response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${path}=${status}: ${lastError}`);
}

function startApi(
  port: number,
  runtime: { bootstrapToken: string; accessTokenSecret: string; refreshTokenPepper: string },
): ApiProcess {
  const child = spawn('node', [apiEntry], {
    cwd: join(root, 'apps', 'api'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEV_MEMORY_STORE: 'false',
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      APP_PORT: String(port),
      APP_VERSION: 'pg-runtime-smoke',
      COMMIT_SHA: 'runtime-smoke',
      BUILD_TIME: new Date().toISOString(),
      BOOTSTRAP_TOKEN: runtime.bootstrapToken,
      ACCESS_TOKEN_SECRET: runtime.accessTokenSecret,
      REFRESH_TOKEN_PEPPER: runtime.refreshTokenPepper,
      CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      NATIVE_ALLOWED_ORIGINS: 'devtodo://app,capacitor://localhost,http://localhost',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result: ApiProcess = { child, output: '' };
  child.stdout?.on('data', (chunk: Buffer) => {
    result.output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    result.output += chunk.toString();
  });
  return result;
}

async function stopApi(api: ApiProcess): Promise<void> {
  if (api.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => api.child.once('exit', () => resolve()));
  api.child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
  if (api.child.exitCode === null) api.child.kill('SIGKILL');
}

async function runPg(args: string[]): Promise<void> {
  assert(pgCtl && pgData, 'PG_CTL and PGDATA are required for PostgreSQL restart smoke');
  const startOptions =
    args[0] === 'start'
      ? [
          '-l',
          join(dirname(pgData), 'postgres.log'),
          '-o',
          `-p ${new URL(databaseUrl!).port || '5432'} -h 127.0.0.1 -k ${dirname(pgData)}`,
        ]
      : [];
  await execFileAsync(pgCtl, ['-D', pgData, ...startOptions, ...args], {
    cwd: root,
    env: process.env,
    timeout: 60_000,
  });
}

function objectBody(body: unknown): Record<string, unknown> {
  assert(body && typeof body === 'object' && !Array.isArray(body), 'expected JSON object body');
  return body as Record<string, unknown>;
}

function accessToken(body: unknown): string {
  const value = objectBody(body)['accessToken'];
  assert(typeof value === 'string' && value, 'login did not return an access token');
  return value;
}

function idFromBody(body: unknown, key: string): string {
  const value = objectBody(body)[key];
  assert(typeof value === 'string' && value, `response did not return ${key}`);
  return value;
}

function userIdFromBootstrap(body: unknown): string {
  const user = objectBody(body)['user'];
  return idFromBody(user, 'id');
}

function mutationHeaders(token: string, clientId: string, mutationId: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': mutationId,
    'X-Client-Id': clientId,
  };
}

function cookieFromLogin(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookie = headers.getSetCookie?.()[0] ?? headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';', 1)[0] ?? '';
  assert(cookie.startsWith('devtodo_refresh='), 'login did not return the refresh cookie');
  return cookie;
}

async function waitForWebSocketReady(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
      once: true,
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket ready timed out')), 5_000);
    socket.addEventListener('message', (event) => {
      try {
        const message = objectBody(JSON.parse(String(event.data)));
        if (message['type'] !== 'ready') return;
        assert(message['protocolVersion'] === 2, 'WebSocket negotiated the wrong protocol');
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket closed before ready'));
    });
  });
  socket.send(JSON.stringify({ type: 'auth', accessToken: token }));
  await ready;
  return socket;
}

async function waitForSyncRequired(socket: WebSocket, timeoutMs = 5_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('sync.required notification timed out')),
      timeoutMs,
    );
    const onMessage = (event: MessageEvent) => {
      try {
        const message = objectBody(JSON.parse(String(event.data)));
        if (message['type'] !== 'sync.required') return;
        const cursor = message['cursor'];
        assert(typeof cursor === 'string', 'sync.required cursor was not a string');
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve(cursor);
      } catch (error) {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        reject(error);
      }
    };
    socket.addEventListener('message', onMessage);
  });
}

async function cleanupOwner(pool: Pool, ownerId: string): Promise<void> {
  await pool.query('DELETE FROM users WHERE id = $1', [ownerId]);
}

async function main(): Promise<void> {
  if (!databaseUrl) {
    console.log('NOT RUN: DATABASE_URL is required for real PostgreSQL runtime smoke.');
    process.exitCode = 2;
    return;
  }
  if (!pgCtl || !pgData) {
    console.log('NOT RUN: PG_CTL and PGDATA are required for database restart smoke.');
    process.exitCode = 2;
    return;
  }
  await access(apiEntry);

  const pool = createPool(databaseUrl);
  pool.on('error', (error: Error) => {
    console.warn(`runtime smoke pool error: ${error.message}`);
  });
  const existing = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  assert(existing.rows[0]?.count === '0', 'runtime smoke requires an isolated empty database');

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime = {
    bootstrapToken: `runtime-bootstrap-${randomUUID()}-long-enough-token`,
    accessTokenSecret: `runtime-access-${randomUUID()}-long-enough-secret`,
    refreshTokenPepper: `runtime-refresh-${randomUUID()}-long-enough-pepper`,
  };
  let api: ApiProcess | undefined;
  let ownerId: string | undefined;
  let databaseStopped = false;
  let socket: WebSocket | undefined;
  try {
    api = startApi(port, runtime);
    await waitForStatus(baseUrl, '/health/live', 200, api);
    await waitForStatus(baseUrl, '/health/ready', 200, api);

    const version = await requestJson(baseUrl, '/version');
    const versionBody = objectBody(version.body);
    assert(version.response.status === 200, `version returned ${version.response.status}`);
    assert(versionBody['syncProtocolVersion'] === 2, 'API runtime did not advertise v2');

    const username = `runtime-${process.pid}-${Date.now()}`;
    const password = 'runtime-password-change-me';
    const bootstrap = await requestJson(baseUrl, '/api/v1/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: runtime.bootstrapToken, username, password }),
    });
    assert(bootstrap.response.status === 201, `bootstrap returned ${bootstrap.response.status}`);
    ownerId = userIdFromBootstrap(bootstrap.body);

    const login = await requestJson(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, platform: 'web' }),
    });
    assert(login.response.status === 200, `login returned ${login.response.status}`);
    const refreshCookie = cookieFromLogin(login.response);
    const refresh = await requestJson(baseUrl, '/api/v1/auth/refresh', {
      method: 'POST',
      headers: { Cookie: refreshCookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert(refresh.response.status === 200, `refresh returned ${refresh.response.status}`);
    const refreshedToken = accessToken(refresh.body);
    const me = await requestJson(baseUrl, '/api/v1/me', {
      headers: { Authorization: `Bearer ${refreshedToken}` },
    });
    assert(me.response.status === 200, `/me returned ${me.response.status}`);

    const clientId = randomUUID();
    const snapshotBefore = await requestJson(baseUrl, '/api/v2/sync/snapshot', {
      headers: { Authorization: `Bearer ${refreshedToken}` },
    });
    assert(snapshotBefore.response.status === 200, 'initial v2 snapshot failed');
    const initialCursor = idFromBody(snapshotBefore.body, 'cursor');
    assert(/^\d+$/.test(initialCursor), 'initial v2 cursor was invalid');

    socket = await waitForWebSocketReady(`ws://127.0.0.1:${port}/api/v2/ws`, refreshedToken);
    const folderId = randomUUID();
    const folderMutationId = randomUUID();
    const folderResponse = await requestJson(baseUrl, '/api/v2/folders', {
      method: 'POST',
      headers: mutationHeaders(refreshedToken, clientId, folderMutationId),
      body: JSON.stringify({ id: folderId, title: 'runtime folder' }),
    });
    assert(
      folderResponse.response.status === 201,
      `folder create returned ${folderResponse.response.status}`,
    );
    assert(idFromBody(folderResponse.body, 'id') === folderId, 'folder id did not round-trip');
    const folderNotification = await waitForSyncRequired(socket);
    assert(/^\d+$/.test(folderNotification), 'folder notification cursor was invalid');

    const taskId = randomUUID();
    const taskMutationId = randomUUID();
    const taskRequest = {
      method: 'POST',
      headers: mutationHeaders(refreshedToken, clientId, taskMutationId),
      body: JSON.stringify({ id: taskId, parentFolderId: folderId, title: 'runtime task' }),
    } satisfies RequestInit;
    const taskResponse = await requestJson(baseUrl, '/api/v2/tasks', taskRequest);
    assert(
      taskResponse.response.status === 201,
      `task create returned ${taskResponse.response.status}`,
    );
    await waitForSyncRequired(socket);
    const replay = await requestJson(baseUrl, '/api/v2/tasks', taskRequest);
    assert(replay.response.status === 201, `idempotent replay returned ${replay.response.status}`);
    const afterWrites = await requestJson(baseUrl, '/api/v2/sync/status', {
      headers: { Authorization: `Bearer ${refreshedToken}` },
    });
    const cursorAfterWrites = idFromBody(afterWrites.body, 'cursor');
    assert(cursorAfterWrites !== initialCursor, 'v2 writes did not advance the DB cursor');
    const firstPull = await requestJson(
      baseUrl,
      `/api/v2/sync/pull?cursor=${initialCursor}&limit=500`,
      { headers: { Authorization: `Bearer ${refreshedToken}` } },
    );
    const firstChanges = objectBody(firstPull.body)['changes'];
    assert(Array.isArray(firstChanges), 'v2 pull changes were not an array');
    assert(
      firstChanges.filter((change: unknown) => objectBody(change)['entityId'] === taskId).length ===
        1,
      'idempotent task replay produced duplicate change rows',
    );

    await stopApi(api);
    api = startApi(port, runtime);
    await waitForStatus(baseUrl, '/health/live', 200, api);
    await waitForStatus(baseUrl, '/health/ready', 200, api);
    const afterApiRestart = await requestJson(baseUrl, '/api/v2/sync/snapshot', {
      headers: { Authorization: `Bearer ${refreshedToken}` },
    });
    const restartedFolders = objectBody(afterApiRestart.body)['folders'];
    const restartedTasks = objectBody(afterApiRestart.body)['tasks'];
    assert(
      Array.isArray(restartedFolders) &&
        restartedFolders.some((item) => objectBody(item)['id'] === folderId),
      'folder did not survive API restart',
    );
    assert(
      Array.isArray(restartedTasks) &&
        restartedTasks.filter((item) => objectBody(item)['id'] === taskId).length === 1,
      'task did not survive API restart or idempotent replay',
    );

    const folderAfterRestartId = randomUUID();
    const afterRestartWrite = await requestJson(baseUrl, '/api/v2/folders', {
      method: 'POST',
      headers: mutationHeaders(refreshedToken, clientId, randomUUID()),
      body: JSON.stringify({ id: folderAfterRestartId, title: 'after API restart' }),
    });
    assert(afterRestartWrite.response.status === 201, 'write after API restart failed');
    const afterRestartPull = await requestJson(
      baseUrl,
      `/api/v2/sync/pull?cursor=${cursorAfterWrites}&limit=500`,
      { headers: { Authorization: `Bearer ${refreshedToken}` } },
    );
    const afterRestartChanges = objectBody(afterRestartPull.body)['changes'];
    assert(
      Array.isArray(afterRestartChanges) &&
        afterRestartChanges.some(
          (change) => objectBody(change)['entityId'] === folderAfterRestartId,
        ),
      'old cursor did not read a change created after API restart',
    );

    await runPg(['stop', '-m', 'fast', '-w']);
    databaseStopped = true;
    const liveDuringDbStop = await requestJson(baseUrl, '/health/live');
    assert(
      liveDuringDbStop.response.status === 200,
      'live failed while only PostgreSQL was stopped',
    );
    await waitForStatus(baseUrl, '/health/ready', 503, api);
    const unavailable = await requestJson(
      baseUrl,
      '/api/v2/sync/status',
      { headers: { Authorization: `Bearer ${refreshedToken}` } },
      5_000,
    );
    assert(unavailable.response.status >= 500, `DB outage returned ${unavailable.response.status}`);

    await runPg(['start', '-w']);
    databaseStopped = false;
    await waitForStatus(baseUrl, '/health/ready', 200, api);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const folderAfterDbRestartId = randomUUID();
    const afterDbRestartWrite = await requestJson(baseUrl, '/api/v2/folders', {
      method: 'POST',
      headers: mutationHeaders(refreshedToken, clientId, randomUUID()),
      body: JSON.stringify({ id: folderAfterDbRestartId, title: 'after PostgreSQL restart' }),
    });
    assert(afterDbRestartWrite.response.status === 201, 'write after PostgreSQL restart failed');
    const afterDbRestartPull = await requestJson(
      baseUrl,
      `/api/v2/sync/pull?cursor=${cursorAfterWrites}&limit=500`,
      { headers: { Authorization: `Bearer ${refreshedToken}` } },
    );
    const afterDbRestartChanges = objectBody(afterDbRestartPull.body)['changes'];
    assert(
      Array.isArray(afterDbRestartChanges) &&
        afterDbRestartChanges.some(
          (change) => objectBody(change)['entityId'] === folderAfterDbRestartId,
        ),
      'cursor did not read a change after PostgreSQL restart',
    );

    console.log(
      `PASS: real PostgreSQL API runtime, cookie refresh, v2 WebSocket notification, idempotency, API restart cursor continuity, PostgreSQL restart recovery, and ready/live failure boundary; cursor ${cursorAfterWrites}`,
    );
  } catch (error) {
    console.error('FAIL: real PostgreSQL API runtime smoke failed.');
    console.error(error);
    if (api?.output) console.error(api.output);
    process.exitCode = 1;
  } finally {
    socket?.close();
    if (api) await stopApi(api);
    if (databaseStopped) {
      try {
        await runPg(['start', '-w']);
      } catch (error) {
        console.error(`FAIL: PostgreSQL recovery failed: ${String(error)}`);
        process.exitCode = 1;
      }
    }
    if (ownerId) {
      try {
        await cleanupOwner(pool, ownerId);
      } catch (error) {
        console.error(`FAIL: runtime fixture cleanup failed: ${String(error)}`);
        process.exitCode = 1;
      }
    }
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('FAIL: real PostgreSQL API runtime smoke crashed.');
  console.error(error);
  process.exitCode = 1;
});
