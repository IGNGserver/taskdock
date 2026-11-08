import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const composeFile = join(root, 'compose.dev.yaml');
const project = `devtodo-smoke-${process.pid}`;
const restoreContainer = `${project}-restore`;
const restoreVolume = `${project}-restore-data`;
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

function docker(args: string[], options: { capture?: boolean } = {}): Buffer | void {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: options.capture ? 'buffer' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: 120_000,
  }) as Buffer | void;
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
    compose(['up', '--detach', 'postgres', 'migrate', 'app', 'gateway']);
    await waitForHealth('/health/live');
    await waitForHealth('/health/ready');

    backupDir = await mkdtemp(join(tmpdir(), 'devtodo-compose-smoke-'));
    execFileSync(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--insecure',
        '--retry',
        '60',
        '--retry-all-errors',
        '--retry-connrefused',
        '--retry-delay',
        '1',
        '--retry-max-time',
        '90',
        '--resolve',
        'localhost:18443:127.0.0.1',
        'https://localhost:18443/health/ready',
      ],
      { cwd: root, stdio: 'ignore', timeout: 120_000 },
    );
    const certificate = compose(
      ['exec', '--no-TTY', 'gateway', 'cat', '/data/caddy/pki/authorities/local/root.crt'],
      { capture: true },
    ) as Buffer;
    const certificatePath = join(backupDir, 'caddy-root.crt');
    await writeFile(certificatePath, certificate, { mode: 0o600 });
    const tlsHeaders = execFileSync(
      'curl',
      [
        '--fail-with-body',
        '--silent',
        '--show-error',
        '--cacert',
        certificatePath,
        '--retry',
        '10',
        '--retry-all-errors',
        '--retry-delay',
        '1',
        '--resolve',
        'localhost:18443:127.0.0.1',
        '--head',
        'https://localhost:18443/health/ready',
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    assert(
      /strict-transport-security:\s*max-age=31536000/i.test(tlsHeaders),
      'trusted TLS gateway did not emit HSTS',
    );

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
    const folderId = randomUUID();
    const taskId = randomUUID();
    const clientId = randomUUID();
    const folderResponse = curl('/api/v2/folders', {
      method: 'POST',
      token: login.accessToken,
      mutationId: randomUUID(),
      clientId,
      body: { id: folderId, title: 'Compose smoke' },
    });
    assert(
      JSON.parse(folderResponse).title === 'Compose smoke',
      'PostgreSQL v2 folder write failed',
    );
    const taskResponse = curl('/api/v2/tasks', {
      method: 'POST',
      token: login.accessToken,
      mutationId: randomUUID(),
      clientId,
      body: { id: taskId, parentFolderId: folderId, title: 'Compose task' },
    });
    assert(JSON.parse(taskResponse).task?.id === taskId, 'PostgreSQL v2 task write failed');
    const v2Status = JSON.parse(curl('/api/v2/sync/status', { token: login.accessToken })) as {
      protocolVersion?: unknown;
      cursor?: unknown;
    };
    assert(
      v2Status.protocolVersion === 2 && typeof v2Status.cursor === 'string',
      'v2 status failed',
    );

    compose(['restart', 'app']);
    await waitForHealth('/health/live');
    await waitForHealth('/health/ready');
    const afterAppRestart = JSON.parse(
      curl('/api/v2/sync/snapshot', { token: login.accessToken }),
    ) as {
      folders?: Array<{ id?: string }>;
      tasks?: Array<{ id?: string }>;
      cursor?: string;
    };
    assert(
      afterAppRestart.folders?.some((folder) => folder.id === folderId),
      'v2 folder did not survive app restart',
    );
    assert(
      afterAppRestart.tasks?.some((task) => task.id === taskId),
      'v2 task did not survive app restart',
    );

    compose(['restart', 'postgres']);
    await waitForHealth('/health/ready');
    const afterPostgresRestart = JSON.parse(
      curl('/api/v2/sync/snapshot', { token: login.accessToken }),
    ) as {
      folders?: Array<{ id?: string }>;
      tasks?: Array<{ id?: string }>;
    };
    assert(
      afterPostgresRestart.folders?.some((folder) => folder.id === folderId),
      'v2 folder did not survive PostgreSQL restart',
    );
    assert(
      afterPostgresRestart.tasks?.some((task) => task.id === taskId),
      'v2 task did not survive PostgreSQL restart',
    );

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

    docker([
      'run',
      '--detach',
      '--name',
      restoreContainer,
      '--network',
      'none',
      '--env',
      'POSTGRES_DB=devtodo',
      '--env',
      'POSTGRES_USER=devtodo',
      '--env',
      'POSTGRES_PASSWORD=devtodo-restore-smoke-only',
      '--volume',
      `${restoreVolume}:/var/lib/postgresql`,
      '--volume',
      `${backupDir}:/backup:ro`,
      'postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2',
    ]);
    let restored = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (
        spawnSync(
          'docker',
          ['exec', restoreContainer, 'pg_isready', '-U', 'devtodo', '-d', 'devtodo'],
          { stdio: 'ignore', timeout: 5_000 },
        ).status === 0
      ) {
        restored = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert(restored, 'fresh-volume PostgreSQL restore instance did not become ready');
    docker([
      'exec',
      restoreContainer,
      'pg_restore',
      '--no-owner',
      '--no-acl',
      '-U',
      'devtodo',
      '--dbname=devtodo',
      '/backup/devtodo-smoke.dump',
    ]);
    const restoredContent = docker(
      [
        'exec',
        restoreContainer,
        'psql',
        '-U',
        'devtodo',
        '-d',
        'devtodo',
        '-t',
        '-A',
        '-c',
        `SELECT (SELECT count(*) FROM folders WHERE id='${folderId}' AND title='Compose smoke') + (SELECT count(*) FROM tasks WHERE id='${taskId}' AND title='Compose task')`,
      ],
      { capture: true },
    ) as Buffer;
    assert(
      restoredContent.toString('utf8').trim() === '2',
      'fresh-volume restore did not preserve exact folder/task content',
    );
    docker(['rm', '--force', '--volumes', restoreContainer]);
    docker(['volume', 'rm', restoreVolume]);
    console.log(
      'PASS: Compose build, trusted TLS/HSTS, migration, health, bootstrap, PostgreSQL writes, app/DB restart, and fresh-volume content restore.',
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
    spawnSync('docker', ['rm', '--force', '--volumes', restoreContainer], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', restoreVolume], { stdio: 'ignore' });
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
