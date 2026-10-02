import type { TaskDetailV2Dto, TaskStatus, TaskStepDto } from '@devtodo/contracts';

export type StepDraft = Pick<TaskStepDto, 'title' | 'noteMarkdown' | 'status'>;
export type TaskEditorDraft = {
  record: TaskDetailV2Dto;
  title: string;
  note: string;
  newStep: string;
  status: TaskStatus;
  steps: Record<string, StepDraft>;
  pending: number;
  failures: Record<string, string>;
  queue: Promise<void>;
  deleted: boolean;
  listeners: Set<() => void>;
  retries: Map<string, () => Promise<boolean>>;
};

export function createTaskEditorDraft(detail: TaskDetailV2Dto): TaskEditorDraft {
  return {
    record: detail,
    title: detail.task.title,
    note: detail.note.contentMarkdown,
    newStep: '',
    status: detail.task.status,
    steps: Object.fromEntries(
      detail.steps.map((step) => [
        step.id,
        { title: step.title, noteMarkdown: step.noteMarkdown, status: step.status },
      ]),
    ),
    pending: 0,
    failures: {},
    queue: Promise.resolve(),
    deleted: false,
    listeners: new Set(),
    retries: new Map(),
  };
}

/** New server values refresh saved fields without replacing work still being edited. */
export function mergeTaskEditorDraft(draft: TaskEditorDraft, detail: TaskDetailV2Dto) {
  const previous = draft.record;
  if (detail.task.version >= previous.task.version) {
    if (draft.title === previous.task.title) draft.title = detail.task.title;
    if (draft.status === previous.task.status) draft.status = detail.task.status;
    draft.record = { ...draft.record, task: detail.task };
  }
  if (detail.note.version >= previous.note.version) {
    if (draft.note === previous.note.contentMarkdown) draft.note = detail.note.contentMarkdown;
    draft.record = { ...draft.record, note: detail.note };
  }
  if (!draft.pending) {
    draft.record = {
      ...draft.record,
      steps: detail.steps.map((step) => {
        const saved = previous.steps.find((candidate) => candidate.id === step.id);
        return saved && saved.version > step.version ? saved : step;
      }),
      placements: detail.placements,
      workflowMemberships: detail.workflowMemberships,
      folderPath: detail.folderPath,
    };
    for (const step of draft.record.steps) {
      const saved = previous.steps.find((candidate) => candidate.id === step.id);
      const local = draft.steps[step.id];
      draft.steps[step.id] = {
        title: !local || local.title === saved?.title ? step.title : local.title,
        noteMarkdown:
          !local || local.noteMarkdown === saved?.noteMarkdown
            ? step.noteMarkdown
            : local.noteMarkdown,
        status: !local || local.status === saved?.status ? step.status : local.status,
      };
    }
  }
}
