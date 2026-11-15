import mysql from 'mysql2/promise';
import pg from 'pg';
import {
  poolConfigFromRuntime,
  type DatabaseRuntimeConfig,
  type DatabaseSettings,
} from './config.js';
import { normaliseMysqlValues, prepareQuery, type DatabaseDialectName } from './dialect.js';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
  /** MySQL only: auto-increment value of the first inserted row. */
  insertId?: string;
}

export interface SessionOptions {
  /** Runs under REPEATABLE READ with writes rejected, for read-only snapshots. */
  readOnly?: boolean;
}

export interface ListenOptions {
  onPayload(payload: string): void;
  /** The listener connection died; the caller owns reconnecting. */
  onFailure(error: Error): void;
}

export interface SqlSession {
  readonly dialect: DatabaseDialectName;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  begin(options?: SessionOptions): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(error?: Error): void;
  /** PostgreSQL LISTEN; absent on MySQL, which has no pub/sub primitive. */
  listen?(channel: string, options: ListenOptions): Promise<void>;
  unlisten?(channel: string): Promise<void>;
}

export interface SqlDatabase {
  readonly dialect: DatabaseDialectName;
  readonly settings: DatabaseSettings;
  readonly maxConnections: number;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  session(): Promise<SqlSession>;
  warm(count: number): Promise<void>;
  onConnectionError(handler: (error: Error) => void): void;
  end(): Promise<void>;
}

const CHANNEL = /^[a-z_][a-z0-9_]*$/;

export function openDatabase(settings: DatabaseSettings): SqlDatabase {
  return settings.dialect === 'mysql'
    ? new MysqlDatabase(settings)
    : new PostgresDatabase(settings);
}

/**
 * Wrap an already-created node-postgres pool. Used by tests and by scripts that
 * build their own pool; application startup goes through `openDatabase`.
 */
export function databaseFromPool(pool: pg.Pool): SqlDatabase {
  return new PostgresDatabase(poolSettings(pool), pool);
}

function poolSettings(pool: pg.Pool): DatabaseSettings {
  const options = (pool.options ?? {}) as pg.PoolOptions;
  return {
    dialect: 'postgres',
    connectionString: options.connectionString,
    host: typeof options.host === 'string' ? options.host : undefined,
    port: options.port,
    user: typeof options.user === 'string' ? options.user : undefined,
    password: typeof options.password === 'string' ? options.password : undefined,
    database: options.database,
    applicationName:
      typeof options.application_name === 'string' ? options.application_name : 'devtodo-api',
    max: options.max ?? 10,
    maxUses: options.maxUses ?? 1_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    queryTimeoutMillis: (options.query_timeout as number | undefined) ?? 30_000,
    statementTimeoutMillis: (options.statement_timeout as number | undefined) ?? 30_000,
    lockTimeoutMillis: (options.lock_timeout as number | undefined) ?? 5_000,
    keepAlive: options.keepAlive ?? true,
    keepAliveInitialDelayMillis: options.keepAliveInitialDelayMillis ?? 10_000,
    listenEnabled: true,
  };
}

class PostgresDatabase implements SqlDatabase {
  readonly dialect = 'postgres' as const;
  readonly maxConnections: number;
  private readonly pool: pg.Pool;

  constructor(
    readonly settings: DatabaseSettings,
    pool?: pg.Pool,
  ) {
    this.maxConnections = settings.max;
    this.pool = pool ?? new pg.Pool(poolConfigFromRuntime(runtimeConfig(settings)));
  }

  async query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const prepared = prepareQuery('postgres', text, values);
    const result = await this.pool.query(prepared.text, prepared.values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  async session(): Promise<SqlSession> {
    const client = await this.pool.connect();
    return {
      dialect: 'postgres',
      async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
        const prepared = prepareQuery('postgres', text, values);
        const result = await client.query(prepared.text, prepared.values);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      },
      async begin(options: SessionOptions = {}) {
        await client.query(
          options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
        );
      },
      async commit() {
        await client.query('COMMIT');
      },
      async rollback() {
        await client.query('ROLLBACK');
      },
      release(error?: Error) {
        client.release(error);
      },
      async listen(channel: string, options: ListenOptions) {
        if (!CHANNEL.test(channel)) throw new Error(`Invalid listen channel: ${channel}`);
        client.on('notification', (message: pg.Notification) => {
          if (message.channel === channel && message.payload !== undefined)
            options.onPayload(message.payload);
        });
        client.on('error', (error: Error) => options.onFailure(error));
        client.on('end', () => options.onFailure(new Error('listener connection ended')));
        await client.query(`LISTEN ${channel}`);
      },
      async unlisten(channel: string) {
        if (!CHANNEL.test(channel)) return;
        await client.query(`UNLISTEN ${channel}`);
      },
    };
  }

