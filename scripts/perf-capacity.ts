import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { PostgresStore, type PostgresPage } from '../apps/api/src/postgres-store.js';
import { createPool, runMigrations, type Pool } from '../packages/database/src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const TASK_COUNT = 50_000;
const DATE_COUNT = 5_000;
const PLACEMENT_COUNT = 250_000;
const DATES_PER_TASK = 5;
const PAGE_SIZE = 100;

type Benchmark = {
  name: string;
  iterations: number;
  failures: number;
  failureRate: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

function idFor(runKey: string, kind: string, number: number | string): string {
  const hex = createHash('md5').update(`${runKey}:${kind}:${number}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Number(sorted[Math.max(0, index)]!.toFixed(2));
}

async function benchmark<T>(
  name: string,
  iterations: number,
  operation: (iteration: number) => Promise<T>,
): Promise<Benchmark> {
  const durations: number[] = [];
  let failures = 0;
  let lastFailure: unknown;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    try {
      await operation(iteration);
      durations.push(performance.now() - started);
    } catch (error) {
      failures += 1;
      lastFailure = error;
    }
  }
  if (lastFailure) console.error(`FAILURE SAMPLE [${name}]: ${String(lastFailure)}`);
  return {
    name,
    iterations,
    failures,
    failureRate: Number((failures / iterations).toFixed(4)),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: Number(Math.max(0, ...durations).toFixed(2)),
  };
}

async function seedCapacityFixture(pool: Pool, ownerId: string, runKey: string): Promise<void> {
  const client = await pool.connect();
  const now = new Date().toISOString();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO projects (id, owner_id, name, task_prefix, next_task_number, rank, version, created_at, updated_at) ' +
        "VALUES ($1, $2, 'Capacity fixture', 'PF', $3, 1024, 1, $4, $4)",
      [idFor(runKey, 'project', 1), ownerId, TASK_COUNT + 1, now],
    );
    await client.query(
      'INSERT INTO time_points (id, owner_id, type, local_date, rank, version, created_at, updated_at) ' +
        "SELECT md5($2 || ':date:' || gs::text)::uuid, $1, 'DATE', DATE '2020-01-01' + (gs - 1), gs::bigint * 1024, 1, $3, $3 " +
        'FROM generate_series(1, $4::integer) AS gs',
      [ownerId, runKey, now, DATE_COUNT],
    );
    await client.query(
      'INSERT INTO tasks (id, owner_id, project_id, category, reference_id, title, status, priority, rank, version, created_at, updated_at) ' +
        "SELECT md5($2 || ':task:' || gs::text)::uuid, $1, $3, 'FEATURE', 'PF-' || gs::text, 'Perf task ' || gs::text, 'TODO', 'NONE', gs::bigint * 1024, 1, $4, $4 " +
        'FROM generate_series(1, $5::integer) AS gs',
      [ownerId, runKey, idFor(runKey, 'project', 1), now, TASK_COUNT],
    );
    await client.query(
      'INSERT INTO placements (id, owner_id, task_id, time_point_id, rank, version, created_at, updated_at) ' +
        "SELECT md5($2 || ':placement:' || task_no::text || ':' || date_no::text)::uuid, $1, " +
        "md5($2 || ':task:' || task_no::text)::uuid, md5($2 || ':date:' || date_no::text)::uuid, task_no::bigint * 1024, 1, $3, $3 " +
        'FROM generate_series(1, $4::integer) AS task_no ' +
        'CROSS JOIN generate_series(1, $5::integer) AS date_no',
      [ownerId, runKey, now, TASK_COUNT, DATES_PER_TASK],
    );
    await client.query('ANALYZE projects, tasks, time_points, placements');
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the seed failure. */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function countFixture(
  pool: Pool,
  ownerId: string,
): Promise<{ tasks: number; timePoints: number; placements: number }> {
  const result = await pool.query<{ table_name: string; count: string }>(
    "SELECT 'tasks' AS table_name, COUNT(*)::text AS count FROM tasks WHERE owner_id = $1 " +
      "UNION ALL SELECT 'time_points', COUNT(*)::text FROM time_points WHERE owner_id = $1 " +
      "UNION ALL SELECT 'placements', COUNT(*)::text FROM placements WHERE owner_id = $1",
    [ownerId],
  );
  const values = new Map(result.rows.map((row) => [row.table_name, Number(row.count)]));
  return {
    tasks: values.get('tasks') ?? 0,
    timePoints: values.get('time_points') ?? 0,
    placements: values.get('placements') ?? 0,
  };
}

async function walkPages<T>(
  operation: (cursor?: string) => Promise<PostgresPage<T>>,
): Promise<number> {
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < 10_000; page += 1) {
    const result = await operation(cursor);
    total += result.items.length;
    if (!result.nextCursor) return total;
    cursor = result.nextCursor;
  }
  throw new Error('keyset pagination did not terminate');
}

async function main(): Promise<void> {
  if (!databaseUrl) {
    console.log(
      'NOT RUN: DATABASE_URL is not configured; capacity requires a real PostgreSQL fixture.',
    );
    process.exitCode = 2;
    return;
  }

  const runKey = `capacity-${process.pid}-${Date.now()}`;
  const projectId = idFor(runKey, 'project', 1);
  const firstDateId = idFor(runKey, 'date', 1);
  const username = `perf-${process.pid}-${Date.now()}`;
  const pool = createPool(databaseUrl);
  const store = new PostgresStore(pool);
  let actualOwnerId: string | undefined;
  try {
    await runMigrations(pool);
    await store.init();
    const owner = await store.withMutation(() => {
      return store.createOwner(username, 'perf-fixture-hash');
    });
    const ownerId = owner.id;
    actualOwnerId = ownerId;
    await seedCapacityFixture(pool, ownerId, runKey);
    const counts = await countFixture(pool, ownerId);
    if (
      counts.tasks !== TASK_COUNT ||
      counts.timePoints !== DATE_COUNT ||
      counts.placements !== PLACEMENT_COUNT
    )
      throw new Error(`fixture count mismatch: ${JSON.stringify(counts)}`);

    const walkedTasks = await walkPages((cursor) =>
      store.listTasksPage(ownerId, { projectId }, cursor, PAGE_SIZE),
    );
    const walkedDates = await walkPages((cursor) =>
      store.listTimePointsPage(ownerId, 'DATE', false, cursor, PAGE_SIZE),
    );
    const walkedPlacements = await walkPages((cursor) =>
      store.listPlacementsPage(ownerId, firstDateId, cursor, PAGE_SIZE),
    );
    const expectedPlacementsForFirstDate = TASK_COUNT;
    if (
      walkedTasks !== TASK_COUNT ||
      walkedDates !== DATE_COUNT ||
      walkedPlacements !== expectedPlacementsForFirstDate
    )
      throw new Error(
        `keyset count mismatch: tasks=${walkedTasks}, dates=${walkedDates}, placements=${walkedPlacements}`,
      );

    const syncStartCursor = (await store.syncStatus(ownerId)).oldestCursor;
    const results: Benchmark[] = [];
    results.push(
      await benchmark('tasks.first-page', 40, () =>
        store.listTasksPage(ownerId, { projectId }, undefined, PAGE_SIZE),
      ),
    );
    results.push(
      await benchmark('time-points.date-page', 40, () =>
        store.listTimePointsPage(ownerId, 'DATE', false, undefined, PAGE_SIZE),
      ),
    );
    results.push(
      await benchmark('placements.page-with-task-join', 40, () =>
        store.listPlacementsPage(ownerId, firstDateId, undefined, PAGE_SIZE),
      ),
    );
    results.push(
      await benchmark('search.owner-scoped', 40, () =>
        store.search(ownerId, 'Perf task 499', false, PAGE_SIZE),
      ),
    );
    results.push(
      await benchmark('sync.pull', 40, () => store.syncPull(ownerId, syncStartCursor, 500)),
    );
    const writeTaskIds = Array.from({ length: 32 }, (_, index) => idFor(runKey, 'task', index + 1));
    results.push(
      await benchmark('task.write.transaction', writeTaskIds.length, (index) =>
        store.withMutation(() =>
          store.updateTask(ownerId, writeTaskIds[index]!, { title: `Perf updated ${index}` }, 1),
        ),
      ),
    );

    const failed = results.filter((result) => result.failures > 0 || result.p95Ms > 250);
    const report = {
      status: failed.length ? 'FAIL' : 'PASS',
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      database: 'PostgreSQL',
      fixture: { tasks: TASK_COUNT, timePoints: DATE_COUNT, placements: PLACEMENT_COUNT },
      keysetWalk: {
        tasks: walkedTasks,
        dates: walkedDates,
        placementsForFirstDate: walkedPlacements,
        expectedPlacementsForFirstDate,
      },
      sync: { startCursor: syncStartCursor },
      benchmarks: results,
      threshold: { p95Ms: 250, failureRate: 0 },
    };
    console.log(JSON.stringify(report, null, 2));
    if (failed.length) {
      console.error(
        `FAIL: capacity thresholds exceeded: ${failed.map((item) => item.name).join(', ')}`,
      );
      process.exitCode = 1;
    } else console.log('PASS: 50k Task / 250k Placement PostgreSQL capacity gate.');
  } finally {
    if (actualOwnerId) {
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [actualOwnerId]);
      } catch (error) {
        console.error(`FAIL: capacity fixture cleanup failed: ${String(error)}`);
        process.exitCode = 1;
      }
    }
    await store.close();
  }
}

void main().catch((error: unknown) => {
  console.error('FAIL: capacity benchmark crashed.');
  console.error(error);
  process.exitCode = 1;
});
