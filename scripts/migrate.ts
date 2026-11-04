import {
  createPool,
  poolConfigFromRuntime,
  readDatabaseRuntimeConfig,
  runMigrations,
} from '../packages/database/src/index.js';

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env };
  const migrationUrl = env['MIGRATION_DATABASE_URL']?.trim();
  if (migrationUrl) env['DATABASE_URL'] = migrationUrl;
  if (!env['DATABASE_URL'] && !(env['PGHOST'] && env['PGDATABASE'])) {
    console.log(
      'NOT RUN: DATABASE_URL or PGHOST/PGDATABASE is not configured; no PostgreSQL server is available for migration.',
    );
    process.exitCode = 2;
    return;
  }
  const settings = readDatabaseRuntimeConfig(env);
  const timeout = Number(env['MIGRATION_STATEMENT_TIMEOUT_MS'] ?? 300_000);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 3_600_000)
    throw new Error('MIGRATION_STATEMENT_TIMEOUT_MS must be an integer between 0 and 3600000');
  const pool = createPool(poolConfigFromRuntime(settings), {
    statementTimeoutMillis: timeout,
    queryTimeoutMillis: timeout,
    applicationName: `${settings.applicationName}-migrate`,
    max: 2,
  });
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
