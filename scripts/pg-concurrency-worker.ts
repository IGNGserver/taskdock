import { createPool } from '../packages/database/src/index.js';
import { PostgresStore } from '../apps/api/src/postgres-store.js';

const databaseUrl = process.env['DATABASE_URL'];
const ownerId = process.env['DEVTODO_OWNER_ID'];
const projectId = process.env['DEVTODO_PROJECT_ID'];
const workerLabel = process.env['DEVTODO_WORKER_LABEL'] ?? 'worker';
const workerCount = Number(process.env['DEVTODO_WORKER_COUNT'] ?? 20);

async function main(): Promise<void> {
  if (!databaseUrl || !ownerId || !projectId)
    throw new Error('DATABASE_URL, DEVTODO_OWNER_ID, and DEVTODO_PROJECT_ID are required');
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 100)
    throw new Error('DEVTODO_WORKER_COUNT must be an integer from 1 to 100');

  const pool = createPool(databaseUrl);
  const store = new PostgresStore(pool);
  try {
    await store.init();
    const references: string[] = [];
    for (let index = 0; index < workerCount; index += 1) {
      const task = await store.withMutation(() =>
        store.createTask(ownerId, {
          projectId,
          category: 'FEATURE',
          title: `${workerLabel} task ${index + 1}`,
          priority: 'NONE',
        }),
      );
      references.push(task.referenceId);
    }
    console.log(JSON.stringify({ worker: workerLabel, references }));
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
