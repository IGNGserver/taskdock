import { describe, expect, it } from 'vitest';
import {
  allocateRank,
  allocateReference,
  assertTaskPlacement,
  deriveEventState,
  nextLocalDate,
  parseTaskReferences,
  renderSafeMarkdown,
  transitionTask,
  validateLocalDate,
} from '../src/index.js';

describe('task rules', () => {
  it('sets and clears completedAt through the state machine', () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    expect(transitionTask('TODO', 'DONE', now)).toEqual({ status: 'DONE', completedAt: now });
    expect(transitionTask('DONE', 'TODO', now)).toEqual({ status: 'TODO', completedAt: null });
  });

  it('keeps event state independent from task state', () => {
    expect(deriveEventState('EVENT', null, null)).toBe('WAITING');
    expect(deriveEventState('EVENT', now(), null)).toBe('REACHED');
    expect(deriveEventState('EVENT', now(), now())).toBe('ARCHIVED');
    expect(deriveEventState('DATE', null, null)).toBeNull();
  });

  it('enforces global misc invariant', () => {
    expect(() => assertTaskPlacement(null, 'FEATURE')).toThrow();
    expect(() => assertTaskPlacement(null, 'MISC')).not.toThrow();
  });

  it('allocates stable references and gap ranks', () => {
    expect(allocateReference('DSH', 32)).toBe('DSH-32');
    expect(allocateRank([1024n, 2048n], 1)).toBe(1536n);
  });

  it('handles dates and references', () => {
    validateLocalDate('2026-09-04');
    expect(nextLocalDate('2026-09-30')).toBe('2026-10-01');
    expect(parseTaskReferences('See DSH-2 and DSH-2, plus MISC-18.')).toEqual(['DSH-2', 'MISC-18']);
  });

  it('sanitizes Markdown HTML and dangerous links', async () => {
    const html = await renderSafeMarkdown(
      '# Context\n\n<script>alert(1)</script> [unsafe](javascript:alert(1)) [docs](https://example.com)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://example.com');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

function now(): Date {
  return new Date('2026-09-04T10:00:00.000Z');
}
