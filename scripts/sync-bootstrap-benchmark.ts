import { randomUUID } from 'node:crypto';
import { createPool, runMigrations } from '../packages/database/src/index.js';
import { PostgresStore } from '../apps/api/src/postgres-store.js';
import { PostgresTreeStore } from '../apps/api/src/postgres-tree-store.js';
import { BootstrapSnapshots } from '../apps/api/src/sync-bootstrap.js';

// Only isolated test databases: never add benchmark data to a production Hub.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL must point to an isolated empty test database');
const pool = createPool(databaseUrl);
const store = new PostgresStore(pool);
const taskCount = Number(process.env['BOOTSTRAP_BENCH_TASKS'] ?? 10_000);
if (!Number.isInteger(taskCount) || taskCount < 100 || taskCount > 100_000)
  throw new Error('invalid task count');
let ownerId: string | undefined;
try {
  await runMigrations(pool);
  if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount)
    throw new Error('refusing to modify a database with existing users');
  await store.init();
  const owner = await store.withMutation(() =>
    store.createOwner(`benchmark-${randomUUID()}`, 'benchmark-no-login'),
  );
  ownerId = owner.id;
  await pool.query(
    `INSERT INTO tasks(id,owner_id,parent_folder_id,reference_id,title,status,category,rank,version)
    SELECT gen_random_uuid(), $1, NULL, 'BENCH-' || n, 'benchmark ' || n, 'TODO', 'MISC', n * 1024, 1 FROM generate_series(1,$2) n`,
    [ownerId, taskCount],
  );
  await pool.query(
    `INSERT INTO notes(id,owner_id,task_id,content_markdown,version)
    SELECT gen_random_uuid(), owner_id, id, repeat('大备注内容',400), 1 FROM tasks WHERE owner_id=$1`,
    [ownerId],
  );
  const optimized = new BootstrapSnapshots(new PostgresTreeStore(store));
  const measure = async (read: () => Promise<unknown>) => {
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const payload = await read();
      const encoded = JSON.stringify(payload);
      samples.push(performance.now() - start);
      bytes = Buffer.byteLength(encoded);
    }
    samples.sort((a, b) => a - b);
    return {
      samples: 5,
      medianMs: Math.round(samples[2]!),
      maxMs: Math.round(samples[4]!),
      responseBytes: bytes,
    };
  };
  const full = await measure(() => new PostgresTreeStore(store).snapshot(owner.id));
  const preview = await measure(() => optimized.preview(owner.id, '2026-10-13', null));
  const started = performance.now();
  const manifest = await optimized.create(owner.id, '2026-10-13');
  const bootstrapMs = Math.round(performance.now() - started);
  const page = await optimized.page(owner.id, manifest.snapshotId, 0);
  console.log(
    JSON.stringify(
      {
        environment:
          'local isolated PostgreSQL; server plus JSON serialization only; not Android startup or network',
        taskCount,
        noteCharactersPerTask: 2000,
        fullSnapshot: full,
        firstPreview: preview,
        bootstrapMs,
        pageCount: manifest.pageCount,
        firstPageBytes: Buffer.byteLength(JSON.stringify(page)),
      },
      null,
      2,
    ),
  );
} finally {
  if (ownerId) await pool.query('DELETE FROM users WHERE id=$1', [ownerId]);
  await store.close();
}
