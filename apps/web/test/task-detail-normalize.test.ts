import { describe, expect, it } from 'vitest';

import { normalizeTaskDetail } from '../src/task-detail-normalize.js';

const task = {
  id: 'task-1',
  referenceId: 'TASK-1',
  parentFolderId: null,
  title: '整理发布清单',
  status: 'TODO',
  rank: '1024',
  version: 3,
  completedAt: null,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
};

describe('normalizeTaskDetail', () => {
  it('keeps a complete response intact', () => {
    const detail = normalizeTaskDetail({
      task,
      note: {
        id: 'note-1',
        taskId: task.id,
        contentMarkdown: '备注',
        version: 2,
        updatedAt: task.updatedAt,
      },
      steps: [
        {
          id: 'step-1',
          taskId: task.id,
          title: '验证构建',
          noteMarkdown: '',
          status: 'DONE',
          rank: '1024',
          version: 1,
          completedAt: null,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
      ],
      placements: [
        {
          id: 'placement-1',
          taskId: task.id,
          timePointId: 'point-1',
          rank: '1024',
          version: 1,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          timePoint: {
            id: 'point-1',
            type: 'DATE',
            localDate: '2026-10-21',
            title: null,
            rank: '1024',
            version: 1,
            reachedAt: null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
        },
      ],
      workflowMemberships: [
        {
          id: 'membership-1',
          workflowId: 'workflow-1',
          stageId: 'stage-1',
          taskId: task.id,
          rank: '1024',
          version: 1,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          workflow: { id: 'workflow-1', name: '发布' },
          stage: { id: 'stage-1', name: '验证' },
        },
      ],
      folderPath: [{ id: 'folder-1', title: '工作' }],
    });

    expect(detail?.task.id).toBe(task.id);
    expect(detail?.note.contentMarkdown).toBe('备注');
    expect(detail?.steps).toHaveLength(1);
    expect(detail?.placements[0]?.timePoint.localDate).toBe('2026-10-21');
    expect(detail?.workflowMemberships[0]?.stage.name).toBe('验证');
    expect(detail?.folderPath).toEqual([{ id: 'folder-1', title: '工作' }]);
  });

  it('fills missing collections and notes instead of throwing in the editor', () => {
    const detail = normalizeTaskDetail({ task });
    expect(detail).not.toBeNull();
    expect(detail?.steps).toEqual([]);
    expect(detail?.placements).toEqual([]);
    expect(detail?.workflowMemberships).toEqual([]);
    expect(detail?.folderPath).toEqual([]);
    expect(detail?.note.contentMarkdown).toBe('');
    expect(detail?.note.version).toBe(0);
  });

  it('drops malformed rows and rejects a response without a valid task', () => {
    const detail = normalizeTaskDetail({
      task,
      steps: [{ id: '' }, { id: 'step-2', title: '保留' }],
      placements: [{ id: 'placement-1' }],
      workflowMemberships: [{ id: 'membership-1' }],
      folderPath: [{ id: 'folder-1' }, { title: '缺 id' }],
    });
    expect(detail?.steps).toHaveLength(1);
    expect(detail?.steps[0]?.id).toBe('step-2');
    expect(detail?.placements).toEqual([]);
    expect(detail?.workflowMemberships).toEqual([]);
    expect(detail?.folderPath).toEqual([]);
    expect(normalizeTaskDetail({ note: {} })).toBeNull();
    expect(normalizeTaskDetail(null)).toBeNull();
  });
});
