import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { poolConfigFromRuntime, readDatabaseRuntimeConfig } from '../src/config.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('database runtime config', () => {
  it('uses DATABASE_URL first and applies pool overrides', () => {
    const config = readDatabaseRuntimeConfig({
      DATABASE_URL: 'postgres://user:pass@db.example.lan:5432/taskdock',
      DB_POOL_MAX: '6',
      DB_POOL_WARM: '2',
      DB_IDLE_TIMEOUT_MS: '300000',
      DB_APPLICATION_NAME: 'taskdock-home',
    });
    expect(config.connectionString).toBe('postgres://user:pass@db.example.lan:5432/taskdock');
    expect(config.max).toBe(6);
    expect(config.idleTimeoutMillis).toBe(300_000);
    expect(config.applicationName).toBe('taskdock-home');

    const pool = poolConfigFromRuntime(config);
    expect(pool.connectionString).toBe('postgres://user:pass@db.example.lan:5432/taskdock');
    expect(pool.max).toBe(6);
    expect(pool.application_name).toBe('taskdock-home');
  });

  it('supports discrete PG* variables so passwords do not need URL encoding', () => {
    const config = readDatabaseRuntimeConfig({
      PGHOST: 'db.example.lan',
      PGPORT: '5433',
      PGUSER: 'taskdock',
      PGPASSWORD: 'p@ss:word/with#chars',
      PGDATABASE: 'taskdock_office',
      DB_LISTEN_ENABLED: 'false',
    });
    expect(config.connectionString).toBeUndefined();
    expect(config.host).toBe('db.example.lan');
    expect(config.port).toBe(5433);
    expect(config.password).toBe('p@ss:word/with#chars');
    expect(config.database).toBe('taskdock_office');
    expect(config.listenEnabled).toBe(false);

    const pool = poolConfigFromRuntime(config);
    expect(pool.password).toBe('p@ss:word/with#chars');
    expect(pool.database).toBe('taskdock_office');
  });

  it('reads a CA file for verify-full TLS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskdock-db-ca-'));
    directories.push(directory);
    const caPath = join(directory, 'ca.pem');
    writeFileSync(caPath, 'test-ca');
    const config = readDatabaseRuntimeConfig({
      DATABASE_URL: 'postgres://user:pass@db.example.lan/taskdock?sslmode=require',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA: caPath,
    });
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true, ca: 'test-ca' });
    expect(config.connectionString).not.toContain('sslmode');
  });

  it('treats empty optional values as unset (Compose `${VAR:-}`)', () => {
    const config = readDatabaseRuntimeConfig({
      DATABASE_URL: 'postgres://user:pass@db.example.lan/taskdock',
      MIGRATION_DATABASE_URL: '',
      DB_POOL_MAX: '3',
    });
    expect(config.max).toBe(3);
  });

  it('rejects missing database settings and invalid bounds', () => {
    expect(() => readDatabaseRuntimeConfig({})).toThrow(/DATABASE_URL or PGHOST/);
    expect(() =>
      readDatabaseRuntimeConfig({
        DATABASE_URL: 'postgres://user:pass@db.example.lan/taskdock',
        DB_POOL_MAX: '0',
      }),
    ).toThrow(/DB_POOL_MAX/);
    expect(() =>
      readDatabaseRuntimeConfig({
        DATABASE_URL: 'postgres://user:pass@db.example.lan/taskdock',
        DATABASE_SSL_MODE: 'sometimes',
      }),
    ).toThrow(/DATABASE_SSL_MODE/);
  });
});

describe('dual engine settings', () => {
  it('detects MySQL from the DATABASE_URL scheme', async () => {
    const { readDatabaseSettings } = await import('../src/config.js');
    const settings = readDatabaseSettings({
      DATABASE_URL: 'mysql://taskdock:secret@db.example.lan:3307/taskdock',
      DB_POOL_MAX: '4',
    });
    expect(settings.dialect).toBe('mysql');
    expect(settings.connectionString).toBe('mysql://taskdock:secret@db.example.lan:3307/taskdock');
    expect(settings.max).toBe(4);
    // MySQL has no LISTEN/NOTIFY; the flag must not claim otherwise.
    expect(settings.listenEnabled).toBe(false);
  });

  it('supports discrete MYSQL_* variables and the 3306 default', async () => {
    const { readDatabaseSettings } = await import('../src/config.js');
    const settings = readDatabaseSettings({
      MYSQL_HOST: 'db.example.lan',
      MYSQL_USER: 'taskdock',
      MYSQL_PASSWORD: 'p@ss:word',
      MYSQL_DATABASE: 'taskdock_home',
    });
    expect(settings.dialect).toBe('mysql');
    expect(settings.port).toBe(3306);
    expect(settings.password).toBe('p@ss:word');
    expect(settings.database).toBe('taskdock_home');
  });

  it('honours an explicit DB_DIALECT override', async () => {
    const { readDatabaseSettings } = await import('../src/config.js');
    expect(() => readDatabaseSettings({ DB_DIALECT: 'oracle' })).toThrow(/DB_DIALECT/);
    expect(() =>
      readDatabaseSettings({ DB_DIALECT: 'mysql', DATABASE_URL: 'mysql://host/db' }),
    ).not.toThrow();
  });

  it('rejects a DATABASE_URL without a recognised scheme', async () => {
    const { readDatabaseSettings } = await import('../src/config.js');
    expect(() => readDatabaseSettings({ DATABASE_URL: 'file:/tmp/db' })).toThrow(
      /postgres:|mysql:/,
    );
  });
});
