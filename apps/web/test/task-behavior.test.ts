import { describe, expect, it } from 'vitest';

import {
  nextTaskStatus,
  reorderIds,
  shiftLocalDate,
  taskStatusActionLabel,
} from '../src/task-behavior.js';

describe('TaskDock task interaction contract', () => {
  it('makes the in-progress state reachable from the compact row control', () => {
    expect(nextTaskStatus('TODO')).toBe('IN_PROGRESS');
    expect(nextTaskStatus('IN_PROGRESS')).toBe('DONE');
    expect(nextTaskStatus('DONE')).toBe('TODO');
    expect(taskStatusActionLabel('TODO')).toBe('标记为进行中');
    expect(taskStatusActionLabel('IN_PROGRESS')).toBe('标记为已完成');
    expect(taskStatusActionLabel('DONE')).toBe('重新打开任务');
  });

  it('reorders a placement/task list without duplicating or losing ids', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
    expect(reorderIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorderIds(['a', 'b'], 'missing', 'a')).toEqual(['a', 'b']);
  });

  it('shifts dates using local noon to avoid DST edge cases', () => {
    expect(shiftLocalDate('2026-09-10', 1)).toBe('2026-09-11');
    expect(shiftLocalDate('2026-09-10', -1)).toBe('2026-09-09');
  });
});
