import { describe, expect, it } from 'vitest';
import {
  allocateRank,
  allocateReference,
  assertFolderMoveAllowed,
  assertTaskPlacement,
  deriveFolderAggregate,
  deriveFolderAggregates,
  deriveEventState,
  folderPath,
  nextLocalDate,
  parseTaskReferences,
  planSiblingRankMove,
  renderSafeMarkdown,
  sortTreeItems,
  stepTransition,
  transitionFolder,
  transitionTask,
  validateLocalDate,
} from '../src/index.js';

describe('task rules', () => {
  it('sets and clears completedAt through the state machine', () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    expect(transitionTask('TODO', 'DONE', now)).toEqual({ status: 'DONE', completedAt: now });
    expect(transitionTask('DONE', 'TODO', now)).toEqual({ status: 'TODO', completedAt: null });
    expect(transitionFolder('TODO', 'IN_PROGRESS', now)).toEqual({
      status: 'IN_PROGRESS',
      completedAt: null,
    });
    expect(transitionFolder('IN_PROGRESS', 'DONE', now)).toEqual({
      status: 'DONE',
      completedAt: now,
    });
    expect(transitionFolder('DONE', 'TODO', now)).toEqual({ status: 'TODO', completedAt: null });
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

  it('rebalances adjacent and exhausted rank gaps without reversing the requested move', () => {
    const siblings = [
      { id: 'a', rank: '1' },
      { id: 'b', rank: '2' },
      { id: 'c', rank: '3' },
    ];
    const plan = planSiblingRankMove(siblings, 'c', 'b');
    expect(plan.get('c')).toBe('2048');
    expect(plan.get('b')).toBe('3072');
    expect(plan.get('a')).toBe('1024');
    expect(planSiblingRankMove(siblings, 'a', null, 'c').get('a')).toBe('1027');
    expect(() => planSiblingRankMove(siblings, 'a', 'missing')).toThrow('排序锚点已变化');
  });

  it('rebalances instead of emitting a negative rank before a low first sibling', () => {
    const plan = planSiblingRankMove(
      [
        { id: 'a', rank: '1' },
        { id: 'b', rank: '2048' },
      ],
      'b',
      'a',
    );
    expect(plan).toEqual(
      new Map([
        ['b', '1024'],
        ['a', '2048'],
      ]),
    );
    expect([...plan.values()].every((rank) => BigInt(rank) > 0n)).toBe(true);
  });

  it('keeps every planned order strictly increasing across duplicate-rank moves', () => {
    const original = ['a', 'b', 'c', 'd'].map((id) => ({ id, rank: '1' }));
    for (const moving of original) {
      for (const anchor of original) {
        if (moving.id === anchor.id) continue;
        for (const direction of ['before', 'after'] as const) {
          const plan = planSiblingRankMove(
            original,
            moving.id,
            direction === 'before' ? anchor.id : null,
            direction === 'after' ? anchor.id : null,
          );
          const expected = original.filter((row) => row.id !== moving.id);
          const anchorIndex = expected.findIndex((row) => row.id === anchor.id);
          expected.splice(anchorIndex + (direction === 'after' ? 1 : 0), 0, moving);
          const ranks = expected.map((row) => BigInt(plan.get(row.id) ?? row.rank));
          for (let index = 1; index < ranks.length; index += 1)
            expect(ranks[index]! > ranks[index - 1]!).toBe(true);
        }
      }
    }
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

  it('keeps explicit folder status while counting active descendant tasks', () => {
    const folders = [
      { id: 'root', parentFolderId: null },
      { id: 'child', parentFolderId: 'root', status: 'IN_PROGRESS' as const },
    ];
    expect(
      deriveFolderAggregate('root', folders, [
        { id: 'a', parentFolderId: 'child', status: 'TODO' },
        { id: 'b', parentFolderId: 'child', status: 'DONE' },
        { id: 'c', parentFolderId: 'child', status: 'DONE', deletedAt: 'now' },
      ]),
    ).toEqual({
      status: 'TODO',
      todoCount: 1,
      inProgressCount: 0,
      doneCount: 1,
      totalCount: 2,
    });
    expect(
      deriveFolderAggregate('child', folders, [
        { id: 'a', parentFolderId: 'child', status: 'TODO' },
        { id: 'b', parentFolderId: 'child', status: 'DONE' },
      ]),
    ).toEqual({
      status: 'IN_PROGRESS',
      todoCount: 1,
      inProgressCount: 0,
      doneCount: 1,
      totalCount: 2,
    });
  });

  it('shares aggregate indexes across folder pages and rejects cyclic descendants', () => {
    const folders = [
      { id: 'root', parentFolderId: null },
      { id: 'child', parentFolderId: 'root' },
      { id: 'cycle-a', parentFolderId: 'cycle-b' },
      { id: 'cycle-b', parentFolderId: 'cycle-a' },
    ];
    const tasks = [
      { id: 'valid', parentFolderId: 'child', status: 'TODO' as const },
      { id: 'cyclic', parentFolderId: 'cycle-a', status: 'DONE' as const },
      { id: 'orphan', parentFolderId: 'missing', status: 'DONE' as const },
    ];
    const result = deriveFolderAggregates(['root', 'child', 'cycle-a'], folders, tasks);
    expect(result.get('root')).toMatchObject({ totalCount: 1, todoCount: 1 });
    expect(result.get('child')).toMatchObject({ totalCount: 1, todoCount: 1 });
    expect(result.get('cycle-a')).toMatchObject({ totalCount: 0 });
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
