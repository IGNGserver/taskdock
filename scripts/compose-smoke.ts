import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const composeFile = join(root, 'compose.dev.yaml');
const project = `devtodo-smoke-${process.pid}`;
const baseUrl = 'http://127.0.0.1:3000';
const bootstrapToken = 'dev-only-bootstrap-token-change-before-use';
const password = 'compose-smoke-password-change-me';

function compose(
  args: string[],
  options: { input?: Buffer; capture?: boolean } = {},
): Buffer | void {
  const capture = options.capture === true;
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      cwd: root,
      input: options.input,
      encoding: capture ? 'buffer' : undefined,
      stdio: capture
        ? ['ignore', 'pipe', 'inherit']
        : options.input
          ? ['pipe', 'inherit', 'inherit']
          : 'inherit',
      timeout: 10 * 60_000,
    },
  ) as Buffer | void;
}

function curl(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    mutationId?: string;
    clientId?: string;
  } = {},
): string {
  const args = ['--fail-with-body', '--silent', '--show-error', '--retry', '2'];
  if (options.method) args.push('--request', options.method);
  if (options.token) args.push('--header', `Authorization: Bearer ${options.token}`);
  if (options.mutationId) args.push('--header', `Idempotency-Key: ${options.mutationId}`);
  if (options.clientId) args.push('--header', `X-Client-Id: ${options.clientId}`);
  if (options.body !== undefined) {
    args.push(
      '--header',
      'Content-Type: application/json',
      '--data-raw',
      JSON.stringify(options.body),
    );
  }
  args.push(`${baseUrl}${path}`);
  return execFileSync('curl', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForHealth(path: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('curl', ['--fail', '--silent', `${baseUrl}${path}`], {
      cwd: root,
      stdio: 'ignore',
      timeout: 5_000,
    });
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`health check timed out: ${path}`);
}

async function main(): Promise<void> {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    execFileSync('curl', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log(
      'NOT RUN: Docker, Docker Compose, or curl is unavailable; Compose smoke was not executed.',
    );
    process.exitCode = 2;
    return;
  }

  let backupDir: string | undefined;
  try {
    compose(['build']);
    compose(['up', '--detach', 'postgres', 'migrate', 'app']);
    await waitForHealth('/health/live');
    await waitForHealth('/health/ready');

    const before = JSON.parse(curl('/api/v1/bootstrap/status')) as { initialized?: unknown };
    assert(before.initialized === false, 'fresh Compose volume was already initialized');
    const bootstrap = curl('/api/v1/bootstrap', {
      method: 'POST',
      body: { token: bootstrapToken, username: 'compose-owner', password },
    });
    assert(JSON.parse(bootstrap).user?.username === 'compose-owner', 'bootstrap failed');
    const login = JSON.parse(
      curl('/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'compose-owner', password },
      }),
    ) as { accessToken?: unknown };
    assert(typeof login.accessToken === 'string', 'login failed after bootstrap');
    const projectResponse = curl('/api/v1/projects', {
      method: 'POST',
      token: login.accessToken,
      mutationId: randomUUID(),
      clientId: randomUUID(),
      body: { name: 'Compose smoke', taskPrefix: `SM${process.pid % 10}` },
    });
    assert(JSON.parse(projectResponse).name === 'Compose smoke', 'PostgreSQL write failed');

    compose(['restart', 'app']);
    await waitForHealth('/health/live');
    await waitForHealth('/health/ready');
    const afterAppRestart = JSON.parse(curl('/api/v1/bootstrap/status')) as {
      initialized?: unknown;
    };
    assert(afterAppRestart.initialized === true, 'data did not survive app restart');

    compose(['restart', 'postgres']);
    await waitForHealth('/health/ready');
    const afterPostgresRestart = JSON.parse(curl('/api/v1/bootstrap/status')) as {
      initialized?: unknown;
    };
    assert(afterPostgresRestart.initialized === true, 'data did not survive PostgreSQL restart');

    backupDir = await mkdtemp(join(tmpdir(), 'devtodo-compose-smoke-'));
    const backup = compose(
      [
        'exec',
        '--no-TTY',
        'postgres',
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '-U',
        'devtodo',
        '-d',
        'devtodo',
      ],
      { capture: true },
    ) as Buffer;
    assert(backup.length > 0, 'pg_dump returned an empty backup');
    const backupPath = join(backupDir, 'devtodo-smoke.dump');
    await writeFile(backupPath, backup, { mode: 0o600 });
    console.log(`BACKUP: ${backupPath} ${createHash('sha256').update(backup).digest('hex')}`);

    compose(
      [
        'exec',
        '--no-TTY',
        'postgres',
        'pg_restore',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--dbname=devtodo',
      ],
      { input: backup },
    );
    await waitForHealth('/health/ready');
    const afterRestore = JSON.parse(curl('/api/v1/bootstrap/status')) as { initialized?: unknown };
    assert(afterRestore.initialized === true, 'backup restore lost the owner');
    console.log(
      'PASS: Compose build, migration, health, bootstrap, PostgreSQL writes, app/DB restart, and backup restore.',
    );
  } catch (error) {
    console.error('FAIL: Compose smoke failed.');
    console.error(error);
    try {
      compose(['ps']);
      compose(['logs', '--no-color', 'app']);
      compose(['logs', '--no-color', 'postgres']);
    } catch (diagnosticError) {
      console.error('Compose failure diagnostics were unavailable.');
      console.error(diagnosticError);
    }
    process.exitCode = 1;
  } finally {
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
    spawnSync(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        composeFile,
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      { cwd: root, stdio: 'inherit', timeout: 120_000 },
    );
  }
}

void main().catch((error: unknown) => {
  console.error('FAIL: Compose smoke crashed.');
  console.error(error);
  process.exitCode = 1;
});
