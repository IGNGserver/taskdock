import { createPool, runMigrations } from '@devtodo/database';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for the migration job');
const pool = createPool(databaseUrl);
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}
