import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';

export type DatabaseSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface DatabaseRuntimeConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean | ConnectionOptions;
  applicationName: string;
  max: number;
  maxUses: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  queryTimeoutMillis: number;
  statementTimeoutMillis: number;
  lockTimeoutMillis: number;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  listenEnabled: boolean;
}

export type DatabaseEnv = Record<string, string | undefined>;

/**
 * Resolve PostgreSQL connection settings from explicit environment variables.
 *
 * `DATABASE_URL` is the primary, portable form. Discrete `PG*` variables are
 * supported as a fallback because they avoid URL-encoding mistakes when a
 * password contains `@`, `:`, `/` or `#` (a real problem for bundled Docker
 * deployments). Empty strings are treated as unset so Compose can pass
 * `MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL:-}` safely.
 */
export function readDatabaseRuntimeConfig(env: DatabaseEnv = process.env): DatabaseRuntimeConfig {
  const connectionString = envString(env, 'DATABASE_URL');
  const host = envString(env, 'PGHOST') ?? envString(env, 'DATABASE_HOST');
  const database = envString(env, 'PGDATABASE') ?? envString(env, 'DATABASE_NAME');
  if (!connectionString && (!host || !database))
    throw new Error(
      'DATABASE_URL or PGHOST/PGDATABASE must be set to use PostgreSQL; set DEV_MEMORY_STORE=true only for local development',
    );

  const sslMode = parseSslMode(envString(env, 'DATABASE_SSL_MODE') ?? envString(env, 'PGSSLMODE'));
  const ssl = buildSsl(sslMode, envString(env, 'DATABASE_SSL_CA'));

  return {
    // node-postgres lets an sslmode query parameter override an explicit ssl
    // object. Remove the URL parameters when the environment is the source of
    // truth so DATABASE_SSL_MODE / DATABASE_SSL_CA always win.
    connectionString:
      connectionString && sslMode ? stripSslParams(connectionString) : connectionString,
    host: connectionString ? undefined : host,
    port: connectionString
      ? undefined
      : optionalInteger(env, 'PGPORT', 'DATABASE_PORT', 5432, 1, 65_535),
    user: connectionString ? undefined : envString(env, 'PGUSER'),
    password: connectionString ? undefined : envString(env, 'PGPASSWORD'),
    database: connectionString ? undefined : database,
    ssl,
    applicationName: envString(env, 'DB_APPLICATION_NAME') ?? 'taskdock-api',
    max: integerInRange(env, 'DB_POOL_MAX', 10, 1, 100),
    maxUses: integerInRange(env, 'DB_MAX_USES', 1_000, 1, 1_000_000),
    connectionTimeoutMillis: integerInRange(env, 'DB_CONNECT_TIMEOUT_MS', 5_000, 1, 120_000),
    idleTimeoutMillis: integerInRange(env, 'DB_IDLE_TIMEOUT_MS', 30_000, 1, 3_600_000),
    queryTimeoutMillis: integerInRange(env, 'DB_QUERY_TIMEOUT_MS', 30_000, 1, 120_000),
    statementTimeoutMillis: integerInRange(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000, 1, 120_000),
    lockTimeoutMillis: integerInRange(env, 'DB_LOCK_TIMEOUT_MS', 5_000, 1, 120_000),
    keepAlive: booleanValue(
      envString(env, 'DB_KEEPALIVE') ?? envString(env, 'DB_KEEP_ALIVE'),
      true,
    ),
    keepAliveInitialDelayMillis: integerInRange(
      env,
      'DB_KEEPALIVE_INITIAL_DELAY_MS',
      10_000,
      0,
      120_000,
    ),
    listenEnabled: booleanValue(envString(env, 'DB_LISTEN_ENABLED'), true),
  };
}

export function poolConfigFromRuntime(config: DatabaseRuntimeConfig): pg.PoolConfig {
  const base: pg.PoolConfig = config.connectionString
    ? { connectionString: config.connectionString }
    : {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
      };
  return {
    ...base,
    ssl: config.ssl,
    application_name: config.applicationName,
    max: config.max,
    maxUses: config.maxUses,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    lock_timeout: config.lockTimeoutMillis,
    keepAlive: config.keepAlive,
    keepAliveInitialDelayMillis: config.keepAliveInitialDelayMillis,
  };
}

export function createPoolFromEnv(env: DatabaseEnv = process.env): {
  pool: pg.Pool;
  settings: DatabaseRuntimeConfig;
} {
  const settings = readDatabaseRuntimeConfig(env);
  return { pool: new pg.Pool(poolConfigFromRuntime(settings)), settings };
}

/** Open `count` connections once so the first request does not pay TCP/TLS setup. */
export async function warmPool(pool: pg.Pool, count: number): Promise<void> {
  const warm = Math.max(0, Math.min(Math.trunc(count), pool.options.max ?? 0));
  if (!warm) return;
  const clients = await Promise.all(Array.from({ length: warm }, () => pool.connect()));
  for (const client of clients) client.release();
}

function envString(env: DatabaseEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function optionalInteger(
  env: DatabaseEnv,
  primary: string,
  fallback: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  return integerInRange(env, primary, defaultValue, min, max, fallback);
}

function integerInRange(
  env: DatabaseEnv,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
  alias?: string,
): number {
  const raw = envString(env, name) ?? (alias ? envString(env, alias) : undefined);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function booleanValue(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseSslMode(raw: string | undefined): DatabaseSslMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'disable' || normalized === 'false' || normalized === 'off') return 'disable';
  // libpq "prefer"/"allow" mean opportunistic TLS. Let node-postgres/libpq
  // defaults decide instead of forcing an encrypted-only connection.
  if (normalized === 'prefer' || normalized === 'allow') return undefined;
  if (normalized === 'require' || normalized === 'true' || normalized === 'on') return 'require';
  if (normalized === 'verify-full' || normalized === 'verify-ca') return normalized;
  throw new Error('DATABASE_SSL_MODE must be disable, require, verify-ca or verify-full');
}

function stripSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    for (const key of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey'])
      url.searchParams.delete(key);
    return url.toString();
  } catch {
    return connectionString;
  }
}

function buildSsl(
  mode: DatabaseSslMode | undefined,
  caPath: string | undefined,
): boolean | ConnectionOptions | undefined {
  if (!mode) {
    // Let the connection string / libpq defaults decide. Do not force TLS off
    // when a URL such as ?sslmode=verify-full is supplied.
    return undefined;
  }
  if (mode === 'disable') {
    if (caPath) throw new Error('DATABASE_SSL_CA cannot be used when DATABASE_SSL_MODE=disable');
    return false;
  }
  const ssl: ConnectionOptions = { rejectUnauthorized: true };
  if (mode === 'verify-ca') {
    // verify-ca validates the CA chain but deliberately skips hostname checks.
    ssl.checkServerIdentity = () => undefined;
  }
  if (caPath) ssl.ca = readFileSync(caPath, 'utf8');
  return ssl;
}
