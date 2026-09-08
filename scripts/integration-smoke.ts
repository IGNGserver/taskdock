import { spawn } from 'node:child_process';
import { createPool, databaseReady, runMigrations } from '../packages/database/src/index.js';
import { PostgresStore } from '../apps/api/src/postgres-store.js';
import { uuidv7, type Mutation } from '../packages/contracts/src/index.js';
import { DomainError } from '../packages/domain/src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const root = process.cwd();
const workerCount = 20;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectDomainError(
  operation: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const actualCode =
      error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : undefined;
    assert(actualCode === code, `expected ${code}, got ${actualCode ?? String(error)}`);
    return;
  }
  throw new Error(`expected ${code}, but the operation succeeded`);
}

function runConcurrencyWorker(
  ownerId: string,
  projectId: string,
  label: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(executable, ['exec', 'tsx', 'scripts/pg-concurrency-worker.ts'], {
      cwd: root,
      env: {
        ...process.env,
        DEVTODO_OWNER_ID: ownerId,
        DEVTODO_PROJECT_ID: projectId,
        DEVTODO_WORKER_LABEL: label,
        DEVTODO_WORKER_COUNT: String(workerCount),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${label} concurrency worker timed out`));
    }, 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`${label} exited with code=${code} signal=${signal}\n${stderr}\n${stdout}`),
        );
        return;
      }
      try {
        const line = stdout
          .trim()
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean)
          .at(-1);
        assert(line, `${label} produced no result`);
        const result = JSON.parse(line) as { worker?: unknown; references?: unknown };
        assert(result.worker === label, `${label} returned an invalid worker label`);
        assert(Array.isArray(result.references), `${label} returned no reference list`);
        resolve(result.references.filter((value): value is string => typeof value === 'string'));
      } catch (error) {
        reject(new Error(`${label} returned invalid JSON: ${String(error)}\n${stdout}`));
      }
    });
  });
}

async function main(): Promise<void> {
  if (!databaseUrl) {
    console.log(
      'NOT RUN: DATABASE_URL is not configured; the integration smoke requires a real PostgreSQL server.',
    );
    process.exitCode = 2;
    return;
  }

  const cleanupPool = createPool(databaseUrl);
  const stores: PostgresStore[] = [];
  const closedStores = new Set<PostgresStore>();
  const closeStore = async (store: PostgresStore): Promise<void> => {
    if (closedStores.has(store)) return;
    closedStores.add(store);
    await store.close();
  };
  let ownerIds: string[] = [];
  try {
    await runMigrations(cleanupPool);
    await runMigrations(cleanupPool);
    assert(await databaseReady(cleanupPool), 'PostgreSQL schema is not ready after migrations');
    const existingOwners = await cleanupPool.query<{ id: string }>(
      'SELECT id FROM users WHERE disabled_at IS NULL LIMIT 1',
    );
    if (existingOwners.rowCount) {
      throw new Error(
        'integration smoke requires an isolated empty database; refusing to modify an existing Owner',
      );
    }

    const primary = new PostgresStore(createPool(databaseUrl), {
      clock: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    const peer = new PostgresStore(createPool(databaseUrl), {
      clock: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    stores.push(primary, peer);
    await primary.init();
    await peer.init();

    const owner = await primary.withMutation(() =>
      primary.createOwner(`integration-${process.pid}`, 'argon2id-test-hash'),
    );
    ownerIds = [owner.id];
    const project = await primary.withMutation(() =>
      primary.createProject(owner.id, 'DSH Desktop', 'DSH'),
    );
    const baseTask = await primary.withMutation(() =>
      primary.createTask(owner.id, {
        projectId: project.id,
        category: 'FEATURE',
        title: '修复移动端连接',
        priority: 'NONE',
      }),
    );
    const today = await primary.withMutation(() => primary.createDate(owner.id, '2026-09-04'));
    const tomorrow = await primary.withMutation(() => primary.createDate(owner.id, '2026-09-05'));
    const event = await primary.withMutation(() =>
      primary.createEvent(owner.id, 'Codex 额度重置后'),
    );
    await primary.withMutation(async () => {
      await primary.addPlacement(owner.id, baseTask.id, today.id);
      await primary.addPlacement(owner.id, baseTask.id, tomorrow.id);
      await primary.addPlacement(owner.id, baseTask.id, event.id);
      await primary.updateTask(owner.id, baseTask.id, { status: 'DONE' }, baseTask.version);
    });
    assert(
      (await primary.listTasks(owner.id, { timePointId: tomorrow.id }))[0]?.status === 'DONE',
      'task status did not propagate to every placement',
    );
    assert(
      (await primary.listPlacements(owner.id, event.id)).length === 1,
      'event placement did not persist',
    );

    const ownerB = uuidv7();
    ownerIds.push(ownerB);
    const ownerBNow = new Date().toISOString();
    await cleanupPool.query(
      'INSERT INTO users (id, username, password_hash, next_misc_task_number, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, $4)',
      [ownerB, `integration-b-${process.pid}`, 'not-used-in-integration', ownerBNow],
    );
    await cleanupPool.query(
      "INSERT INTO user_settings (owner_id, timezone, week_starts_on, default_capture_target, version, created_at, updated_at) VALUES ($1, 'Asia/Shanghai', 1, 'GLOBAL_MISC', 1, $2, $2)",
      [ownerB, ownerBNow],
    );
    const projectB = await peer.withMutation(() =>
      peer.createProject(ownerB, 'Other Owner', 'OTH'),
    );
    const taskB = await peer.withMutation(() =>
      peer.createTask(ownerB, {
        projectId: projectB.id,
        category: 'FEATURE',
        title: 'private task',
        priority: 'NONE',
      }),
    );
    await expectDomainError(() => primary.getProject(owner.id, projectB.id), 'ENTITY_NOT_FOUND');
    await expectDomainError(() => primary.getTask(owner.id, taskB.id), 'ENTITY_NOT_FOUND');
    assert(
      (await primary.listProjects(owner.id)).every((candidate) => candidate.id !== projectB.id),
      'cross-owner project leaked into list',
    );

    const rollbackTaskId = uuidv7();
    const cursorBeforeRollback = (await primary.syncStatus(owner.id)).cursor;
    await expectDomainError(
      () =>
        primary.withMutation(async () => {
          await primary.createTask(owner.id, {
            id: rollbackTaskId,
            projectId: project.id,
            category: 'FEATURE',
            title: 'must rollback',
            priority: 'NONE',
          });
          await primary.createTask(owner.id, {
            id: rollbackTaskId,
            projectId: project.id,
            category: 'FEATURE',
            title: 'duplicate in same transaction',
            priority: 'NONE',
          });
        }),
      'MUTATION_REJECTED',
    );
    await expectDomainError(() => primary.getTask(owner.id, rollbackTaskId), 'ENTITY_NOT_FOUND');
    assert(
      (await primary.syncStatus(owner.id)).cursor === cursorBeforeRollback,
      'failed transaction advanced the change cursor',
    );

    const failedReceiptId = uuidv7();
    const failedReceiptTaskId = uuidv7();
    await expectDomainError(
      () =>
        primary.withMutation(() =>
          primary.withIdempotency(
            owner.id,
            uuidv7(),
            failedReceiptId,
            { command: 'test.transaction-failure' },
            async () => {
              await primary.createTask(owner.id, {
                id: failedReceiptTaskId,
                projectId: project.id,
                category: 'FEATURE',
                title: 'receipt must rollback',
                priority: 'NONE',
              });
              throw new DomainError('MUTATION_REJECTED', 'injected transaction failure');
            },
          ),
        ),
      'MUTATION_REJECTED',
    );
    await expectDomainError(
      () => primary.getTask(owner.id, failedReceiptTaskId),
      'ENTITY_NOT_FOUND',
    );
    const failedReceipt = await cleanupPool.query(
      'SELECT 1 FROM client_mutations WHERE owner_id = $1 AND mutation_id = $2',
      [owner.id, failedReceiptId],
    );
    assert(failedReceipt.rowCount === 0, 'failed transaction left a mutation receipt');

    const mutationId = uuidv7();
    const clientId = uuidv7();
    const idempotentTaskId = uuidv7();
    const idempotentMutation: Mutation = {
      mutationId,
      command: 'task.create',
      entityId: idempotentTaskId,
      baseVersion: null,
      occurredAt: new Date('2026-09-04T10:00:00.000Z').toISOString(),
      payload: {
        projectId: project.id,
        category: 'FEATURE',
        title: '只创建一次',
        priority: 'NONE',
      },
    };
    const [firstIdempotent, secondIdempotent] = await Promise.all([
      primary.applyMutationIdempotent(owner.id, clientId, idempotentMutation),
      peer.applyMutationIdempotent(owner.id, clientId, idempotentMutation),
    ]);
    assert(
      new Set([firstIdempotent.replayed, secondIdempotent.replayed]).size === 2,
      'concurrent idempotent mutation did not produce exactly one replay',
    );
    const receiptCount = await cleanupPool.query(
      'SELECT COUNT(*)::int AS count FROM client_mutations WHERE owner_id = $1 AND client_id = $2 AND mutation_id = $3',
      [owner.id, clientId, mutationId],
    );
    assert(
      Number(receiptCount.rows[0]?.count) === 1,
      'idempotent mutation produced more than one receipt',
    );
    const changeCount = await cleanupPool.query(
      'SELECT COUNT(*)::int AS count FROM sync_changes WHERE owner_id = $1 AND entity_id = $2',
      [owner.id, idempotentTaskId],
    );
    assert(
      Number(changeCount.rows[0]?.count) === 1,
      'idempotent mutation produced more than one task change',
    );

    const [workerA, workerB] = await Promise.all([
      runConcurrencyWorker(owner.id, project.id, 'process-a'),
      runConcurrencyWorker(owner.id, project.id, 'process-b'),
    ]);
    const workerReferences = [...workerA, ...workerB];
    assert(
      workerReferences.length === workerCount * 2,
      'concurrency workers returned an incomplete result',
    );
    assert(
      new Set(workerReferences).size === workerReferences.length,
      'concurrent task allocation duplicated a reference ID',
    );
    assert(
      workerReferences.every((reference) => /^DSH-\d+$/.test(reference)),
      'concurrency worker returned an invalid reference ID',
    );
    const projectTasks = await primary.listTasks(owner.id, { projectId: project.id });
    assert(
      projectTasks.length === 1 + 1 + workerCount * 2,
      `unexpected project task count: ${projectTasks.length}`,
    );
    assert(
      new Set(projectTasks.map((task) => task.referenceId)).size === projectTasks.length,
      'project task references are not unique',
    );

    const cursorBeforeRestart = (await primary.syncStatus(owner.id)).cursor;
    await closeStore(peer);
    await closeStore(primary);
    const restartStore = new PostgresStore(createPool(databaseUrl), {
      clock: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    stores.push(restartStore);
    await restartStore.init();
    const afterRestart = await restartStore.syncStatus(owner.id);
    assert(
      afterRestart.cursor === cursorBeforeRestart,
      'restart changed the authoritative sync cursor',
    );
    assert(
      (await restartStore.getTask(owner.id, idempotentTaskId)).title === '只创建一次',
      'task did not survive restart',
    );
    const replayAfterRestart = await restartStore.applyMutationIdempotent(
      owner.id,
      clientId,
      idempotentMutation,
    );
    assert(replayAfterRestart.replayed, 'idempotent receipt did not survive restart');
    assert(
      (await restartStore.listPlacements(owner.id, event.id)).length === 1,
      'placement did not survive restart',
    );

    console.log(
      `PASS: PostgreSQL migration, row-level transaction, owner isolation, two-process concurrency, idempotency, rollback, restart, and multi-placement invariants; cursor ${afterRestart.cursor}`,
    );
  } finally {
    for (const store of stores) {
      try {
        await closeStore(store);
      } catch (error) {
        console.error(`cleanup store failed: ${String(error)}`);
        process.exitCode = 1;
      }
    }
    if (ownerIds.length) {
      try {
        await cleanupPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ownerIds]);
      } catch (error) {
        console.error(`cleanup fixture failed: ${String(error)}`);
        process.exitCode = 1;
      }
    }
    await cleanupPool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
