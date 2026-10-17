import type { TaskStepDto } from '@devtodo/contracts';

/**
 * Presentation helpers for the task hover preview. Kept pure so the excerpt
 * rules can be unit-tested without a DOM: the popover must stay a glance, so
 * the note is collapsed to a single line of text and the step list is capped.
 */
export const TASK_PREVIEW_NOTE_LIMIT = 160;
export const TASK_PREVIEW_STEP_LIMIT = 3;

/** Collapse a markdown note into a single-line excerpt for the popover. */
export function previewNoteText(contentMarkdown: string, limit = TASK_PREVIEW_NOTE_LIMIT): string {
  const collapsed = contentMarkdown.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit).trimEnd()}…`;
}

/** Steps a preview may show: never deleted, in their stored order. */
export function previewSteps(steps: TaskStepDto[]): TaskStepDto[] {
  return steps.filter((step) => !step.deletedAt);
}

export function previewStepProgress(steps: TaskStepDto[]): { done: number; total: number } {
  const visible = previewSteps(steps);
  return { done: visible.filter((step) => step.status === 'DONE').length, total: visible.length };
}
