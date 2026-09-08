import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/index.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };

class FakeClient {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  private transactionSnapshot: Array<{ name: string; checksum: string | null }> | null = null;

  constructor(
    private readonly database: FakeDatabase,
    private readonly failSqlContaining?: string,
  ) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult & { rows: T[] }> {
    this.queries.push({ text, values });
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN') {
      this.transactionSnapshot = this.database.migrations.map((row) => ({ ...row }));
      return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
    }
    if (normalized === 'COMMIT') {
      this.transactionSnapshot = null;
      return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
    }
    if (normalized === 'ROLLBACK') {
      this.database.migrations = this.transactionSnapshot?.map((row) => ({ ...row })) ?? [];
      this.transactionSnapshot = null;
      return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
    }
    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
    }
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      this.database.schemaTableCreated = true;
      return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
    }
    if (normalized.startsWith('ALTER TABLE schema_migrations')) {
      return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
    }
    if (normalized.startsWith('SELECT name, checksum FROM schema_migrations')) {
      const name = values[0];
      const row = this.database.migrations.find((candidate) => candidate.name === name);
      return {
        rows: row ? ([{ ...row }] as T[]) : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (normalized.startsWith('UPDATE schema_migrations SET checksum')) {
      const name = String(values[0]);
      const checksum = String(values[1]);
      const row = this.database.migrations.find((candidate) => candidate.name === name);
      if (!row) throw new Error(`missing migration row: ${name}`);
      row.checksum = checksum;
      return { rows: [], rowCount: 1 } as QueryResult & { rows: T[] };
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      this.database.migrations.push({
        name: String(values[0]),
        checksum: String(values[1]),
      });
      return { rows: [], rowCount: 1 } as QueryResult & { rows: T[] };
    }
    if (this.failSqlContaining && text.includes(this.failSqlContaining))
      throw new Error(`injected migration failure: ${this.failSqlContaining}`);
    return { rows: [], rowCount: 0 } as QueryResult & { rows: T[] };
  }

  release(): void {
    this.database.releasedClients += 1;
  }
}

class FakeDatabase {
  migrations: Array<{ name: string; checksum: string | null }> = [];
  schemaTableCreated = false;
  releasedClients = 0;
  readonly clients: FakeClient[] = [];
  failNextSqlContaining: string | undefined;

  connect(): FakeClient {
    const client = new FakeClient(this, this.failNextSqlContaining);
    this.failNextSqlContaining = undefined;
    this.clients.push(client);
    return client;
  }

  async query<T extends Record<string, unknown>>(
    text: string,
  ): Promise<QueryResult & { rows: T[] }> {
    if (text.startsWith('SELECT name, checksum FROM schema_migrations')) {
      return {
        rows: this.migrations.map((row) => ({ ...row })) as T[],
        rowCount: this.migrations.length,
      };
    }
    throw new Error(`unexpected pool query: ${text}`);
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'devtodo-migrations-'));
  directories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql, 'utf8')),
  );
  return directory;
}

function appliedNames(database: FakeDatabase): string[] {
  return database.migrations.map((migration) => migration.name);
}

describe('database migration executor', () => {
  it('discovers migrations, ignores unrelated files, and sorts by numeric version', async () => {
    const directory = await migrationDirectory({
      '10_tenth.sql': 'SELECT 10;',
      '2_second.sql': 'SELECT 2;',
      '0001_first.sql': 'SELECT 1;',
      README: 'not SQL',
    });
    const database = new FakeDatabase();

    await runMigrations(database as never, { migrationsDir: directory });

    expect(appliedNames(database)).toEqual(['0001_first.sql', '2_second.sql', '10_tenth.sql']);
    const sqlQueries = database.clients[0]!.queries.map((query) => query.text).filter((text) =>
      /^SELECT (?:1|2|10);$/.test(text),
    );
    expect(sqlQueries).toEqual(['SELECT 1;', 'SELECT 2;', 'SELECT 10;']);
  });

  it('is idempotent on repeated execution', async () => {
    const directory = await migrationDirectory({
      '0001_first.sql': 'CREATE TABLE first_table (id integer);',
      '0002_second.sql': 'CREATE TABLE second_table (id integer);',
    });
    const database = new FakeDatabase();

    await runMigrations(database as never, { migrationsDir: directory });
    await runMigrations(database as never, { migrationsDir: directory });

    expect(appliedNames(database)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(
      database.clients[1]!.queries.filter((query) =>
        query.text.includes('CREATE TABLE first_table'),
      ),
    ).toHaveLength(0);
    expect(database.clients[1]!.queries.filter((query) => query.text === 'COMMIT')).toHaveLength(1);
  });

  it('rejects a changed applied migration and rolls back the transaction', async () => {
    const directory = await migrationDirectory({ '0001_first.sql': 'SELECT original;' });
    const database = new FakeDatabase();

    await runMigrations(database as never, { migrationsDir: directory });
    await writeFile(join(directory, '0001_first.sql'), 'SELECT changed;', 'utf8');

    await expect(runMigrations(database as never, { migrationsDir: directory })).rejects.toThrow(
      'Migration checksum mismatch: 0001_first.sql',
    );
    expect(database.clients[1]!.queries.filter((query) => query.text === 'COMMIT')).toHaveLength(0);
    expect(database.clients[1]!.queries.filter((query) => query.text === 'ROLLBACK')).toHaveLength(
      1,
    );
    expect(database.migrations[0]!.checksum).not.toBeNull();
  });

  it('backfills a legacy empty checksum exactly once', async () => {
    const directory = await migrationDirectory({ '0001_first.sql': 'SELECT original;' });
    const database = new FakeDatabase();
    database.migrations = [{ name: '0001_first.sql', checksum: null }];

    await runMigrations(database as never, { migrationsDir: directory });
    await runMigrations(database as never, { migrationsDir: directory });

    expect(database.migrations[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(
      database.clients[0]!.queries.filter((query) =>
        query.text.startsWith('UPDATE schema_migrations SET checksum'),
      ),
    ).toHaveLength(1);
    expect(
      database.clients[1]!.queries.filter((query) =>
        query.text.startsWith('UPDATE schema_migrations SET checksum'),
      ),
    ).toHaveLength(0);
  });

  it('rolls back all migrations when one SQL statement fails', async () => {
    const directory = await migrationDirectory({
      '0001_first.sql': 'CREATE TABLE first_table (id integer);',
      '0002_failing.sql': 'SELECT FAIL_ME;',
    });
    const database = new FakeDatabase();
    database.failNextSqlContaining = 'FAIL_ME';

    await expect(runMigrations(database as never, { migrationsDir: directory })).rejects.toThrow(
      'injected migration failure',
    );
    expect(database.migrations).toEqual([]);
    expect(database.clients[0]!.queries.filter((query) => query.text === 'ROLLBACK')).toHaveLength(
      1,
    );
    expect(database.clients[0]!.queries.filter((query) => query.text === 'COMMIT')).toHaveLength(0);
  });

  it('can safely retry after an interrupted migration transaction', async () => {
    const directory = await migrationDirectory({
      '0001_first.sql': 'CREATE TABLE first_table (id integer);',
      '0002_second.sql': 'CREATE TABLE second_table (id integer);',
    });
    const database = new FakeDatabase();
    database.failNextSqlContaining = 'second_table';

    await expect(runMigrations(database as never, { migrationsDir: directory })).rejects.toThrow(
      'injected migration failure',
    );
    expect(database.migrations).toEqual([]);

    await runMigrations(database as never, { migrationsDir: directory });
    expect(appliedNames(database)).toEqual(['0001_first.sql', '0002_second.sql']);
  });
});
