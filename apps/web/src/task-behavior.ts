import type { TaskStatus } from '@devtodo/contracts';

/**
 * TaskDock keeps status on the Task entity (not on a Placement). The compact
 * row control therefore cycles through the three supported states so that
 * IN_PROGRESS is reachable without opening the detail drawer.
 */
export function nextTaskStatus(status: TaskStatus): TaskStatus {
  if (status === 'TODO') return 'IN_PROGRESS';
  if (status === 'IN_PROGRESS') return 'DONE';
  return 'TODO';
}

export function taskStatusActionLabel(status: TaskStatus): string {
  if (status === 'TODO') return '标记为进行中';
  if (status === 'IN_PROGRESS') return '标记为已完成';
  return '重新打开任务';
}

export function reorderIds(ids: string[], sourceId: string, targetId: string): string[] {
  if (sourceId === targetId) return ids;
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return ids;
  const next = [...ids];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return ids;
  next.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, moved);
  return next;
}

export function shiftLocalDate(localDate: string, amount: number): string {
  const date = new Date(`${localDate}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return date.toISOString().slice(0, 10);
}
