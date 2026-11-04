import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PostgresStore } from '../src/postgres-store.js';

describe('PostgresStore v2 read/write batching', () => {
  it('reads a pull page, retention boundary and has-more flag in one statement', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return {
          rows: [
            {
              owner_ok: true,
              oldest: '1',
              has_more: true,
              changes: [
                {
                  seq: '2',
                  owner_id: 'owner-1',
                  entity_type: 'task',
                  entity_id: '00000000-0000-7000-8000-000000000001',
                  entity_version: 1,
                  operation: 'upsert',
                  snapshot: { id: '00000000-0000-7000-8000-000000000001' },
                  committed_at: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          ],
          rowCount: 1,
        };
      },
      end: async () => undefined,
    } as unknown as Pool;
    const store = new PostgresStore(pool);
    const result = await store.syncPullV2('owner-1', '0', 100);
    expect(queries).toHaveLength(1);
    expect(result.nextCursor).toBe('2');
    expect(result.hasMore).toBe(true);
    expect(result.changes[0]?.seq).toBe(2n);
  });

  it('reads v2 status in one statement', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [{ owner_ok: true, cursor: '5', oldest: '2' }], rowCount: 1 };
      },
      end: async () => undefined,
    } as unknown as Pool;
    const store = new PostgresStore(pool);
    await expect(store.syncStatusV2('owner-1')).resolves.toEqual({
      cursor: '5',
      oldestCursor: '1',
      protocolVersion: 2,
    });
    expect(queries).toHaveLength(1);
  });

  it('writes a multi-row change batch in one statement', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return { rows: [{ seq: '7' }, { seq: '8' }], rowCount: 2 };
      },
      end: async () => undefined,
    } as unknown as Pool;
    const store = new PostgresStore(pool);
    const cursor = await store.appendV2Changes('00000000-0000-7000-8000-0000000000aa', [
      {
        entityType: 'task',
        entityId: '00000000-0000-7000-8000-000000000001',
        entityVersion: 1,
        operation: 'upsert',
        snapshot: { id: '00000000-0000-7000-8000-000000000001' },
        committedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        entityType: 'note',
        entityId: '00000000-0000-7000-8000-000000000002',
        entityVersion: 1,
        operation: 'upsert',
        snapshot: { id: '00000000-0000-7000-8000-000000000002' },
        committedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(cursor).toBe('8');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('jsonb_to_recordset');
  });
});
