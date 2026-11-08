import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { CacheStore } from '../src/cache.js';
import { AuthRateLimiter, parseTrustProxy } from '../src/server.js';

const request = { ip: '127.0.0.1' } as FastifyRequest;

describe('AuthRateLimiter resource bounds', () => {
  it('fails closed instead of growing beyond the live local bucket bound', async () => {
    const limiter = new AuthRateLimiter();
    for (let index = 0; index < 10_000; index += 1)
      await limiter.check(request, 'login', `user-${index}`, 100_000, 60_000);
    await expect(
      limiter.check(request, 'login', 'one-key-too-many', 100_000, 60_000),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Existing identities remain governed by their own bucket at saturation.
    await expect(
      limiter.check(request, 'login', 'user-1', 100_000, 60_000),
    ).resolves.toBeUndefined();
  });

  it('does not multiply production limits across replicas during a Redis outage', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const unavailable = { enabled: true, incr: async () => null } as unknown as CacheStore;
      const limiter = new AuthRateLimiter(unavailable);
      await expect(limiter.check(request, 'login', 'owner', 5, 60_000)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('honours the shared-limiter requirement outside production', async () => {
    const previousNodeEnv = process.env['NODE_ENV'];
    const previousRequirement = process.env['AUTH_RATE_LIMIT_REQUIRE_SHARED'];
    process.env['NODE_ENV'] = 'test';
    process.env['AUTH_RATE_LIMIT_REQUIRE_SHARED'] = 'true';
    try {
      const unavailable = { enabled: true, incr: async () => null } as unknown as CacheStore;
      const limiter = new AuthRateLimiter(unavailable);
      await expect(limiter.check(request, 'login', 'owner', 5, 60_000)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
      if (previousRequirement === undefined) delete process.env['AUTH_RATE_LIMIT_REQUIRE_SHARED'];
      else process.env['AUTH_RATE_LIMIT_REQUIRE_SHARED'] = previousRequirement;
    }
  });
});

describe('proxy trust configuration', () => {
  it('rejects blanket trust and accepts only bounded trust', () => {
    expect(() => parseTrustProxy('true')).toThrow(/trusts every proxy/);
    expect(() => parseTrustProxy('*')).toThrow(/explicit address list/);
    expect(parseTrustProxy('0')).toBe(false);
    const oneHop = parseTrustProxy('1') as (address: string, hop: number) => boolean;
    expect(oneHop('127.0.0.1', 0)).toBe(true);
    expect(oneHop('127.0.0.1', 1)).toBe(false);
    expect(parseTrustProxy('127.0.0.1,10.0.0.1')).toEqual(['127.0.0.1', '10.0.0.1']);
  });
});
