import 'fake-indexeddb/auto';

import { uuidv7 } from '@devtodo/contracts';
import { DevTodoDatabase } from '@devtodo/sync-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../src/api.js';
import { activateLocalCache, applyOfflineWrite, deactivateLocalCache } from '../src/local.js';

/**
 * Permanent tree deletion is online-only because it needs a server-signed
 * preview token. These tests pin the fail-closed contract: while offline the
 * user must receive actionable retry-online guidance, never a generic network
 * failure. Regression for the delete-preview path that previously fell through
 * to `undefined` and surfaced a TypeError.
 */
const origin = 'https://offline.example.test';
const ownerId = '00000000-0000-7000-8000-0000000000aa';
const clientId = '00000000-0000-7000-8000-0000000000bb';

function headers(): Headers {
  return new Headers({ 'Idempotency-Key': uuidv7(), 'X-Client-Id': clientId });
}

async function offlineWrite(path: string, method: string): Promise<void> {
  await applyOfflineWrite(path, method, { method, body: '{}' }, headers());
}

describe('offline folder tree deletion', () => {
  let db: DevTodoDatabase;

  beforeEach(async () => {
    db = new DevTodoDatabase(origin, ownerId);
    await db.open();
    activateLocalCache(db, clientId);
  });

  it('refuses a delete preview with structured retry-online guidance', async () => {
    const folderId = uuidv7();
    const failure = await offlineWrite(`/v2/folders/${folderId}/delete-preview`, 'POST').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.code).toBe('OFFLINE_TREE_DELETE_FORBIDDEN');
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ suggestion: 'RETRY_ONLINE' });
    expect(error.message).toContain('恢复网络');

    deactivateLocalCache();
  });

  it('still refuses the irreversible tree delete itself', async () => {
    const folderId = uuidv7();
    const failure = await offlineWrite(`/v2/folders/${folderId}/tree`, 'DELETE').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('OFFLINE_TREE_DELETE_FORBIDDEN');

    deactivateLocalCache();
  });
});
