import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestV1, requestV2 } from '../src/api.js';

describe('API version routing', () => {
  const paths: string[] = [];

  beforeEach(() => {
    paths.length = 0;
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://hub.test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        paths.push(new URL(url).pathname);
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps auth and legacy operations on v1 and sync on v2', async () => {
    await requestV1('/bootstrap/status');
    await requestV1('/auth/login', { method: 'POST', body: '{}' });
    await requestV1('/auth/refresh', { method: 'POST', body: '{}' }, false);
    await requestV1('/auth/logout', { method: 'POST', body: '{}' });
    await requestV1('/me');
    await requestV1('/rollovers/operation-1/undo', { method: 'POST', body: '{}' });

    await requestV2('/sync/snapshot');
    await requestV2('/sync/pull?cursor=0&limit=50');
    await requestV2('/sync/push', { method: 'POST', body: '{}' });

    expect(paths).toEqual([
      '/api/v1/bootstrap/status',
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      '/api/v1/me',
      '/api/v1/rollovers/operation-1/undo',
      '/api/v2/sync/snapshot',
      '/api/v2/sync/pull',
      '/api/v2/sync/push',
    ]);
  });
});
