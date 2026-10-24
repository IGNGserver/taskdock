/** Return a contiguous prefix. Never skip an oversized entity or advance past it. */
export function budgetSyncPull<T extends { seq: string }>(
  result: { changes: T[]; nextCursor: string; hasMore: boolean },
  maxBytes: number,
): { changes: T[]; nextCursor: string; hasMore: boolean; protocolVersion: 2 } {
  const changes: T[] = [];
  // Reserve the envelope, including a cursor as long as the upstream cursor.
  let bytes = Buffer.byteLength(
    JSON.stringify({
      changes: [],
      nextCursor: result.nextCursor,
      hasMore: false,
      protocolVersion: 2,
    }),
  );
  for (const change of result.changes) {
    const size = Buffer.byteLength(JSON.stringify(change)) + (changes.length ? 1 : 0);
    // A single large record gets its own page; otherwise clients could never progress.
    if (changes.length && bytes + size > maxBytes) break;
    changes.push(change);
    bytes += size;
  }
  return {
    changes,
    nextCursor: changes.at(-1)?.seq ?? result.nextCursor,
    hasMore: result.hasMore || changes.length < result.changes.length,
    protocolVersion: 2,
  };
}
