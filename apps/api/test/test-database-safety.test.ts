import { describe, expect, it } from 'vitest';
import type { Pool } from '@devtodo/database';
import {
  assertIsolatedEmptyDatabase,
  isolatedTestDatabaseUrl,
} from '../../../scripts/test-database-safety.js';

function poolWith(tables: string[], owners = '0'): Pool {
  return {
    query: async (text: string) => {
      if (text.includes('information_schema.tables'))
        return { rows: tables.map((table_name) => ({ table_name })) };
      if (text.includes('COUNT(*)') && text.includes('FROM users'))
        return { rows: [{ count: owners }] };
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as Pool;
}

describe('destructive test database protection', () => {
  it('never falls back to the application database URL', () => {
    expect(isolatedTestDatabaseUrl({ DATABASE_URL: 'postgres://production.invalid/db' })).toBe(
      undefined,
    );
    expect(
      isolatedTestDatabaseUrl({
        DATABASE_URL: 'postgres://production.invalid/db',
        TASKDOCK_TEST_DATABASE_URL: 'postgres://test-only.invalid/empty',
      }),
    ).toBe('postgres://test-only.invalid/empty');
  });

  it('allows a genuinely empty database before migrations', async () => {
    await expect(assertIsolatedEmptyDatabase(poolWith([]), 'test')).resolves.toBeUndefined();
  });

  it('rejects arbitrary existing tables before migrations', async () => {
    await expect(assertIsolatedEmptyDatabase(poolWith(['business_data']), 'test')).rejects.toThrow(
      'before migration',
    );
  });

  it('rejects active and disabled Owners without filtering by disabled_at', async () => {
    await expect(assertIsolatedEmptyDatabase(poolWith(['users'], '1'), 'test')).rejects.toThrow(
      'including disabled Owners',
    );
  });

  it('allows an existing migrated schema only when every Owner is absent', async () => {
    await expect(
      assertIsolatedEmptyDatabase(poolWith(['users', 'tasks']), 'test'),
    ).resolves.toBeUndefined();
  });
});
