import type { V2Mutation } from '@devtodo/contracts';
import { describe, expect, it } from 'vitest';
import type { PostgresStore } from '../src/postgres-store.js';
import { PostgresTreeStore } from '../src/postgres-tree-store.js';

function mutation(
  mutationId: string,
  command: string,
  entityId: string,
  baseVersion: number | null,
  payload: Record<string, unknown>,
): V2Mutation {
  return {
    mutationId,
    command: command as V2Mutation['command'],
    entityId,
    baseVersion,
    occurredAt: new Date().toISOString(),
    payload,
  } as V2Mutation;
}

function emptyOwnerRow(cursor: string) {
  return {
    next_task_number: 1,
    cursor,
    folders: [],
    tasks: [],
    notes: [],
    steps: [],
    workflows: [],
    stages: [],
    memberships: [],
    time_points: [],
    placements: [],
    settings: null,
  };
}

describe('PostgresTreeStore batch push', () => {
  it('does not expose a mutation to readers before the transaction commits', async () => {
    let gate: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (gate = resolve));
    const postgres = {
      withMutation: async <T>(fn: () => T | Promise<T>): Promise<T> => {
        const result = await fn();
        await blocked;
        return result;
      },
      withIdempotency: async <T>(
        _ownerId: string,
        _clientId: string,
        _mutationId: string,
        _input: unknown,
        action: () => T | Promise<T>,
      ) => ({ replayed: false, result: await action() }),
      v2LockOwner: async () => undefined,
      v2ReadSnapshot: async <T>(fn: () => T | Promise<T>) => fn(),
      v2Query: async (text: string) => {
        if (text.includes('AS owner_ok')) {
          return { rows: [{ owner_ok: true, cursor: '0' }], rowCount: 1 };
        }
        if (text.includes('AS next_task_number')) {
          return { rows: [emptyOwnerRow('0')], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      appendV2Changes: async () => '1',
      subscribeChanges: () => () => undefined,
    } as unknown as PostgresStore;
    const tree = new PostgresTreeStore(postgres);
    const pending = tree.applyMutationIdempotent('owner-1', 'client-1', {
      mutationId: '00000000-0000-7000-8000-000000000021',
      command: 'folder.create',
      entityId: '00000000-0000-7000-8000-000000000022',
      baseVersion: null,
      occurredAt: new Date().toISOString(),
      payload: { title: 'Not yet visible', parentFolderId: null },
    } as V2Mutation);
    // Let the transaction reach the commit gate, then read the live projection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tree.listFolders('owner-1')).toHaveLength(0);
    gate?.();
    await pending;
    expect(tree.listFolders('owner-1').map((folder) => folder.title)).toEqual(['Not yet visible']);
  });

  it('applies a delta snapshot without ownerId to the owner-scoped projection', async () => {
    let cursor = '0';
    let delta: Array<Record<string, unknown>> = [];
    const postgres = {
      v2Query: async (text: string) => {
        if (text.includes('AS owner_ok')) {
          return { rows: [{ owner_ok: true, cursor }], rowCount: 1 };
        }
        if (text.includes('AS next_task_number')) {
          return { rows: [emptyOwnerRow(cursor)], rowCount: 1 };
        }
        if (text.includes('FROM sync_changes') && text.includes('LIMIT 201')) {
          return { rows: delta, rowCount: delta.length };
        }
        return { rows: [], rowCount: 0 };
      },
      v2ReadSnapshot: async <T>(fn: () => T | Promise<T>) => fn(),
    } as unknown as PostgresStore;
    const tree = new PostgresTreeStore(postgres);
    await tree.prepare('owner-1');
    expect(tree.listFolders('owner-1')).toHaveLength(0);

    cursor = '1';
    delta = [
      {
        seq: '1',
        protocol_version: 2,
        entity_type: 'folder',
        operation: 'upsert',
        snapshot: {
          id: '00000000-0000-7000-8000-000000000001',
          parentFolderId: null,
          title: 'Delta folder',
          status: 'TODO',
          completedAt: null,
          rank: '1024',
          version: 1,
          deletedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ];
    await tree.prepare('owner-1');
    expect(tree.listFolders('owner-1').map((folder) => folder.title)).toEqual(['Delta folder']);
  });

  it('hydrates a cold projection from Redis when the cursor matches', async () => {
    const cache = {
      enabled: true,
      keyPrefix: 'test',
      snapshotTtlSeconds: 60,
      get: async () =>
        JSON.stringify({
          cursor: '5',
          state: {
            folders: [
              {
                id: '00000000-0000-7000-8000-000000000001',
                ownerId: 'owner-1',
                parentFolderId: null,
                title: 'Cached folder',
                status: 'TODO',
                completedAt: null,
                rank: '1024',
                version: 1,
                deletedAt: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            tasks: [],
            notes: [],
            steps: [],
            workflows: [],
            stages: [],
            memberships: [],
            timePoints: [],
            placements: [],
            settings: {
              ownerId: 'owner-1',
              timezone: 'Asia/Shanghai',
              weekStartsOn: 1,
              defaultCaptureTarget: 'ROOT',
              version: 1,
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            nextTaskNumber: 1,
          },
        }),
      set: async () => undefined,
      del: async () => undefined,
      incr: async () => null,
      ping: async () => true,
      close: async () => undefined,
    };
    let fullLoadQueries = 0;
    const postgres = {
      v2Query: async (text: string) => {
        if (text.includes('AS owner_ok')) {
          return { rows: [{ owner_ok: true, cursor: '5' }], rowCount: 1 };
        }
        fullLoadQueries += 1;
        return { rows: [], rowCount: 0 };
      },
      v2ReadSnapshot: async <T>(fn: () => T | Promise<T>) => fn(),
    } as unknown as PostgresStore;
    const tree = new PostgresTreeStore(postgres, cache);
    await tree.prepare('owner-1');
    expect(fullLoadQueries).toBe(0);
    expect(tree.listFolders('owner-1').map((folder) => folder.title)).toEqual(['Cached folder']);
  });

  it('uses one transaction and per-mutation savepoints for a push batch', async () => {
    let cursor = '0';
    let inTransaction = false;
    const transactions: string[] = [];
    const savepoints: string[] = [];
    const postgres = {
      withMutation: async <T>(fn: () => T | Promise<T>): Promise<T> => {
        if (inTransaction) return fn();
        inTransaction = true;
        transactions.push('begin');
        try {
          const result = await fn();
          transactions.push('commit');
          return result;
        } catch (error) {
          transactions.push('rollback');
          throw error;
        } finally {
          inTransaction = false;
        }
      },
      withIdempotency: async <T>(
        _ownerId: string,
        _clientId: string,
        _mutationId: string,
        _input: unknown,
        action: () => T | Promise<T>,
      ) => ({ replayed: false, result: await action() }),
      v2LockOwner: async () => undefined,
      v2ReadSnapshot: async <T>(fn: () => T | Promise<T>) => fn(),
      v2Query: async (text: string) => {
        if (text.includes('AS owner_ok')) {
          return { rows: [{ owner_ok: true, cursor }], rowCount: 1 };
        }
        if (text.includes('AS next_task_number')) {
          return { rows: [emptyOwnerRow(cursor)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      appendV2Changes: async () => {
        cursor = String(Number(cursor) + 1);
        return cursor;
      },
      createSavepoint: async (name: string) => {
        savepoints.push(`create:${name}`);
      },
      releaseSavepoint: async (name: string) => {
        savepoints.push(`release:${name}`);
      },
      rollbackToSavepoint: async (name: string) => {
        savepoints.push(`rollback:${name}`);
      },
      subscribeChanges: () => () => undefined,
    } as unknown as PostgresStore;

    const tree = new PostgresTreeStore(postgres);
    const folderId = '00000000-0000-7000-8000-000000000001';
    const results = await tree.applyMutationBatch('owner-1', 'client-1', [
      mutation('00000000-0000-7000-8000-000000000011', 'folder.create', folderId, null, {
        title: 'Batch folder',
        parentFolderId: null,
      }),
      mutation('00000000-0000-7000-8000-000000000012', 'folder.update', folderId, 999, {
        title: 'Conflict',
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['applied', 'conflict']);
    expect(transactions).toEqual(['begin', 'commit']);
    expect(savepoints).toContain('create:mutation_0');
    expect(savepoints).toContain('release:mutation_0');
    expect(savepoints).toContain('create:mutation_1');
    expect(savepoints).toContain('rollback:mutation_1');
  });
});
