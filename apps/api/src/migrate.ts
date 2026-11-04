import {
  createPool,
  poolConfigFromRuntime,
  readDatabaseRuntimeConfig,
  runMigrations,
} from '@devtodo/database';

const migrationUrl = process.env['MIGRATION_DATABASE_URL']?.trim();
const env: Record<string, string | undefined> = {
  ...process.env,
  ...(migrationUrl ? { DATABASE_URL: migrationUrl } : {}),
};
const settings = readDatabaseRuntimeConfig(env);
const timeout = Number(process.env['MIGRATION_STATEMENT_TIMEOUT_MS'] ?? 300_000);
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
} finally {
  await pool.end();
}
