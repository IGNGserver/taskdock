import { z } from 'zod';
import type { TreeItemDto } from './index.js';

export interface DirectoryPage {
  items: TreeItemDto[];
  parentFolderId: string | null;
  nextCursor: string | null;
  /** Client-only: exact cached membership, not complete account coverage. */
  cached?: true;
}
const cursorSchema = z
  .object({
    owner: z.string().uuid(),
    parent: z.string().uuid().nullable(),
    revision: z.string().min(1).max(100),
    group: z.number().int().min(0).max(2),
    rank: z
      .string()
      .regex(/^\d{1,19}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    kind: z.enum(['FOLDER', 'TASK']),
    id: z.string().uuid(),
  })
  .strict();
export type DirectoryCursor = z.infer<typeof cursorSchema>;
export class DirectoryCursorError extends Error {
  constructor(readonly kind: 'invalid' | 'expired') {
    super(kind === 'invalid' ? '目录分页游标无效' : '目录已变化，请重新加载后继续');
  }
}
export function directoryKey(
  item: TreeItemDto,
): Pick<DirectoryCursor, 'group' | 'rank' | 'kind' | 'id'> {
  const row = item.kind === 'FOLDER' ? item.folder : item.task;
  const status = item.kind === 'FOLDER' ? item.aggregate.status : item.task.status;
  return {
    group: { IN_PROGRESS: 0, TODO: 1, DONE: 2 }[status],
    rank: row.rank,
    kind: item.kind,
    id: row.id,
  };
}
export function encodeDirectoryCursor(value: DirectoryCursor): string {
  return `d1.${encodeURIComponent(JSON.stringify(value))}`;
}
export function decodeDirectoryCursor(
  token: string | undefined,
  scope: { owner: string; parent: string | null; revision: string },
): DirectoryCursor | null {
  if (!token) return null;
  let value: DirectoryCursor;
  try {
    if (token.length > 1024 || !token.startsWith('d1.')) throw new Error('format');
    value = cursorSchema.parse(JSON.parse(decodeURIComponent(token.slice(3))));
  } catch {
    throw new DirectoryCursorError('invalid');
  }
  if (value.owner !== scope.owner || value.parent !== scope.parent)
    throw new DirectoryCursorError('invalid');
  if (value.revision !== scope.revision) throw new DirectoryCursorError('expired');
  return value;
}
export function compareDirectoryKeys(
  a: ReturnType<typeof directoryKey>,
  b: ReturnType<typeof directoryKey>,
): number {
  return (
    a.group - b.group ||
    (BigInt(a.rank) < BigInt(b.rank) ? -1 : BigInt(a.rank) > BigInt(b.rank) ? 1 : 0) ||
    (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'FOLDER' ? -1 : 1)
  );
}
/** The caller provides a complete local/memory projection, never a preview. */
export function paginateDirectory(
  items: TreeItemDto[],
  scope: { owner: string; parent: string | null; revision: string },
  limit: number,
  token?: string,
): DirectoryPage {
  const after = decodeDirectoryCursor(token, scope);
  const ordered = [...items].sort((a, b) => compareDirectoryKeys(directoryKey(a), directoryKey(b)));
  const remaining = after
    ? ordered.filter((row) => compareDirectoryKeys(directoryKey(row), after) > 0)
    : ordered;
  const page = remaining.slice(0, limit);
  return {
    items: page,
    parentFolderId: scope.parent,
    nextCursor:
      remaining.length > limit
        ? encodeDirectoryCursor({ ...scope, ...directoryKey(page.at(-1)!) })
        : null,
  };
}
