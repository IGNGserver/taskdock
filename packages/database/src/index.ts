import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export * from './schema.js';
export type { Pool } from 'pg';

const { Pool } = pg;

export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString, max: 10, maxUses: 1000, application_name: 'devtodo-api' });
}

export interface MigrationOptions {
  migrationsDir?: string;
}

export async function runMigrations(pool: pg.Pool, options: MigrationOptions = {}): Promise<void> {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const files = await discoverMigrationFiles(migrationsDir);
  const migrations = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(resolve(migrationsDir, name), 'utf8');
      return { name, sql, checksum: sha256(sql) };
    }),
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('devtodo:schema-migrations', 0))",
    );
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
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseReady(
  pool: pg.Pool,
  options: MigrationOptions = {},
): Promise<boolean> {
  try {
    const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
    const files = await discoverMigrationFiles(migrationsDir);
    const result = await pool.query<{ name: string; checksum: string | null }>(
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

function defaultMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
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
