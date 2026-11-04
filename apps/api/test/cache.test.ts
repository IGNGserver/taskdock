import { describe, expect, it } from 'vitest';
import { createCacheFromEnv, readCacheRuntimeConfig } from '../src/cache.js';

describe('optional cache configuration', () => {
  it('is disabled without CACHE_URL and remains fail-open', async () => {
    const cache = await createCacheFromEnv({});
    expect(cache.enabled).toBe(false);
    expect(await cache.get('anything')).toBeNull();
    expect(await cache.ping()).toBe(true);
    await cache.close();
  });

  it('reads Redis settings and TTL bounds', () => {
    const config = readCacheRuntimeConfig({
      CACHE_URL: 'redis://cache.example.lan:6379/0',
      CACHE_KEY_PREFIX: 'taskdock-home',
      CACHE_SNAPSHOT_TTL_SECONDS: '30',
      CACHE_REQUIRED: 'true',
    });
    expect(config.url).toBe('redis://cache.example.lan:6379/0');
    expect(config.keyPrefix).toBe('taskdock-home');
    expect(config.snapshotTtlSeconds).toBe(30);
    expect(config.required).toBe(true);
    expect(() => readCacheRuntimeConfig({ CACHE_SNAPSHOT_TTL_SECONDS: '-1' })).toThrow(
      /CACHE_SNAPSHOT_TTL_SECONDS/,
    );
  });

  it('refuses CACHE_REQUIRED without a URL instead of silently disabling', async () => {
    await expect(createCacheFromEnv({ CACHE_REQUIRED: 'true' })).rejects.toThrow(/CACHE_REQUIRED/);
  });
});
