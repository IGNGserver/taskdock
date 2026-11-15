import pg from 'pg';

export * from './config.js';
export * from './dialect.js';
export * from './migrate.js';
export * from './pool.js';
export * from './schema.js';

export type { Pool } from 'pg';

export interface PoolTimeoutOptions {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  queryTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
  max?: number;
  maxUses?: number;
  applicationName?: string;
  ssl?: pg.PoolConfig['ssl'];
  keepAlive?: boolean;
  keepAliveInitialDelayMillis?: number;
}

/**
 * Legacy PostgreSQL pool factory. Retained for scripts that speak `pg`
 * directly; application code goes through `openDatabase`.
 */
export function createPool(
  connectionString: string | pg.PoolConfig,
  options: PoolTimeoutOptions = {},
): pg.Pool {
  const statementTimeoutMillis = options.statementTimeoutMillis ?? 30_000;
  const base: pg.PoolConfig =
    typeof connectionString === 'string' ? { connectionString } : { ...connectionString };
  return new pg.Pool({
    ...base,
    max: options.max ?? base.max ?? 10,
    maxUses: options.maxUses ?? base.maxUses ?? 1000,
    application_name: options.applicationName ?? base.application_name ?? 'devtodo-api',
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ?? base.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? base.idleTimeoutMillis ?? 30_000,
    query_timeout: options.queryTimeoutMillis ?? base.query_timeout ?? statementTimeoutMillis,
    statement_timeout:
      options.statementTimeoutMillis ?? base.statement_timeout ?? statementTimeoutMillis,
    lock_timeout: options.lockTimeoutMillis ?? base.lock_timeout ?? 5_000,
    ssl: options.ssl ?? base.ssl,
    keepAlive: options.keepAlive ?? base.keepAlive ?? true,
    keepAliveInitialDelayMillis:
      options.keepAliveInitialDelayMillis ?? base.keepAliveInitialDelayMillis ?? 10_000,
  });
}

/** Open `count` connections once so the first request does not pay TCP/TLS setup. */
export async function warmPool(pool: pg.Pool, count: number): Promise<void> {
  const warm = Math.max(0, Math.min(Math.trunc(count), pool.options.max ?? 0));
  if (!warm) return;
  const clients = await Promise.all(Array.from({ length: warm }, () => pool.connect()));
  for (const client of clients) client.release();
}
