import { readFileSync } from 'node:fs';
import { createClient, type RedisClientType } from 'redis';

export interface CacheStore {
  readonly enabled: boolean;
  readonly keyPrefix: string;
  readonly snapshotTtlSeconds: number;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string, ttlMs: number): Promise<number | null>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

class NoopCache implements CacheStore {
  readonly enabled = false;
  readonly keyPrefix = 'taskdock';
  readonly snapshotTtlSeconds = 0;
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {}
  async del(): Promise<void> {}
  async incr(): Promise<number | null> {
    return null;
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

/**
 * Optional Redis adapter. It is deliberately fail-open: a cache outage must
 * never turn a writable hub into a read-only or unavailable hub, and Redis is
 * never the authority for entities, receipts or sync cursors.
 */
class RedisCache implements CacheStore {
  readonly enabled = true;
  private healthy = true;
  private lastErrorLog = 0;
  constructor(
    private readonly client: RedisClientType,
    readonly keyPrefix: string,
    readonly snapshotTtlSeconds: number,
  ) {}

  private key(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  private async guard<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const value = await operation();
      this.healthy = true;
      return value;
    } catch (error) {
      this.healthy = false;
      const now = Date.now();
      if (now - this.lastErrorLog > 30_000) {
        this.lastErrorLog = now;
        console.warn(
          JSON.stringify({
            event: 'cache.error',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return fallback;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.guard(() => this.client.get(this.key(key)), null);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.guard(
      () => this.client.set(this.key(key), value, { EX: Math.max(1, ttlSeconds) }),
      undefined,
    );
  }

  async del(key: string): Promise<void> {
    await this.guard(() => this.client.del(this.key(key)), 0);
  }

  async incr(key: string, ttlMs: number): Promise<number | null> {
    const script = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
      return current`;
    const result = await this.guard(
      () =>
        this.client.eval(script, {
          keys: [this.key(key)],
          arguments: [String(Math.max(1, ttlMs))],
        }),
      null,
    );
    return result === null ? null : Number(result);
  }

  async ping(): Promise<boolean> {
    return this.guard(async () => {
      await this.client.ping();
      return true;
    }, false);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }
}

export interface CacheRuntimeConfig {
  url?: string;
  keyPrefix: string;
  snapshotTtlSeconds: number;
  required: boolean;
  tlsCa?: string;
}

export function readCacheRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): CacheRuntimeConfig {
  const url = env['CACHE_URL']?.trim() || env['REDIS_URL']?.trim();
  const required = env['CACHE_REQUIRED'] === 'true';
  const snapshotTtlSeconds = Number(env['CACHE_SNAPSHOT_TTL_SECONDS'] ?? 60);
  if (!Number.isInteger(snapshotTtlSeconds) || snapshotTtlSeconds < 0 || snapshotTtlSeconds > 3_600)
    throw new Error('CACHE_SNAPSHOT_TTL_SECONDS must be an integer between 0 and 3600');
  return {
    url,
    keyPrefix: env['CACHE_KEY_PREFIX']?.trim() || 'taskdock',
    snapshotTtlSeconds,
    required,
    tlsCa: env['CACHE_TLS_CA']?.trim() || undefined,
  };
}

export async function createCacheFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<CacheStore> {
  const config = readCacheRuntimeConfig(env);
  if (!config.url) {
    if (config.required) throw new Error('CACHE_REQUIRED=true but CACHE_URL is not configured');
    return new NoopCache();
  }
  let client: RedisClientType | undefined;
  try {
    client = createClient({
      url: config.url,
      // Do not queue commands while the cache is reconnecting: a cache outage
      // must fail fast and let the caller fall back to the database.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 3_000,
        reconnectStrategy: (retries) => (retries > 5 ? false : Math.min(1_000, retries * 100)),
        ...(config.tlsCa ? { tls: true, ca: readFileSync(config.tlsCa, 'utf8') } : {}),
      },
    });
    client.on('error', () => {
      /* Individual operations fail open; reconnect is handled by redis. */
    });
    await client.connect();
    return new RedisCache(client, config.keyPrefix, config.snapshotTtlSeconds);
  } catch (error) {
    try {
      client?.destroy();
    } catch {
      /* The client may have failed before opening a socket. */
    }
    if (config.required) throw error;
    console.warn(
      JSON.stringify({
        event: 'cache.unavailable',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new NoopCache();
  }
}
