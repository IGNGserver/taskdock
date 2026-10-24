import { describe, expect, it } from 'vitest';
import { budgetSyncPull } from '../src/sync-byte-budget.js';

describe('incremental response byte budget', () => {
  it('uses UTF-8 bytes and preserves a contiguous prefix and its cursor', () => {
    const changes = [1, 2, 3].map((seq) => ({ seq: String(seq), snapshot: '待办'.repeat(80) }));
    const first = budgetSyncPull({ changes, nextCursor: '3', hasMore: false }, 700);
    expect(first.changes).toEqual(changes.slice(0, 1));
    expect(first.nextCursor).toBe('1');
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(700);
    const tail = budgetSyncPull(
      { changes: changes.slice(1), nextCursor: '3', hasMore: false },
      10_000,
    );
    expect(tail.changes).toEqual(changes.slice(1));
    expect(tail.nextCursor).toBe('3');
    expect(tail.hasMore).toBe(false);
  });

  it('allows one oversized record to make progress without dropping the next one', () => {
    const changes = [
      { seq: '8', snapshot: 'x'.repeat(2000) },
      { seq: '9', snapshot: 'next' },
    ];
    expect(budgetSyncPull({ changes, nextCursor: '9', hasMore: false }, 1000)).toMatchObject({
      changes: [changes[0]],
      nextCursor: '8',
      hasMore: true,
    });
  });

  it('keeps upstream continuation and the cursor of an empty response', () => {
    expect(budgetSyncPull({ changes: [], nextCursor: '42', hasMore: false }, 1000)).toEqual({
      changes: [],
      nextCursor: '42',
      hasMore: false,
      protocolVersion: 2,
    });
    expect(
      budgetSyncPull({ changes: [{ seq: '9' }], nextCursor: '9', hasMore: true }, 1000).hasMore,
    ).toBe(true);
  });
});
