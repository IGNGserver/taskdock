import { spawn, type ChildProcess } from 'node:child_process';
import { createPool, runMigrations, type Pool } from '../packages/database/src/index.js';

const children: ChildProcess[] = [];
let e2ePool: Pool | undefined;
let shutdownPromise: Promise<void> | undefined;
const e2eUsername = process.env['E2E_USERNAME'] ?? 'e2e-real-owner';

function start(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(child);
  return child;
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* The child process may still be compiling or binding its port. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`real E2E server did not become ready: ${url}`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function cleanupFixture(): Promise<void> {
  if (!e2ePool) return;
  try {
    // E2E_DATABASE_URL is a disposable test fixture. Remove the fixed test
    // account so a release gate can be rerun against the same database and
    // so later database checks never inherit browser-test state.
    await e2ePool.query('DELETE FROM users WHERE username = $1', [e2eUsername]);
  } finally {
    await e2ePool.end();
    e2ePool = undefined;
  }
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    // Playwright may terminate this web-server process shortly after sending
    // SIGTERM. Remove the disposable Owner before waiting for child processes;
    // otherwise a slow API/Vite shutdown can prevent fixture cleanup from
    // running before the runner escalates to SIGKILL.
    await cleanupFixture();
    for (const child of children) child.kill('SIGTERM');
    await Promise.race([
      Promise.all(children.map(waitForExit)),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  })();
  return shutdownPromise;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['E2E_DATABASE_URL'];
  const bootstrapToken =
    process.env['E2E_BOOTSTRAP_TOKEN'] ?? 'devtodo-local-bootstrap-token-change-me-now';
  if (databaseUrl) {
    e2ePool = createPool(databaseUrl);
    await runMigrations(e2ePool);
  }

  const apiEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    APP_PORT: '3000',
    APP_ORIGIN: 'http://127.0.0.1:4173',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
    DEV_MEMORY_STORE: databaseUrl ? 'false' : 'true',
    BOOTSTRAP_TOKEN: bootstrapToken,
    ACCESS_TOKEN_SECRET:
      process.env['E2E_ACCESS_TOKEN_SECRET'] ?? 'devtodo-e2e-access-secret-change-me-now',
    REFRESH_TOKEN_PEPPER:
      process.env['E2E_REFRESH_TOKEN_PEPPER'] ?? 'devtodo-e2e-refresh-pepper-change-me-now',
    LOG_LEVEL: 'warn',
  };
  if (databaseUrl) apiEnv.DATABASE_URL = databaseUrl;

  start('node', ['apps/api/dist/main.js'], {
    ...apiEnv,
  });
  await waitFor('http://127.0.0.1:3000/health/live');
  start('pnpm', ['--filter', '@devtodo/web', 'dev', '--host', '127.0.0.1', '--port', '4173'], {});
  await waitFor('http://127.0.0.1:4173');

  const stopChildren = (): void => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`E2E fixture shutdown failed: ${String(error)}`);
        process.exit(1);
      });
  };
  process.once('SIGINT', stopChildren);
  process.once('SIGTERM', stopChildren);
  try {
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (children.some((child) => child.exitCode !== null)) {
          clearInterval(interval);
          resolve();
        }
      }, 250);
    });
  } finally {
    await shutdown();
  }
}

void main().catch(async (error: unknown) => {
  console.error(error);
  try {
    await shutdown();
  } catch (cleanupError) {
    console.error(`E2E fixture shutdown failed: ${String(cleanupError)}`);
  }
  process.exitCode = 1;
});
