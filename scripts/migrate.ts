import {
  openDatabase,
  readDatabaseSettings,
  runMigrations,
} from '../packages/database/src/index.js';

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env };
  const migrationUrl = env['MIGRATION_DATABASE_URL']?.trim();
  if (migrationUrl) env['DATABASE_URL'] = migrationUrl;
  const configured = Boolean(
    env['DATABASE_URL'] ||
    (env['PGHOST'] && env['PGDATABASE']) ||
    (env['MYSQL_HOST'] && env['MYSQL_DATABASE']),
  );
  if (!configured) {
    console.log(
      'NOT RUN: DATABASE_URL or the discrete database variables are not configured; no server is available for migration.',
    );
    process.exitCode = 2;
    return;
  }
  const settings = readDatabaseSettings(env);
  const label = settings.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL';
  const timeout = Number(env['MIGRATION_STATEMENT_TIMEOUT_MS'] ?? 300_000);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 3_600_000)
    throw new Error('MIGRATION_STATEMENT_TIMEOUT_MS must be an integer between 0 and 3600000');
  const database = openDatabase({
    ...settings,
    applicationName: `${settings.applicationName}-migrate`,
    max: 2,
    queryTimeoutMillis: timeout,
    statementTimeoutMillis: timeout,
  });
  try {
    await runMigrations(database);
    console.log(`PASS: ${label} migrations applied and schema_migrations is current.`);
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
