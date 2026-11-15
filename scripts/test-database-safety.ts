import type { SqlDatabase } from '../packages/database/src/index.js';

/** Destructive fixtures never fall back to the application's DATABASE_URL. */
export function isolatedTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['TASKDOCK_TEST_DATABASE_URL'];
}

/**
 * Destructive test scripts may create and delete large fixtures. Check the
 * target before running migrations, because even DDL can be unsafe on a real
 * deployment and an active Owner check after migration is already too late.
 */
export async function assertIsolatedEmptyDatabase(
  database: SqlDatabase,
  label: string,
): Promise<void> {
  const tables =
    database.dialect === 'mysql'
      ? await database.query<{ table_name: string }>(
          'SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE table_schema = DATABASE()',
        )
      : await database.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        );
  const tableNames = new Set(tables.rows.map((row) => row.table_name));
  if (!tableNames.has('users')) {
    const unexpected = [...tableNames].filter((name) => name !== 'schema_migrations');
    if (unexpected.length)
      throw new Error(
        `${label} requires a dedicated empty TASKDOCK_TEST_DATABASE_URL; found tables before migration: ${unexpected.join(', ')}`,
      );
    return;
  }
  const owners = await database.query<{ count: string | number }>(
    'SELECT COUNT(*) AS count FROM users',
  );
  if (BigInt(String(owners.rows[0]?.count ?? '0')) > 0n)
    throw new Error(
      `${label} requires a dedicated empty TASKDOCK_TEST_DATABASE_URL; refusing to modify a database containing any Owner, including disabled Owners`,
    );
}