  async warm(count: number): Promise<void> {
    const warm = Math.max(0, Math.min(Math.trunc(count), this.settings.max));
    if (!warm) return;
    const clients = await Promise.all(Array.from({ length: warm }, () => this.pool.connect()));
    for (const client of clients) client.release();
  }

  onConnectionError(handler: (error: Error) => void): void {
    this.pool.on('error', handler);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

class MysqlDatabase implements SqlDatabase {
  readonly dialect = 'mysql' as const;
  readonly maxConnections: number;
  private readonly pool: mysql.Pool;

  constructor(readonly settings: DatabaseSettings) {
    this.maxConnections = settings.max;
    this.pool = mysql.createPool(this.poolOptions());
  }

  private poolOptions(): mysql.PoolOptions {
    const base: mysql.PoolOptions = this.settings.connectionString
      ? { uri: this.settings.connectionString }
      : {
          host: this.settings.host,
          port: this.settings.port,
          user: this.settings.user,
          password: this.settings.password,
          database: this.settings.database,
        };
    const ssl = this.sslOptions();
    return {
      ...base,
      waitForConnections: true,
      connectionLimit: this.settings.max,
      maxIdle: this.settings.max,
      idleTimeout: this.settings.idleTimeoutMillis,
      connectTimeout: this.settings.connectionTimeoutMillis,
      queueLimit: 0,
      enableKeepAlive: this.settings.keepAlive,
      keepAliveInitialDelay: this.settings.keepAliveInitialDelayMillis,
      // DATETIME is stored as UTC and read back as Date, matching node-postgres
      // timestamptz behaviour. BIGINT becomes a string only when a number would
      // lose precision, so small ranks stay numbers and large sequences stay exact.
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: false,
      namedPlaceholders: false,
      ...(ssl ? { ssl } : {}),
    };
  }

  private sslOptions(): mysql.SslOptions | undefined {
    const { sslMode, sslCa } = this.settings;
    if (!sslMode || sslMode === 'disable') return undefined;
    const ssl: mysql.SslOptions = { rejectUnauthorized: sslMode !== 'require' };
    if (sslCa) ssl.ca = sslCa;
    if (sslMode === 'verify-ca')
      (ssl as { checkServerIdentity?: () => undefined }).checkServerIdentity = () => undefined;
    return ssl;
  }

  async query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const prepared = prepareQuery('mysql', text, values);
    const [result] = await this.pool.query(prepared.text, normaliseMysqlValues(prepared.values));
    return mysqlResult<T>(result);
  }

  async session(): Promise<SqlSession> {
    const connection = await this.pool.getConnection();
    await applyMysqlSessionSettings(connection, this.settings);
    return {
      dialect: 'mysql',
      async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
        const prepared = prepareQuery('mysql', text, values);
        const [result] = await connection.query(
          prepared.text,
          normaliseMysqlValues(prepared.values),
        );
        return mysqlResult<T>(result);
      },
      async begin(options: SessionOptions = {}) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query(
          options.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION',
        );
      },
      async commit() {
        await connection.commit();
      },
      async rollback() {
        await connection.rollback();
      },
      release(error?: Error) {
        // A failed transaction can leave the socket in an unknown state.
        if (error) connection.destroy();
        else connection.release();
      },
    };
  }

  async warm(count: number): Promise<void> {
    const warm = Math.max(0, Math.min(Math.trunc(count), this.settings.max));
    if (!warm) return;
    const connections = await Promise.all(
      Array.from({ length: warm }, () => this.pool.getConnection()),
    );
    for (const connection of connections) {
      await applyMysqlSessionSettings(connection, this.settings);
      connection.release();
    }
  }

  onConnectionError(): void {
    // mysql2 surfaces a dead socket as a query error on the next use; there is
    // no pool-level 'error' event to subscribe to, unlike node-postgres.
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function runtimeConfig(settings: DatabaseSettings): DatabaseRuntimeConfig {
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

async function applyMysqlSessionSettings(
  connection: mysql.PoolConnection,
  settings: DatabaseSettings,
): Promise<void> {
  const lockSeconds = Math.max(1, Math.ceil(settings.lockTimeoutMillis / 1_000));
  await connection.query("SET SESSION time_zone = '+00:00'");
  await connection.query(`SET SESSION innodb_lock_wait_timeout = ${lockSeconds}`);
  // Only SELECT statements honour max_execution_time; writes are bounded by
  // innodb_lock_wait_timeout plus the driver-level connect and queue timeouts.
  await connection.query(`SET SESSION max_execution_time = ${settings.queryTimeoutMillis}`);
}

function mysqlResult<T>(result: unknown): QueryResult<T> {
  if (Array.isArray(result)) return { rows: result as T[], rowCount: result.length };
  const header = result as { affectedRows?: number; insertId?: number };
  return {
    rows: [],
    rowCount: header.affectedRows ?? 0,
    insertId: header.insertId === undefined ? undefined : String(header.insertId),
  };
}
