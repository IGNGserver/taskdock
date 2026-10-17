import type { TaskStepDto } from '@devtodo/contracts';
import { describe, expect, it } from 'vitest';

import {
  previewNoteText,
  previewStepProgress,
  previewSteps,
  TASK_PREVIEW_NOTE_LIMIT,
} from '../src/task-preview.js';

function step(overrides: Partial<TaskStepDto> & { id: string }): TaskStepDto {
  return {
    taskId: 'task-1',
    title: `步骤 ${overrides.id}`,
    noteMarkdown: '',
    status: 'TODO',
    rank: '1',
    completedAt: null,
    version: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskDock hover preview helpers', () => {
  it('collapses a markdown note into one trimmed line', () => {
    expect(previewNoteText('  第一行\n\n  第二行  ')).toBe('第一行 第二行');
    expect(previewNoteText('')).toBe('');
  });

  it('truncates long notes at the configured limit with an ellipsis', () => {
    const long = '甲'.repeat(TASK_PREVIEW_NOTE_LIMIT + 40);
    const excerpt = previewNoteText(long);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBe(TASK_PREVIEW_NOTE_LIMIT + 1);
  });

  it('keeps a note that fits the limit untouched', () => {
    const exact = '乙'.repeat(TASK_PREVIEW_NOTE_LIMIT);
    expect(previewNoteText(exact)).toBe(exact);
  });

  it('never previews deleted steps and preserves the stored order', () => {
    const steps = [
      step({ id: 'a', rank: '1' }),
      step({ id: 'b', rank: '2', deletedAt: '2026-09-20T00:00:00.000Z' }),
      step({ id: 'c', rank: '3' }),
    ];
    expect(previewSteps(steps).map((candidate) => candidate.id)).toEqual(['a', 'c']);
  });

  it('counts done steps for the progress label', () => {
    const steps = [
      step({ id: 'a', status: 'DONE' }),
      step({ id: 'b', status: 'IN_PROGRESS' }),
      step({ id: 'c', status: 'DONE', deletedAt: '2026-09-20T00:00:00.000Z' }),
    ];
    expect(previewStepProgress(steps)).toEqual({ done: 1, total: 2 });
    expect(previewStepProgress([])).toEqual({ done: 0, total: 0 });
  });
});
