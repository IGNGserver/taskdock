import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changedTaskDetailId,
  detailOnlyRevalidationId,
  notifyDataChanged,
  shouldReloadTaskList,
} from '../src/data-changes.js';

afterEach(() => vi.unstubAllGlobals());

const detail = {
  task: { id: 'task-1', title: 'Task', status: 'TODO', version: 1 },
  note: { contentMarkdown: 'Before', version: 1 },
  steps: [],
  placements: [{ id: 'placement-1', rank: '2', timePointId: 'event-1' }],
  workflowMemberships: [{ id: 'member-1', stage: { id: 'stage-1', name: 'Stage' } }],
  folderPath: [],
};

describe('workspace data invalidation', () => {
  it('keeps note/step revalidation local to task-detail consumers', () => {
    const updated = {
      ...detail,
      note: { contentMarkdown: 'After', version: 2 },
      steps: [{ id: 'step-1', status: 'DONE' }],
    };
    expect(detailOnlyRevalidationId('/tasks/task-1', detail, updated)).toBe('task-1');
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const listReload = vi.fn();
    const detailReload = vi.fn();
    target.addEventListener('devtodo:data-changed', (event) => {
      if (shouldReloadTaskList(event, listReload)) listReload();
      detailReload(changedTaskDetailId(event));
    });
    notifyDataChanged(undefined, detailOnlyRevalidationId('/tasks/task-1', detail, updated));
    expect(listReload).not.toHaveBeenCalled();
    expect(detailReload).toHaveBeenCalledWith('task-1');
  });

  it.each([
    { task: { ...detail.task, status: 'DONE', version: 2 } },
    { task: { ...detail.task, title: 'Renamed' } },
    { placements: [{ ...detail.placements[0], rank: '10' }] },
    { placements: [] },
    { workflowMemberships: [] },
    { folderPath: [{ id: 'folder-1', title: 'Moved' }] },
  ])('still invalidates task lists when list data changes: %j', (change) => {
    expect(
      detailOnlyRevalidationId('/tasks/task-1', detail, { ...detail, ...change }),
    ).toBeUndefined();
  });

  it('does not scope summary reads, other endpoints or invalid projections', () => {
    for (const path of ['/tasks', '/tasks/task-1?view=summary', '/time-points/event-1'])
      expect(detailOnlyRevalidationId(path, detail, detail)).toBeUndefined();
    expect(detailOnlyRevalidationId('/tasks/task-1', undefined, detail)).toBeUndefined();
    expect(detailOnlyRevalidationId('/tasks/task-1', detail, null)).toBeUndefined();
    expect(detailOnlyRevalidationId('/tasks/task-1', {}, {})).toBeUndefined();
    expect(detailOnlyRevalidationId('/tasks/another-task', detail, detail)).toBeUndefined();
  });

  it('notifies other consumers without repeating a completed local reload', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const source = vi.fn();
    const other = vi.fn();
    target.addEventListener('devtodo:data-changed', (event) => {
      if (shouldReloadTaskList(event, source)) source();
      if (shouldReloadTaskList(event, other)) other();
    });
    notifyDataChanged(source);
    expect(source).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    // The sync engine and older call sites still use an ordinary Event.
    target.dispatchEvent(new Event('devtodo:data-changed'));
    expect(source).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledTimes(2);
  });
});
