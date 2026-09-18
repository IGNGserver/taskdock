import type {
  ErrorCode,
  TaskCategory,
  TaskStatus,
  TimePointType,
  FolderAggregateDto,
  FolderDto,
  FolderStatus,
  TreeItemDto,
} from '@devtodo/contracts';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

export const RANK_STEP = 1024n;

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function assertTaskPlacement(
  projectId: string | null | undefined,
  category: TaskCategory,
): void {
  if (projectId === null || projectId === undefined) {
    if (category !== 'MISC') {
      throw new DomainError('VALIDATION_FAILED', '全局任务只能属于杂项分类');
    }
    return;
  }
  if (category !== 'FEATURE' && category !== 'MISC') {
    throw new DomainError('VALIDATION_FAILED', '项目任务分类无效');
  }
}

export function transitionTask(
  current: TaskStatus,
  next: TaskStatus,
  now: Date,
  currentCompletedAt?: Date | string | null,
): { status: TaskStatus; completedAt: Date | null } {
  if (current === next) {
    if (current === 'DONE') {
      const existing = currentCompletedAt ? new Date(currentCompletedAt) : now;
      return { status: current, completedAt: Number.isNaN(existing.getTime()) ? now : existing };
    }
    return { status: current, completedAt: null };
  }
  if (!['TODO', 'IN_PROGRESS', 'DONE'].includes(next)) {
    throw new DomainError('INVALID_STATE_TRANSITION', '任务状态转换无效');
  }
  return { status: next, completedAt: next === 'DONE' ? now : null };
}

export type EventState = 'WAITING' | 'REACHED' | 'ARCHIVED';

export function deriveEventState(
  type: TimePointType,
  reachedAt: Date | string | null,
  archivedAt: Date | string | null,
): EventState | null {
  if (type !== 'EVENT') return null;
  if (archivedAt) return 'ARCHIVED';
  if (reachedAt) return 'REACHED';
  return 'WAITING';
}

export function restoreEventState(
  reachedAt: Date | string | null,
  archivedAt: Date | string | null,
): EventState {
  if (archivedAt) return reachedAt ? 'REACHED' : 'WAITING';
  return reachedAt ? 'REACHED' : 'WAITING';
}

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function localDateInTimezone(date: Date, timezone: string): string {
  if (!isValidIanaTimezone(timezone)) {
    throw new DomainError('VALIDATION_FAILED', `无效的 IANA 时区: ${timezone}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values['year']}-${values['month']}-${values['day']}`;
}

export function nextLocalDate(localDate: string): string {
  const parsed = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(localDate);
  if (!parsed) throw new DomainError('VALIDATION_FAILED', '日期必须是 YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]) + 1));
  return date.toISOString().slice(0, 10);
}

export function validateLocalDate(localDate: string): void {
  const parsed = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(localDate);
  if (!parsed) throw new DomainError('VALIDATION_FAILED', '日期必须是 YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])));
  if (date.toISOString().slice(0, 10) !== localDate) {
    throw new DomainError('VALIDATION_FAILED', '日期不存在');
  }
}

export function allocateRank(existingRanks: bigint[], index = existingRanks.length): bigint {
  const ranks = [...existingRanks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ranks.length === 0) return RANK_STEP;
  if (index <= 0) return ranks[0]! - RANK_STEP;
  if (index >= ranks.length) return ranks[ranks.length - 1]! + RANK_STEP;
  const lower = ranks[index - 1]!;
  const upper = ranks[index]!;
  if (upper - lower > 1n) return lower + (upper - lower) / 2n;
  return upper + RANK_STEP;
}

export function ranksForIds(ids: string[]): Map<string, bigint> {
  return new Map(ids.map((id, index) => [id, BigInt(index + 1) * RANK_STEP]));
}

export function allocateReference(prefix: string, number: number): string {
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) {
    throw new DomainError('VALIDATION_FAILED', '项目代号无效');
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new DomainError('VALIDATION_FAILED', '引用序号无效');
  }
  return `${prefix}-${number}`;
}

export function parseTaskReferences(markdown: string): string[] {
  const references = new Set<string>();
  const matcher = /\b([A-Z][A-Z0-9]{1,9}-[1-9][0-9]*)\b/g;
  for (const match of markdown.matchAll(matcher)) references.add(match[1]!);
  return [...references];
}

export async function renderSafeMarkdown(markdown: string): Promise<string> {
  const markdownSource = sanitizeHtml(markdown, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
  const html = await marked.parse(markdownSource, {
    async: true,
    gfm: true,
    breaks: true,
    walkTokens: (token) => {
      if (token.type === 'link' && /^(?:javascript|vbscript|data):/i.test(token.href.trim())) {
        token.href = '#';
      }
    },
  });
  const sanitized = sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      'del',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'a',
      'hr',
    ],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noreferrer noopener',
        },
      }),
    },
  });
  // Marked keeps an unsafe Markdown destination as literal text. Remove the
  // scheme as well so a note cannot render a misleading executable-looking
  // URL even when the parser declined to create an anchor.
  return sanitized.replace(/\b(?:javascript|vbscript|data):/gi, '');
}

