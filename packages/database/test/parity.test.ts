import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

async function migrationFiles(engine: 'postgres' | 'mysql'): Promise<string[]> {
  const files = await readdir(resolve(migrationsRoot, engine));
  return files.filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
}

function version(name: string): number {
  return Number(/^(\d+)_/.exec(name)![1]);
}

async function tableNames(engine: 'postgres' | 'mysql'): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await migrationFiles(engine)) {
    const sql = await readFile(resolve(migrationsRoot, engine, file), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([a-z_]+)"?/gi))
      names.add(match[1]!);
    // Historical tables that a later migration drops do not survive to the end.
    for (const match of sql.matchAll(/DROP TABLE IF EXISTS\s+"?([a-z_]+)"?/gi))
      names.delete(match[1]!);
  }
  return names;
}

describe('two-engine migration parity', () => {
  it('ships the MySQL baseline at the PostgreSQL baseline version', async () => {
    const postgres = await migrationFiles('postgres');
    const mysql = await migrationFiles('mysql');
    expect(mysql.length).toBeGreaterThan(0);
    // MySQL starts from a consolidated baseline; it must be the newest
    // PostgreSQL version so both engines describe the same schema generation.
    expect(version(mysql[0]!)).toBe(Math.max(...postgres.map(version)));
  });

  it('adds every later migration to both engines', async () => {
    const postgres = await migrationFiles('postgres');
    const mysql = await migrationFiles('mysql');
    const baseline = version(mysql[0]!);
    const later = postgres.map(version).filter((value) => value > baseline);
    const mysqlVersions = new Set(mysql.map(version));
    for (const value of later)
      expect(mysqlVersions.has(value), `mysql is missing migration ${value}`).toBe(true);
  });

  it('creates every PostgreSQL table in the MySQL baseline', async () => {
    const postgres = await tableNames('postgres');
    const mysql = await tableNames('mysql');
    const missing = [...postgres].filter(
      (table) => table !== 'schema_migrations' && !mysql.has(table),
    );
    expect(missing, `MySQL baseline is missing tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('quotes the reserved identifiers the MySQL schema uses', async () => {
    const baseline = await readFile(
      resolve(migrationsRoot, 'mysql', (await migrationFiles('mysql'))[0]!),
      'utf8',
    );
    // `rank` and `cursor` are reserved in MySQL; an unquoted occurrence in DDL
    // is a hard syntax error, so guard the baseline text directly.
    expect(baseline).not.toMatch(/(?<!`)\brank\b(?!`)\s+(BIGINT|INT)/i);
    expect(baseline).not.toMatch(/(?<!`)\bcursor\b(?!`)\s+(BIGINT|INT)/i);
  });
});
