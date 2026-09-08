import type { ErrorCode, TaskCategory, TaskStatus, TimePointType } from '@devtodo/contracts';
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
): { status: TaskStatus; completedAt: Date | null } {
  if (current === next) {
    return { status: current, completedAt: current === 'DONE' ? now : null };
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
