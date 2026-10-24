type Reload = () => unknown;

type DataChange = {
  source?: Reload;
  /** Notes/steps changed, but the task and its list memberships did not. */
  taskDetailId?: string;
};

function changeDetail(event: Event): DataChange | undefined {
  return (event as CustomEvent<DataChange | undefined>).detail;
}

/** Plain sync events still invalidate everything; a local reload need not run twice. */
export function shouldReloadTaskList(event: Event, reload?: Reload): boolean {
  const detail = changeDetail(event);
  return !detail?.taskDetailId && (!reload || detail?.source !== reload);
}

export function changedTaskDetailId(event: Event): string | undefined {
  return changeDetail(event)?.taskDetailId;
}

export function notifyDataChanged(source?: Reload, taskDetailId?: string): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent<DataChange>('devtodo:data-changed', { detail: { source, taskDetailId } }),
    );
}

/** Never suppress a task/status, placement, folder-path or workflow-membership change. */
export function detailOnlyRevalidationId(
  path: string,
  previous: unknown,
  updated: unknown,
): string | undefined {
  const match = /^\/tasks\/([^/?]+)$/.exec(path);
  if (!match || !isRecord(previous) || !isRecord(updated)) return undefined;
  if (
    !isRecord(previous['task']) ||
    !isRecord(updated['task']) ||
    previous['task']['id'] !== match[1] ||
    updated['task']['id'] !== match[1]
  )
    return undefined;
  const listData = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'note' && key !== 'steps'));
  return JSON.stringify(listData(previous)) === JSON.stringify(listData(updated))
    ? match[1]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
