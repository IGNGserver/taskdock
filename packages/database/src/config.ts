import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import type { DatabaseDialectName } from './dialect.js';

export type DatabaseSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface DatabaseSettings {
  dialect: DatabaseDialectName;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  sslMode?: DatabaseSslMode;
  /** PEM contents of the CA certificate, when one is configured. */
  sslCa?: string;
  /** node-postgres form; kept for the PostgreSQL pool. */
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
  /** Only PostgreSQL has LISTEN/NOTIFY; MySQL always reports false. */
  listenEnabled: boolean;
}

/** PostgreSQL-shaped view kept for callers that still speak `pg`. */
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

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const MYSQL_URL = /^mysql:\/\//i;

/**
 * Resolve the engine and its connection settings from the environment.
 *
 * The engine comes from `DB_DIALECT` when set, otherwise from the
 * `DATABASE_URL` scheme, otherwise from whichever discrete variables are
 * present (default PostgreSQL, which is what existing hubs are).
 */
export function readDatabaseSettings(env: DatabaseEnv = process.env): DatabaseSettings {
  const connectionString = envString(env, 'DATABASE_URL');
  const dialect = detectDialect(env, connectionString);
  const isMysql = dialect === 'mysql';

  const host = isMysql
    ? (envString(env, 'MYSQL_HOST') ?? envString(env, 'DATABASE_HOST'))
    : (envString(env, 'PGHOST') ?? envString(env, 'DATABASE_HOST'));
  const database = isMysql
    ? (envString(env, 'MYSQL_DATABASE') ?? envString(env, 'DATABASE_NAME'))
    : (envString(env, 'PGDATABASE') ?? envString(env, 'DATABASE_NAME'));
  if (!connectionString && (!host || !database))
    throw new Error(
      isMysql
        ? 'DATABASE_URL or MYSQL_HOST/MYSQL_DATABASE must be set to use MySQL; set DEV_MEMORY_STORE=true only for local development'
        : 'DATABASE_URL or PGHOST/PGDATABASE must be set to use PostgreSQL; set DEV_MEMORY_STORE=true only for local development',
    );

  const sslMode = parseSslMode(envString(env, 'DATABASE_SSL_MODE') ?? envString(env, 'PGSSLMODE'));
  const sslCaPath = envString(env, 'DATABASE_SSL_CA');
  const sslCa = sslCaPath ? readFileSync(sslCaPath, 'utf8') : undefined;
  if (sslMode === 'disable' && sslCa)
    throw new Error('DATABASE_SSL_CA cannot be used when DATABASE_SSL_MODE=disable');

  const defaultPort = isMysql ? 3306 : 5432;
  const port = connectionString
    ? undefined
    : optionalInteger(
        env,
        isMysql ? 'MYSQL_PORT' : 'PGPORT',
        'DATABASE_PORT',
        defaultPort,
        1,
        65_535,
      );
  const user = connectionString
    ? undefined
    : isMysql
      ? (envString(env, 'MYSQL_USER') ?? envString(env, 'DATABASE_USER'))
      : envString(env, 'PGUSER');
  const password = connectionString
    ? undefined
    : isMysql
      ? (envString(env, 'MYSQL_PASSWORD') ?? envString(env, 'DATABASE_PASSWORD'))
      : envString(env, 'PGPASSWORD');

  return {
    dialect,
    // node-postgres lets an sslmode query parameter override an explicit ssl
    // object. Remove the URL parameters when the environment is the source of
    // truth so DATABASE_SSL_MODE / DATABASE_SSL_CA always win.
    connectionString:
      connectionString && sslMode ? stripSslParams(connectionString) : connectionString,
    host: connectionString ? undefined : host,
    port,
    user,
    password,
    database: connectionString ? undefined : database,
    sslMode,
    sslCa,
    ssl: isMysql ? undefined : buildPgSsl(sslMode, sslCa),
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
    // LISTEN/NOTIFY has no MySQL equivalent; a MySQL hub relies on the
    // in-process notification path plus optional Redis fan-out.
    listenEnabled: isMysql ? false : booleanValue(envString(env, 'DB_LISTEN_ENABLED'), true),
  };
}

function detectDialect(
  env: DatabaseEnv,
  connectionString: string | undefined,
): DatabaseDialectName {
  const explicit = envString(env, 'DB_DIALECT')?.toLowerCase();
  if (explicit) {
    if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres';
    if (explicit === 'mysql') return 'mysql';
    throw new Error('DB_DIALECT must be postgres or mysql');
  }
  if (connectionString) {
    if (MYSQL_URL.test(connectionString)) {
      if (!connectableUrl(connectionString))
        throw new Error('DATABASE_URL must be a valid mysql:// URL');
      return 'mysql';
    }
    if (POSTGRES_URL.test(connectionString)) {
      if (!connectableUrl(connectionString))
        throw new Error('DATABASE_URL must be a valid postgres:// URL');
      return 'postgres';
    }
    throw new Error('DATABASE_URL must start with postgres://, postgresql:// or mysql://');
  }
  if (envString(env, 'MYSQL_HOST') || envString(env, 'MYSQL_DATABASE')) return 'mysql';
  return 'postgres';
}

function connectableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * PostgreSQL-shaped settings. Kept until every caller moves to
 * `readDatabaseSettings`; behaviour is unchanged for PostgreSQL hubs.
 */
export function readDatabaseRuntimeConfig(env: DatabaseEnv = process.env): DatabaseRuntimeConfig {
  const settings = readDatabaseSettings({ ...env, DB_DIALECT: 'postgres' });
  return {
    connectionString: settings.connectionString,
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    ssl: settings.ssl,
    applicationName: settings.applicationName,
    max: settings.max,
    maxUses: settings.maxUses,
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    queryTimeoutMillis: settings.queryTimeoutMillis,
    statementTimeoutMillis: settings.statementTimeoutMillis,
    lockTimeoutMillis: settings.lockTimeoutMillis,
    keepAlive: settings.keepAlive,
    keepAliveInitialDelayMillis: settings.keepAliveInitialDelayMillis,
    listenEnabled: settings.listenEnabled,
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
  // libpq "prefer"/"allow" mean opportunistic TLS. Let the driver defaults
  // decide instead of forcing an encrypted-only connection.
  if (normalized === 'prefer' || normalized === 'allow') return undefined;
  if (normalized === 'require' || normalized === 'true' || normalized === 'on') return 'require';
  if (normalized === 'verify-full' || normalized === 'verify-ca') return normalized;
  throw new Error('DATABASE_SSL_MODE must be disable, require, verify-ca or verify-full');
}

function stripSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    for (const key of ['sslmode', 'ssl', 'ssl-mode', 'sslrootcert', 'sslcert', 'sslkey'])
      url.searchParams.delete(key);
    return url.toString();
  } catch {
    return connectionString;
  }
}

function buildPgSsl(
  mode: DatabaseSslMode | undefined,
  ca: string | undefined,
): boolean | ConnectionOptions | undefined {
  if (!mode) {
    // Let the connection string / libpq defaults decide. Do not force TLS off
    // when a URL such as ?sslmode=verify-full is supplied.
    return undefined;
  }
  if (mode === 'disable') return false;
  const ssl: ConnectionOptions = { rejectUnauthorized: true };
  if (mode === 'verify-ca') {
    // verify-ca validates the CA chain but deliberately skips hostname checks.
    ssl.checkServerIdentity = () => undefined;
  }
  if (ca) ssl.ca = ca;
  return ssl;
}