export interface FolderTreeNode {
  id: string;
  parentFolderId: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

export interface FolderTaskForAggregate {
  id: string;
  parentFolderId: string | null;
  status: TaskStatus;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

/**
 * Computes the v2 folder aggregate from active descendants. It is deliberately
 * iterative and carries a visited set so malformed imported data cannot blow
 * the JS stack or loop forever.
 */
export function deriveFolderAggregate(
  folderId: string,
  folders: readonly FolderTreeNode[],
  tasks: readonly FolderTaskForAggregate[],
): FolderAggregateDto {
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.deletedAt || !folder.parentFolderId) continue;
    const list = children.get(folder.parentFolderId) ?? [];
    list.push(folder.id);
    children.set(folder.parentFolderId, list);
  }
  const reachable = new Set<string>();
  const stack = [folderId];
  while (stack.length) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  const counts = { TODO: 0, IN_PROGRESS: 0, DONE: 0 } as Record<TaskStatus, number>;
  for (const task of tasks) {
    if (
      task.deletedAt ||
      task.archivedAt ||
      !task.parentFolderId ||
      !reachable.has(task.parentFolderId)
    )
      continue;
    // A task is only valid when every folder in its path is active. Walk the
    // path iteratively and reject cycles/missing parents as invalid descendants.
    const pathSeen = new Set<string>();
    let parent: string | null = task.parentFolderId;
    let valid = true;
    while (parent) {
      if (pathSeen.has(parent)) {
        valid = false;
        break;
      }
      pathSeen.add(parent);
      const folder = folderMap.get(parent);
      if (!folder || folder.deletedAt || folder.archivedAt) {
        valid = false;
        break;
      }
      parent = folder.parentFolderId;
    }
    if (valid) counts[task.status] += 1;
  }
  const totalCount = counts.TODO + counts.IN_PROGRESS + counts.DONE;
  const status: FolderStatus =
    totalCount === 0 || counts.TODO === totalCount
      ? 'TODO'
      : counts.DONE === totalCount
        ? 'DONE'
        : 'IN_PROGRESS';
  return {
    status,
    todoCount: counts.TODO,
    inProgressCount: counts.IN_PROGRESS,
    doneCount: counts.DONE,
    totalCount,
  };
}

export function assertFolderMoveAllowed(
  folderId: string,
  targetParentId: string | null,
  folders: readonly FolderTreeNode[],
): void {
  if (targetParentId === folderId) throw new DomainError('TREE_CYCLE', '文件夹不能成为自己的父级');
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  if (targetParentId === null) return;
  if (!folderMap.has(targetParentId))
    throw new DomainError('PARENT_NOT_FOLDER', '目标父级不是活动文件夹');
  const seen = new Set<string>();
  let current: string | null = targetParentId;
  while (current) {
    if (seen.has(current)) throw new DomainError('TREE_CYCLE', '目录树存在循环');
    seen.add(current);
    if (current === folderId) throw new DomainError('TREE_CYCLE', '不能移动到自己的后代文件夹');
    current = folderMap.get(current)?.parentFolderId ?? null;
  }
}

export function sortTreeItems(items: readonly TreeItemDto[]): TreeItemDto[] {
  const order: Record<FolderStatus, number> = { IN_PROGRESS: 0, TODO: 1, DONE: 2 };
  return [...items].sort((left, right) => {
    const leftStatus = left.kind === 'FOLDER' ? left.aggregate.status : left.task.status;
    const rightStatus = right.kind === 'FOLDER' ? right.aggregate.status : right.task.status;
    const group = order[leftStatus] - order[rightStatus];
    if (group) return group;
    const leftRank = BigInt(left.kind === 'FOLDER' ? left.folder.rank : left.task.rank);
    const rightRank = BigInt(right.kind === 'FOLDER' ? right.folder.rank : right.task.rank);
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
    // P1-4: Folder-first tie-breaking within same status and rank
    if (left.kind !== right.kind) return left.kind === 'FOLDER' ? -1 : 1;
    const leftKey = `${left.kind}:${left.kind === 'FOLDER' ? left.folder.id : left.task.id}`;
    const rightKey = `${right.kind}:${right.kind === 'FOLDER' ? right.folder.id : right.task.id}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function assertTreeParentIsActiveFolder(
  parentFolderId: string | null,
  folders: readonly FolderTreeNode[],
): void {
  if (parentFolderId === null) return;
  const folder = folders.find((candidate) => candidate.id === parentFolderId);
  if (!folder) throw new DomainError('PARENT_NOT_FOLDER', '目标父级不是文件夹');
  if (folder.deletedAt) throw new DomainError('TARGET_ARCHIVED', '目标文件夹已删除');
  if (folder.archivedAt) throw new DomainError('TARGET_ARCHIVED', '目标文件夹已归档');
}

export function stepTransition(
  current: TaskStatus,
  next: TaskStatus,
  now: Date,
  currentCompletedAt?: Date | string | null,
): { status: TaskStatus; completedAt: Date | null } {
  if (current === next) {
    if (current === 'DONE') {
      const existing = currentCompletedAt ? new Date(currentCompletedAt) : now;
      return { status: current, completedAt: Number.isNaN(existing.getTime()) ? now : existing };
    }
    return { status: current, completedAt: null };
  }
  if (!['TODO', 'IN_PROGRESS', 'DONE'].includes(next))
    throw new DomainError('INVALID_STATE_TRANSITION', '步骤状态无效');
  return { status: next, completedAt: next === 'DONE' ? now : null };
}

export function folderPath(
  folderId: string | null,
  folders: readonly Pick<FolderDto, 'id' | 'parentFolderId' | 'title'>[],
): Array<Pick<FolderDto, 'id' | 'title'>> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result: Array<Pick<FolderDto, 'id' | 'title'>> = [];
  const visited = new Set<string>();
  let current = folderId;
  while (current) {
    if (visited.has(current)) throw new DomainError('TREE_CYCLE', '目录树存在循环');
    visited.add(current);
    const folder = byId.get(current);
    if (!folder) throw new DomainError('ENTITY_NOT_FOUND', '目录路径不存在');
    result.unshift({ id: folder.id, title: folder.title });
    current = folder.parentFolderId;
  }
  return result;
}
