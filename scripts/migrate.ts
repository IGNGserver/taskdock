import { createPool, runMigrations } from '../packages/database/src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
async function main(): Promise<void> {
  if (!databaseUrl) {
    console.log(
      'NOT RUN: DATABASE_URL is not configured; no PostgreSQL server is available for migration.',
    );
    process.exitCode = 2;
    return;
  }
  const pool = createPool(databaseUrl);
  try {
    await runMigrations(pool);
    console.log('PASS: PostgreSQL migrations applied and schema_migrations is current.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
