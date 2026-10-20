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
        const result = JSON.parse(line) as {
          worker?: unknown;
          references?: unknown;
        };
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
      "INSERT INTO user_settings (owner_id, timezone, week_starts_on, default_capture_target, version, created_at, updated_at) VALUES ($1, 'Asia/Shanghai', 1, 'ROOT', 1, $2, $2)",
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
    const projectTasks = await primary.listTasks(owner.id, {
      projectId: project.id,
    });
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

    // Verify v2 PostgresTreeStore invariants: transaction lock, delete preview, cascade deletion
    const { PostgresTreeStore } = await import('../apps/api/src/postgres-tree-store.js');
    const v2Store = new PostgresTreeStore(restartStore);
    const v2FolderId = uuidv7();
    const v2TaskId = uuidv7();
    const v2CursorBefore = (await restartStore.syncStatusV2(owner.id)).cursor;

    await v2Store.applyMutationIdempotent(owner.id, clientId, {
      mutationId: uuidv7(),
      command: 'folder.create',
      entityId: v2FolderId,
      baseVersion: null,
      occurredAt: new Date().toISOString(),
      payload: { title: 'v2 集成目录', parentFolderId: null },
    });
    await v2Store.applyMutationIdempotent(owner.id, clientId, {
      mutationId: uuidv7(),
      command: 'task.create',
      entityId: v2TaskId,
      baseVersion: null,
      occurredAt: new Date().toISOString(),
      payload: { title: 'v2 集成任务', parentFolderId: v2FolderId },
    });

    const v2CursorAfterWrite = (await restartStore.syncStatusV2(owner.id)).cursor;
    assert(
      v2CursorAfterWrite !== v2CursorBefore,
      'v2 mutation did not advance the database cursor',
    );
    const reloadedV2Store = new PostgresTreeStore(restartStore);
    const reloadedSnapshot = await reloadedV2Store.snapshot(owner.id);
    const { BootstrapSnapshots } = await import('../apps/api/src/sync-bootstrap.js');
    const bootstrap = new BootstrapSnapshots(reloadedV2Store);
    const firstPreview = await bootstrap.preview(owner.id, '2026-09-04', null);
    assert(
      reloadedSnapshot.timePoints.some(
        (point) => point.id === today.id && point.localDate === '2026-09-04',
      ),
      'SQL DATE shifted under the API host timezone in full snapshot',
    );
    assert(
      firstPreview.changes.some(
        (change) =>
          change.entityId === today.id &&
          (change.snapshot as { localDate?: string }).localDate === '2026-09-04',
      ),
      'SQL DATE shifted under the API host timezone in preview',
    );
    assert(firstPreview.complete === false, 'preview must never advance the global cursor');
    assert(
      firstPreview.coverage.limit === 100 && /^\d+$/.test(firstPreview.cursor),
      'preview coverage missing',
    );
    assert(
      !firstPreview.changes.some((change) => change.entityType === 'note'),
      'preview loaded large notes',
    );
    const directDetail = await bootstrap.detail(owner.id, v2TaskId);
    const { DirectoryReads } = await import('../apps/api/src/directory-reads.js');
    const directoryStore = new PostgresTreeStore(restartStore);
    directoryStore.prepare = async () => {
      throw new Error('directory read loaded the full owner projection');
    };
    const directories = new DirectoryReads(directoryStore);
    const sqlChildren = await directories.children(owner.id, v2FolderId, 1);
    assert(
      isDeepStrictEqual(
        (await directories.task(owner.id, v2TaskId)).task,
        reloadedV2Store.getTask(owner.id, v2TaskId),
      ),
      'SQL summary does not match the task DTO',
    );
    assert(
      sqlChildren.items.length === 1 &&
        sqlChildren.items[0]?.kind === 'TASK' &&
        sqlChildren.items[0].task.id === v2TaskId,
      'direct directory lost its task',
    );
    assert(
      isDeepStrictEqual(sqlChildren.items, reloadedV2Store.listTreeChildren(owner.id, v2FolderId)),
      'direct SQL DTO does not match the domain projection',
    );
    const sqlRoot = await directories.children(owner.id, null);
    const domainRoot = reloadedV2Store.listTreeChildren(owner.id, null);
    assert(
      isDeepStrictEqual(sqlRoot.items, domainRoot),
      'SQL mixed directory ordering or aggregates differ from domain',
    );
    const walked = [];
    let directoryToken: string | undefined;
    do {
      const page = await directories.children(owner.id, null, 1, directoryToken);
      walked.push(...page.items);
      directoryToken = page.nextCursor ?? undefined;
    } while (directoryToken);
    assert(
      isDeepStrictEqual(walked, domainRoot),
      'SQL keyset pagination skipped or duplicated rows',
    );
    assert(
      (await directories.path(owner.id, v2FolderId)).at(-1)?.id === v2FolderId,
      'SQL breadcrumb missing',
    );
    assert(
      (await directories.folders(owner.id)).some((row) => row.id === v2FolderId),
      'SQL folder picker missing',
    );
    assert(
      directDetail.task.id === v2TaskId && directDetail.note.contentMarkdown === '',
      'direct task detail did not match the authoritative task',
    );
    assert(
      directDetail.folderPath.some((folder) => folder.id === v2FolderId),
      'direct task detail lost the readable folder path',
    );
    // Focused mobile edits must reuse domain validation without prepare/full-account reads.
    const focusedStore = new PostgresTreeStore(restartStore);
    focusedStore.prepare = async () => {
      throw new Error('focused mutation loaded the entire owner');
    };
    const focusedEdit = {
      mutationId: uuidv7(),
      command: 'task.update' as const,
      entityId: v2TaskId,
      baseVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: { title: 'focused update' },
    };
    const edited = await focusedStore.applyMutationIdempotent(owner.id, clientId, focusedEdit);
    assert((edited.result as { version: number }).version === 2, 'focused edit version incorrect');
    const replayed = await focusedStore.applyMutationIdempotent(owner.id, clientId, focusedEdit);
    assert(replayed.replayed, 'focused edit lost its idempotency receipt');
    await expectDomainError(
      () =>
        focusedStore.applyMutationIdempotent(owner.id, clientId, {
          ...focusedEdit,
          mutationId: uuidv7(),
        }),
      'VERSION_CONFLICT',
    );
    const noteEdit = {
      mutationId: uuidv7(),
      command: 'note.update' as const,
      entityId: v2TaskId,
      baseVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: { taskId: v2TaskId, contentMarkdown: 'focused note' },
    };
    const originalAppend = restartStore.appendV2Change;
    restartStore.appendV2Change = async () => {
      throw new Error('injected feed failure');
    };
    let rolledBack = false;
    try {
      await focusedStore.applyMutationIdempotent(owner.id, clientId, noteEdit);
    } catch {
      rolledBack = true;
    } finally {
      restartStore.appendV2Change = originalAppend;
    }
    assert(
      rolledBack && (await bootstrap.detail(owner.id, v2TaskId)).note.contentMarkdown === '',
      'focused edit escaped rollback',
    );
    await focusedStore.applyMutationIdempotent(owner.id, clientId, noteEdit);
    assert(
      (await bootstrap.detail(owner.id, v2TaskId)).note.contentMarkdown === 'focused note',
      'focused retry lost the edit',
    );
    const manifest = await bootstrap.create(owner.id, '2026-09-04');
    const bootstrapPeer = new PostgresStore(createPool(databaseUrl));
    stores.push(bootstrapPeer);
    await bootstrapPeer.init();
    const peerBootstrap = new BootstrapSnapshots(new PostgresTreeStore(bootstrapPeer));
    const peerManifest = await peerBootstrap.create(owner.id, '2026-09-04');
    assert(
      peerManifest.snapshotId === manifest.snapshotId,
      'unchanged snapshot was rebuilt on another instance',
    );
    const pageOnPeer = await peerBootstrap.page(owner.id, manifest.snapshotId, 0);
    const allPageChanges = [...pageOnPeer.changes];
    for (let page = 1; page < manifest.pageCount; page++)
      allPageChanges.push(
        ...(await peerBootstrap.page(owner.id, manifest.snapshotId, page)).changes,
      );
    assert(
      allPageChanges.some(
        (change) =>
          change.entityId === today.id &&
          (change.snapshot as { localDate?: string }).localDate === '2026-09-04',
      ),
      'SQL DATE shifted under the API host timezone in progressive snapshot',
    );
    assert(pageOnPeer.cursor === manifest.cursor, 'bootstrap cursor changed across API instances');
    assert(
      JSON.stringify(await bootstrap.page(owner.id, manifest.snapshotId, 0)) ===
        JSON.stringify(pageOnPeer),
      'bootstrap page replay is not immutable across instances',
    );
    await expectDomainError(
      () => peerBootstrap.page(ownerB, manifest.snapshotId, 0),
      'SYNC_CURSOR_EXPIRED',
    );
    await cleanupPool.query(
      "UPDATE sync_bootstrap_snapshots SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [manifest.snapshotId],
    );
    await expectDomainError(
      () => bootstrap.page(owner.id, manifest.snapshotId, 0),
      'SYNC_CURSOR_EXPIRED',
    );
    await bootstrap.cleanup();
    const expired = await cleanupPool.query(
      'SELECT 1 FROM sync_bootstrap_snapshots WHERE id = $1',
      [manifest.snapshotId],
    );
    assert(expired.rowCount === 0, 'bounded background cleanup retained expired snapshot');
    assert(
      reloadedSnapshot.folders.some((folder) => folder.id === v2FolderId),
      'v2 folder did not survive a PostgresTreeStore restart',
    );
    assert(
      reloadedSnapshot.tasks.some((task) => task.id === v2TaskId),
      'v2 task did not survive a PostgresTreeStore restart',
    );
    const reloadedPull = await reloadedV2Store.pull(owner.id, v2CursorBefore, 500);
    assert(
      reloadedPull.changes.some((change) => change.entityId === v2TaskId),
      'v2 pull did not read durable changes after a PostgresTreeStore restart',
    );

    // Section 7.2 invariant: a newly created root Task must not be sorted above
    // an existing sibling root Folder in the same status group.
    const rootSiblingTaskId = uuidv7();
    await v2Store.applyMutationIdempotent(owner.id, clientId, {
      mutationId: uuidv7(),
      command: 'task.create',
      entityId: rootSiblingTaskId,
      baseVersion: null,
      occurredAt: new Date().toISOString(),
      payload: { title: 'v2 根级任务', parentFolderId: null },
    });
    const rootChildren = v2Store.listTreeChildren(owner.id, null);
    const rootFolderIndex = rootChildren.findIndex(
      (item) => item.kind === 'FOLDER' && item.folder.id === v2FolderId,
    );
    const rootTaskIndex = rootChildren.findIndex(
      (item) => item.kind === 'TASK' && item.task.id === rootSiblingTaskId,
    );
    assert(rootFolderIndex >= 0, 'v2 root folder missing from the level listing');
    assert(rootTaskIndex >= 0, 'v2 root task missing from the level listing');
    const siblingStatus = (item: (typeof rootChildren)[number]) =>
      item.kind === 'FOLDER' ? item.aggregate.status : item.task.status;
    assert(
      siblingStatus(rootChildren[rootFolderIndex]!) === siblingStatus(rootChildren[rootTaskIndex]!),
      'root folder and root task unexpectedly differ in status',
    );
    assert(
      rootFolderIndex < rootTaskIndex,
      'default ordering placed a same-status Task above its sibling Folder',
    );

    const preview = v2Store.previewDelete(owner.id, v2FolderId);
    assert(preview.folderCount === 1, 'delete preview folder count mismatch');
    assert(preview.taskCount === 1, 'delete preview task count mismatch');

    const deleteOutcome = await v2Store.applyMutationIdempotent(owner.id, clientId, {
      mutationId: uuidv7(),
      command: 'folder.deleteTree',
      entityId: v2FolderId,
      baseVersion: null,
      occurredAt: new Date().toISOString(),
      payload: { confirmationToken: preview.confirmationToken },
    });
    const deleted = deleteOutcome.result as {
      folderCount?: number;
      taskCount?: number;
    };
    assert(deleted.folderCount === 1, 'delete outcome folder count mismatch');
    assert(deleted.taskCount === 1, 'delete outcome task count mismatch');
    const afterDeleteSnapshot = await reloadedV2Store.snapshot(owner.id);
    assert(
      !afterDeleteSnapshot.folders.some((folder) => folder.id === v2FolderId),
      'v2 delete was not persisted for a reloaded store',
    );

    console.log(
      `PASS: PostgreSQL migration, row-level transaction, owner isolation, two-process concurrency, idempotency, rollback, restart, multi-placement invariants, and PostgresTreeStore v2 delete preview/tree deletion; cursor ${afterRestart.cursor}`,
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
import { isDeepStrictEqual } from 'node:util';
