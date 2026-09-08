import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { DomainError } from '@devtodo/domain';

import { PostgresStore } from '../src/postgres-store.js';
import { MemoryStore } from '../src/store.js';

function fixture() {
  const store = new MemoryStore({ clock: () => new Date('2026-09-04T10:00:00.000Z') });
  const owner = store.createOwner('owner', 'hash');
  return { store, owner };
}

describe('DevTodo store invariants', () => {
  it('publishes PostgreSQL sync notifications with only the channel and JSON payload', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('INSERT INTO sync_changes')) return { rows: [{ seq: '9' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
      end: async () => undefined,
    } as unknown as Pool;
    const store = new PostgresStore(pool);

    await store.withMutation(async () => {
      await (
        store as unknown as {
          appendChange: (
            ownerId: string,
            entityType: 'task',
            entityId: string,
            entityVersion: number,
            operation: 'upsert',
            snapshot: unknown,
          ) => Promise<void>;
        }
      ).appendChange('owner-1', 'task', 'task-1', 1, 'upsert', { id: 'task-1' });
    });

    const notification = queries.find((query) => query.text === 'SELECT pg_notify($1, $2)');
    expect(notification?.values).toHaveLength(2);
    expect(notification?.values[0]).toBe('devtodo_sync_changes');
    expect(JSON.parse(String(notification?.values[1]))).toEqual({
      ownerId: 'owner-1',
      cursor: '9',
    });
  });

  it('maps SQL constraint failures at the transaction boundary and preserves domain errors', async () => {
    const queries: string[] = [];
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text === 'INSERT INTO duplicate_fixture') throw duplicate;
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
      end: async () => undefined,
    } as unknown as Pool;
    const store = new PostgresStore(pool);

    await expect(
      store.withMutation(() =>
        (store as unknown as { query: (text: string) => Promise<unknown> }).query(
          'INSERT INTO duplicate_fixture',
        ),
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_REJECTED' });
    expect(queries).toEqual(['BEGIN', 'INSERT INTO duplicate_fixture', 'ROLLBACK']);

    const domainError = new DomainError('VERSION_CONFLICT', '保留领域错误');
    await expect(store.withMutation(() => Promise.reject(domainError))).rejects.toBe(domainError);
  });

  it('keeps one Task across date and event placements', () => {
    const { store, owner } = fixture();
    const project = store.createProject(owner.id, 'DSH Desktop', 'DSH');
    const task = store.createTask(owner.id, {
      projectId: project.id,
      category: 'FEATURE',
      title: '修复移动端连接',
      priority: 'NONE',
    });
    const today = store.createDate(owner.id, '2026-09-04');
    const tomorrow = store.createDate(owner.id, '2026-09-05');
    const event = store.createEvent(owner.id, 'Codex 额度重置后');
    store.addPlacement(owner.id, task.id, today.id);
    store.addPlacement(owner.id, task.id, tomorrow.id);
    store.addPlacement(owner.id, task.id, event.id);
    expect(store.state.tasks.size).toBe(1);
    expect(store.state.placements.size).toBe(3);
    store.updateTask(owner.id, task.id, { status: 'DONE' }, task.version);
    expect(store.listTasks(owner.id, { timePointId: today.id })[0]?.status).toBe('DONE');
    expect(store.listTasks(owner.id, { timePointId: tomorrow.id })[0]?.status).toBe('DONE');
    expect(store.eventState(event)).toBe('WAITING');
  });

  it('does not duplicate an existing placement and preserves source on copy', () => {
    const { store, owner } = fixture();
    const task = store.createTask(owner.id, {
      projectId: null,
      category: 'MISC',
      title: '整理服务器',
      priority: 'NONE',
    });
    const first = store.createDate(owner.id, '2026-09-04');
    const second = store.createDate(owner.id, '2026-09-05');
    const source = store.addPlacement(owner.id, task.id, first.id);
    expect(store.addPlacement(owner.id, task.id, first.id).existed).toBe(true);
    expect(store.copyPlacement(owner.id, source.placement.id, second.id).existed).toBe(false);
    expect(store.listPlacements(owner.id, first.id)).toHaveLength(1);
    expect(store.listPlacements(owner.id, second.id)).toHaveLength(1);
  });

  it('returns the same result for repeated mutation ids', async () => {
    const { store, owner } = fixture();
    let calls = 0;
    const input = { command: 'task.create', entityId: 'same', payload: { title: 'one' } };
    const first = await store.withMutation(() =>
      store.withIdempotency(owner.id, 'client', 'mutation', input, () => {
        calls += 1;
        return { ok: true, id: 'result' };
      }),
    );
    const second = await store.withMutation(() =>
      store.withIdempotency(owner.id, 'client', 'mutation', input, () => {
        calls += 1;
        return { ok: true, id: 'different' };
      }),
    );
    expect(first.result).toEqual(second.result);
    expect(calls).toBe(1);
    expect(second.replayed).toBe(true);
    expect(() =>
      store.withIdempotency(
        owner.id,
        'client',
        'mutation',
        { ...input, payload: { title: 'changed' } },
        () => null,
      ),
    ).toThrow(DomainError);
  });

  it('expires mutation receipts at the configured retention boundary', async () => {
    let now = new Date('2026-09-04T10:00:00.000Z');
    const store = new MemoryStore({
      clock: () => now,
      mutationReceiptRetentionDays: 1,
    });
    const owner = store.createOwner('owner', 'hash');
    let calls = 0;

    const first = await store.withMutation(() =>
      store.withIdempotency(owner.id, 'client', 'retained', { value: 1 }, () => {
        calls += 1;
        return { value: calls };
      }),
    );
    now = new Date('2026-09-05T10:00:00.000Z');
    const expired = await store.withMutation(() =>
      store.withIdempotency(owner.id, 'client', 'retained', { value: 1 }, () => {
        calls += 1;
        return { value: calls };
      }),
    );

    expect(first).toEqual({ replayed: false, result: { value: 1 } });
    expect(expired).toEqual({ replayed: false, result: { value: 2 } });
    expect(calls).toBe(2);
    expect(store.state.receipts.size).toBe(1);
    expect([...store.state.receipts.values()][0]!.expiresAt).toBe('2026-09-06T10:00:00.000Z');
  });

  it('cleans all expired receipts while retaining newly processed receipts', async () => {
    let now = new Date('2026-09-04T10:00:00.000Z');
    const store = new MemoryStore({
      clock: () => now,
      mutationReceiptRetentionDays: 1,
    });
    const owner = store.createOwner('owner', 'hash');

    for (const mutationId of ['expired-a', 'expired-b']) {
      await store.withMutation(() =>
        store.withIdempotency(owner.id, 'client', mutationId, { mutationId }, () => mutationId),
      );
    }
    now = new Date('2026-09-06T10:00:00.000Z');
    await store.withMutation(() =>
      store.withIdempotency(owner.id, 'client', 'fresh', { mutationId: 'fresh' }, () => 'fresh'),
    );

    expect([...store.state.receipts.keys()]).toEqual([`${owner.id}:client:fresh`]);
  });

  it('does not save a receipt when the action fails', async () => {
    const { store, owner } = fixture();

    await expect(
      store.withMutation(() =>
        store.withIdempotency(owner.id, 'client', 'failed', { value: 1 }, () => {
          throw new Error('action failed');
        }),
      ),
    ).rejects.toThrow('action failed');
    expect(store.state.receipts.size).toBe(0);

    const retried = await store.withMutation(() =>
      store.withIdempotency(owner.id, 'client', 'failed', { value: 1 }, () => 'success'),
    );
    expect(retried).toEqual({ replayed: false, result: 'success' });
  });

  it('rolls unfinished tasks forward idempotently and undoes only its new placements', () => {
    const { store, owner } = fixture();
    const first = store.createTask(owner.id, {
      projectId: null,
      category: 'MISC',
      title: '保留',
      priority: 'NONE',
    });
    const done = store.createTask(owner.id, {
      projectId: null,
      category: 'MISC',
      title: '已完成',
      priority: 'NONE',
    });
    const source = store.createDate(owner.id, '2026-09-04');
    store.addPlacement(owner.id, first.id, source.id);
    store.addPlacement(owner.id, done.id, source.id);
    store.updateTask(owner.id, done.id, { status: 'DONE' }, done.version);
    const operation = store.rollover(owner.id, '2026-09-04');
    expect(operation.createdIds).toHaveLength(1);
    expect(operation.skippedTaskIds).toContain(done.id);
    expect(store.rollover(owner.id, '2026-09-04').createdIds).toHaveLength(0);
    expect(store.undoRollover(owner.id, operation.operationId).removedIds).toHaveLength(1);
  });

  it('rolls back state and change notifications when a mutation fails', async () => {
    const { store, owner } = fixture();
    const notifications: string[] = [];
    store.subscribeChanges((_ownerId, cursor) => notifications.push(cursor));
    const cursorBefore = store.syncStatus(owner.id).cursor;
    await expect(
      store.withMutation(() => {
        store.createProject(owner.id, 'Will Roll Back', 'ROLL');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(store.listProjects(owner.id)).toEqual([]);
    expect(store.syncStatus(owner.id).cursor).toBe(cursorBefore);
    expect(notifications).toEqual([]);
  });

  it('rejects new tasks or placements under archived containers', () => {
    const { store, owner } = fixture();
    const project = store.createProject(owner.id, 'Archived', 'ARC');
    store.archiveProject(owner.id, project.id, project.version);
    expect(() =>
      store.createTask(owner.id, {
        projectId: project.id,
        category: 'FEATURE',
        title: '不可创建',
        priority: 'NONE',
      }),
    ).toThrow(DomainError);

    const task = store.createTask(owner.id, {
      projectId: null,
      category: 'MISC',
      title: '可安排后再归档',
      priority: 'NONE',
    });
    const event = store.createEvent(owner.id, 'Archived event');
    store.archiveTimePoint(owner.id, event.id, event.version);
    expect(() => store.addPlacement(owner.id, task.id, event.id)).toThrow(DomainError);
  });
});
