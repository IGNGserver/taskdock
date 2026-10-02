import type { TaskDetailV2Dto } from '@devtodo/contracts';
import { describe, expect, it } from 'vitest';
import { createTaskEditorDraft, mergeTaskEditorDraft } from '../src/task-editor-draft.js';

function detail(): TaskDetailV2Dto {
  return {
    task: {
      id: 'task',
      referenceId: 'TASK-1',
      parentFolderId: null,
      title: '原始标题',
      status: 'TODO',
      rank: '1024',
      version: 1,
      completedAt: null,
      createdAt: '',
      updatedAt: '',
    },
    note: { id: 'note', taskId: 'task', contentMarkdown: '原始备注', version: 1, updatedAt: '' },
    steps: [
      {
        id: 'step',
        taskId: 'task',
        title: '原始步骤',
        noteMarkdown: '',
        status: 'TODO',
        rank: '1024',
        version: 1,
        completedAt: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    placements: [],
    workflowMemberships: [],
    folderPath: [],
  };
}
describe('retained editor drafts', () => {
  it('refreshes saved fields while preserving title, note and step edits', () => {
    const initial = detail();
    const draft = createTaskEditorDraft(initial);
    draft.title = '本地标题';
    draft.note = '本地备注';
    draft.steps.step!.title = '本地步骤';
    mergeTaskEditorDraft(draft, {
      ...initial,
      task: { ...initial.task, title: '服务器标题', status: 'DONE', version: 2 },
      note: { ...initial.note, contentMarkdown: '服务器备注', version: 2 },
      steps: [{ ...initial.steps[0]!, title: '服务器步骤', noteMarkdown: '新的备注', version: 2 }],
    });
    expect([draft.title, draft.note, draft.steps.step!.title]).toEqual([
      '本地标题',
      '本地备注',
      '本地步骤',
    ]);
    expect(draft.status).toBe('DONE');
    expect(draft.steps.step!.noteMarkdown).toBe('新的备注');
    expect(draft.record.task.version).toBe(2);
  });
  it('does not regress versions when a delayed read arrives after saving', () => {
    const stale = detail();
    const newer = {
      ...stale,
      task: { ...stale.task, title: '已保存标题', version: 3 },
      note: { ...stale.note, contentMarkdown: '已保存备注', version: 3 },
      steps: [{ ...stale.steps[0]!, title: '已保存步骤', version: 3 }],
    };
    const draft = createTaskEditorDraft(newer);
    mergeTaskEditorDraft(draft, stale);
    expect([draft.title, draft.note, draft.steps.step!.title]).toEqual([
      '已保存标题',
      '已保存备注',
      '已保存步骤',
    ]);
    expect(draft.record.steps[0]!.version).toBe(3);
  });
  it('keeps newly created steps during a pending save and adopts new server steps afterwards', () => {
    const initial = detail();
    const draft = createTaskEditorDraft(initial);
    draft.pending = 1;
    mergeTaskEditorDraft(draft, { ...initial, steps: [] });
    expect(draft.record.steps).toHaveLength(1);
    draft.pending = 0;
    mergeTaskEditorDraft(draft, {
      ...initial,
      steps: [...initial.steps, { ...initial.steps[0]!, id: 'new-step', title: '新步骤' }],
    });
    expect(draft.steps['new-step']!.title).toBe('新步骤');
  });
});
