import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { splitSqlStatements, type DatabaseDialectName } from './dialect.js';
import type { QueryResult, SqlDatabase } from './pool.js';

export interface MigrationOptions {
  migrationsDir?: string;
}

interface MigrationSession {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface MigrationTarget {
  dialect: DatabaseDialectName;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  session(): Promise<MigrationSession>;
}

type PointOfTruth = SqlDatabase | pg.Pool | MigrationTarget;

const MIGRATION_LOCK = 'taskdock:schema-migrations';
const POSTGRES_ADVISORY =
  "SELECT pg_advisory_xact_lock(hashtextextended('taskdock:schema-migrations', 0))";

/**
 * Apply every pending migration.
 *
 * PostgreSQL runs the whole set inside one transaction (DDL rolls back), under
 * an advisory lock. MySQL commits DDL implicitly, so each file is applied on its
 * own and recorded immediately; a failure leaves earlier files applied, which
 * is exactly what the recorded checksums then describe.
 */
export async function runMigrations(
  pointOfTruth: PointOfTruth,
  options: MigrationOptions = {},
): Promise<void> {
  const target = toTarget(pointOfTruth);
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir(target.dialect);
  const migrations = await loadMigrations(migrationsDir);
  if (target.dialect === 'mysql') await runMysqlMigrations(target, migrations);
  else await runPostgresMigrations(target, migrations);
}

export async function databaseReady(
  pointOfTruth: PointOfTruth,
  options: MigrationOptions = {},
): Promise<boolean> {
  const target = toTarget(pointOfTruth);
  try {
    const migrationsDir = options.migrationsDir ?? defaultMigrationsDir(target.dialect);
    const files = await discoverMigrationFiles(migrationsDir);
    const result = await target.query<{ name: string; checksum: string | null }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(result.rows.map((row) => [row.name, row.checksum]));
    for (const name of files) {
      const checksum = sha256(await readFile(resolve(migrationsDir, name), 'utf8'));
      if (applied.get(name) !== checksum) return false;
    }
    return files.length > 0 && files.every((name) => applied.has(name));
  } catch {
    return false;
  }
}

interface LoadedMigration {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(migrationsDir: string): Promise<LoadedMigration[]> {
  const files = await discoverMigrationFiles(migrationsDir);
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(resolve(migrationsDir, name), 'utf8');
      return { name, sql, checksum: sha256(sql) };
    }),
  );
}

async function runPostgresMigrations(
  target: MigrationTarget,
  migrations: LoadedMigration[],
): Promise<void> {
  const client = await target.session();
  try {
    await client.query('BEGIN');
    await client.query(POSTGRES_ADVISORY);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    for (const migration of migrations) {
      const exists = await client.query<{ name: string; checksum: string | null }>(
        'SELECT name, checksum FROM schema_migrations WHERE name = $1 FOR UPDATE',
        [migration.name],
      );
      const applied = exists.rows[0];
      if (applied) {
        // The original 0001 executor did not store checksums. Backfill that
        // one legacy record exactly once, then protect every applied file.
        if (!applied.checksum) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
            migration.name,
            migration.checksum,
          ]);
        } else if (applied.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the original error. */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runMysqlMigrations(
  target: MigrationTarget,
  migrations: LoadedMigration[],
): Promise<void> {
  const session = await target.session();
  let locked = false;
  try {
    const lock = await session.query<{ locked: number | null }>(
      'SELECT GET_LOCK($1, 60) AS locked',
      [MIGRATION_LOCK],
    );
    locked = Number(lock.rows[0]?.locked) === 1;
    if (!locked) throw new Error('另一项迁移正在执行，无法获得迁移锁');
    // VARCHAR(191) keeps the primary key inside the 3072-byte index budget
    // even when the connection default collation is utf8mb4.
    await session.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(191) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NULL, applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB',
    );
    const appliedRows = await session.query<{ name: string; checksum: string | null }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(appliedRows.rows.map((row) => [row.name, row.checksum]));
    for (const migration of migrations) {
      const recorded = applied.get(migration.name);
      if (recorded !== undefined) {
        if (recorded !== migration.checksum)
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        continue;
      }
      // MySQL commits DDL implicitly, so the file cannot be rolled back; record
      // it right after it succeeds instead of at the end of the run. The server
      // also refuses a whole multi-statement script unless multi-statements are
      // enabled for the connection, which is deliberately not the case.
      for (const statement of splitSqlStatements(migration.sql)) await session.query(statement);
      await session.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }
  } finally {
    if (locked) {
      try {
        await session.query('SELECT RELEASE_LOCK($1)', [MIGRATION_LOCK]);
      } catch {
        /* The lock is released when the session closes. */
      }
    }
    session.release();
  }
}

function toTarget(pointOfTruth: PointOfTruth): MigrationTarget {
  const candidate = pointOfTruth as Partial<MigrationTarget> & Partial<SqlDatabase>;
  if (candidate.dialect && typeof candidate.session === 'function' && 'settings' in candidate)
    return pointOfTruth as SqlDatabase;

  const pool = pointOfTruth as pg.Pool;
  return {
    dialect: 'postgres',
    async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const result = await pool.query(text, values as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async session() {
      const client = await pool.connect();
      return {
        async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
          const result = await client.query(text, values as unknown[]);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        async commit() {
          await client.query('COMMIT');
        },
        async rollback() {
          await client.query('ROLLBACK');
        },
        release() {
          client.release();
        },
      };
    },
  };
}

export function defaultMigrationsDir(dialect: DatabaseDialectName = 'postgres'): string {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
  const perDialect = resolve(base, dialect === 'mysql' ? 'mysql' : 'postgres');
  // Before the layout split, PostgreSQL migrations lived directly under
  // migrations/. Keep the resolution working in both layouts.
  if (existsSync(perDialect)) return perDialect;
  return base;
}

async function discoverMigrationFiles(migrationsDir: string): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((name) =>
    /^\d+_[a-z0-9_-]+\.sql$/i.test(name),
  );
  files.sort(compareMigrationNames);
  const versions = new Set<string>();
  for (const name of files) {
    const version = migrationVersion(name);
    if (versions.has(version)) throw new Error(`Duplicate database migration version: ${version}`);
    versions.add(version);
  }
  if (!files.length) throw new Error(`No database migrations found in ${migrationsDir}`);
  return files;
}

function compareMigrationNames(left: string, right: string): number {
  const leftVersion = migrationVersion(left);
  const rightVersion = migrationVersion(right);
  if (leftVersion.length !== rightVersion.length) return leftVersion.length - rightVersion.length;
  const versionOrder = leftVersion.localeCompare(rightVersion, 'en');
  return versionOrder || left.localeCompare(right, 'en');
}

function migrationVersion(name: string): string {
  const match = /^(\d+)_/.exec(name);
  if (!match) throw new Error(`Invalid database migration name: ${name}`);
  return match[1]!.replace(/^0+(?=\d)/, '');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
