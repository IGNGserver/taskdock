import type { TaskStatus } from '@devtodo/contracts';

/** A checkbox-style primary action completes any open task or reopens it. */
export function toggleTaskCompletion(status: TaskStatus): TaskStatus {
  return status === 'DONE' ? 'TODO' : 'DONE';
}

export function taskStatusLabel(status: TaskStatus): string {
  if (status === 'IN_PROGRESS') return '进行中';
  if (status === 'DONE') return '已完成';
  return '待开始';
}

export function taskStatusActionLabel(status: TaskStatus): string {
  return status === 'DONE' ? '重新打开任务' : '标记为已完成';
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
