import { describe, expect, it } from 'vitest';
import {
  allocateRank,
  allocateReference,
  assertFolderMoveAllowed,
  assertTaskPlacement,
  deriveFolderAggregate,
  deriveEventState,
  folderPath,
  nextLocalDate,
  parseTaskReferences,
  renderSafeMarkdown,
  sortTreeItems,
  stepTransition,
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
    expect(deriveEventState('EVENT', null)).toBe('WAITING');
    expect(deriveEventState('EVENT', now())).toBe('REACHED');
    expect(deriveEventState('DATE', null)).toBeNull();
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

  it('derives mixed descendant folder status without counting deleted data', () => {
    const folders = [
      { id: 'root', parentFolderId: null },
      { id: 'child', parentFolderId: 'root' },
    ];
    expect(
      deriveFolderAggregate('root', folders, [
        { id: 'a', parentFolderId: 'child', status: 'TODO' },
        { id: 'b', parentFolderId: 'child', status: 'DONE' },
        { id: 'c', parentFolderId: 'child', status: 'DONE', deletedAt: 'now' },
      ]),
    ).toEqual({
      status: 'IN_PROGRESS',
      todoCount: 1,
      inProgressCount: 0,
      doneCount: 1,
      totalCount: 2,
    });
  });

  it('rejects folder cycles and keeps mixed tree ordering deterministic', () => {
    expect(() =>
      assertFolderMoveAllowed('a', 'c', [
        { id: 'a', parentFolderId: null },
        { id: 'b', parentFolderId: 'a' },
        { id: 'c', parentFolderId: 'b' },
      ]),
    ).toThrowError('不能移动到自己的后代文件夹');
    const folder = {
      kind: 'FOLDER' as const,
      folder: {
        id: 'folder',
        parentFolderId: null,
        title: 'Folder',
        rank: '2048',
        version: 1,
        createdAt: '',
        updatedAt: '',
      },
      aggregate: {
        status: 'TODO' as const,
        todoCount: 0,
        inProgressCount: 0,
        doneCount: 0,
        totalCount: 0,
      },
    };
    const task = {
      kind: 'TASK' as const,
      task: {
        id: 'task',
        referenceId: 'TASK-1',
        parentFolderId: null,
        title: 'Task',
        status: 'TODO' as const,
        rank: '1024',
        version: 1,
        completedAt: null,
        createdAt: '',
        updatedAt: '',
      },
    };
    expect(sortTreeItems([folder, task]).map((item) => item.kind)).toEqual(['TASK', 'FOLDER']);

    // P1-4: When status and rank are equal, Folder must sort first (Folder-first tie-breaker)
    const sameRankFolder = { ...folder, folder: { ...folder.folder, rank: '1024' } };
    expect(sortTreeItems([task, sameRankFolder]).map((item) => item.kind)).toEqual([
      'FOLDER',
      'TASK',
    ]);
    expect(sortTreeItems([sameRankFolder, task]).map((item) => item.kind)).toEqual([
      'FOLDER',
      'TASK',
    ]);
  });

  it('keeps step state independent and builds an ID-based folder path', () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    expect(stepTransition('TODO', 'DONE', now)).toEqual({ status: 'DONE', completedAt: now });
    expect(
      folderPath('child', [
        { id: 'root', parentFolderId: null, title: 'Root' },
        { id: 'child', parentFolderId: 'root', title: 'Child' },
      ]),
    ).toEqual([
      { id: 'root', title: 'Root' },
      { id: 'child', title: 'Child' },
    ]);
  });
});

function now(): Date {
  return new Date('2026-09-04T10:00:00.000Z');
}
