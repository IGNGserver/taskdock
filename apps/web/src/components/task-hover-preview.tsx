import type { TaskDetailV2Dto, TreeTaskDto } from '@devtodo/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { requestV2 } from '../api.js';
import { localCacheGeneration } from '../local.js';
import { isLowDataMode } from '../network-policy.js';
import { changedTaskDetailId } from '../data-changes.js';
import {
  previewNoteText,
  previewStepProgress,
  previewSteps,
  TASK_PREVIEW_STEP_LIMIT,
} from '../task-preview.js';
import { TaskStatusIndicator } from './m3e/index.js';

/**
 * Hover preview for a task row: after a short dwell the row's note excerpt and
 * step progress appear in a non-interactive popover, so a pointer-only desktop
 * user can tell two similarly named tasks apart without opening the editor.
 *
 * The preview is deliberately desktop-only (`pointerType === 'mouse'` plus the
 * caller's `enabled` flag), reads through the same v2 endpoint the task editor
 * uses, and keeps a short-lived cache so hovering a list does not refetch on
 * every row. The popover never receives pointer events: it must not steal the
 * hover that keeps it open.
 */

const HOVER_DELAY_MS = 350;
const CACHE_TTL_MS = 30_000;
const PREVIEW_WIDTH = 320;
const PREVIEW_GAP = 8;
const PREVIEW_ESTIMATED_HEIGHT = 220;

type PreviewData =
  { status: 'loading' } | { status: 'ready'; detail: TaskDetailV2Dto } | { status: 'error' };

type PreviewPosition = { top: number; left: number; width: number };

const detailCache = new Map<string, { detail: TaskDetailV2Dto; fetchedAt: number }>();

/*
 * A sync can replace a note or step list between two hovers; the cache is
 * dropped whenever the workspace announces new data so a preview never shows
 * content that was already superseded.
 */
if (typeof window !== 'undefined')
  window.addEventListener('devtodo:data-changed', (event) => {
    const taskId = changedTaskDetailId(event);
    if (taskId) detailCache.delete(`${localCacheGeneration()}:${taskId}`);
    else detailCache.clear();
  });

function previewPosition(anchor: HTMLElement): PreviewPosition {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(PREVIEW_WIDTH, window.innerWidth - 16);
  const left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - 8 - width));
  let top = rect.bottom + PREVIEW_GAP;
  if (top + PREVIEW_ESTIMATED_HEIGHT > window.innerHeight - 8) {
    const above = rect.top - PREVIEW_GAP - PREVIEW_ESTIMATED_HEIGHT;
    if (above >= 8) top = above;
  }
  return { top, left, width };
}

export type TaskHoverAnchorProps = {
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDownCapture: () => void;
};

export function useTaskHoverPreview(
  task: TreeTaskDto,
  enabled = true,
): { anchorProps: TaskHoverAnchorProps; popover: ReactNode } {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PreviewData | null>(null);
  const [position, setPosition] = useState<PreviewPosition | null>(null);
  const delayRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const clearDelay = useCallback(() => {
    if (delayRef.current !== null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearDelay();
    requestRef.current += 1;
    controllerRef.current?.abort();
    setOpen(false);
    setData(null);
    setPosition(null);
  }, [clearDelay]);

  useEffect(
    () => () => {
      clearDelay();
      controllerRef.current?.abort();
    },
    [clearDelay],
  );

  // Any scroll or resize moves the anchor away from the recorded position, so
  // the popover closes instead of drifting over unrelated content.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => close();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [close, open]);

  const show = useCallback(
    async (anchor: HTMLElement) => {
      setPosition(previewPosition(anchor));
      setOpen(true);
      const key = `${localCacheGeneration()}:${task.id}`;
      const cached = detailCache.get(key);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        setData({ status: 'ready', detail: cached.detail });
        return;
      }
      const request = ++requestRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setData({ status: 'loading' });
      try {
        const detail = await requestV2<TaskDetailV2Dto>(`/tasks/${task.id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (detailCache.size >= 48) detailCache.delete(detailCache.keys().next().value!);
        detailCache.set(key, { detail, fetchedAt: Date.now() });
        if (requestRef.current === request) setData({ status: 'ready', detail });
      } catch {
        if (requestRef.current === request) setData({ status: 'error' });
      }
    },
    [task.id],
  );

  const anchorProps = useMemo<TaskHoverAnchorProps>(
    () => ({
      onPointerEnter: (event) => {
        if (!enabled || event.pointerType !== 'mouse' || isLowDataMode()) return;
        clearDelay();
        const anchor = event.currentTarget;
        delayRef.current = window.setTimeout(() => {
          delayRef.current = null;
          void show(anchor);
        }, HOVER_DELAY_MS);
      },
      onPointerLeave: () => close(),
      onPointerDownCapture: () => close(),
    }),
    [clearDelay, close, enabled, show],
  );

  const popover =
    open && data && position && typeof document !== 'undefined'
      ? createPortal(<TaskPreviewCard task={task} data={data} position={position} />, document.body)
      : null;

  return { anchorProps, popover };
}

/**
 * Render-prop wrapper for rows that are created inside a `map()` callback,
 * where a hook cannot be called directly. It adds no DOM node, so lists keep
 * their own `ul > li` structure.
 */
export function TaskHoverPreviewRow({
  task,
  enabled = true,
  children,
}: {
  task: TreeTaskDto;
  enabled?: boolean;
  children: (anchorProps: TaskHoverAnchorProps) => ReactNode;
}) {
  const { anchorProps, popover } = useTaskHoverPreview(task, enabled);
  return (
    <>
      {children(anchorProps)}
      {popover}
    </>
  );
}

function TaskPreviewCard({
  task,
  data,
  position,
}: {
  task: TreeTaskDto;
  data: PreviewData;
  position: PreviewPosition;
}) {
  return (
    <div
      className="task-hover-preview"
      role="tooltip"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        inlineSize: `${position.width}px`,
      }}
    >
      <div className="task-hover-preview__head">
        <strong className="task-hover-preview__title">{task.title}</strong>
        <code className="task-hover-preview__ref">{task.referenceId}</code>
      </div>
      {data.status === 'loading' ? (
        <p className="task-hover-preview__muted">正在读取备注与步骤…</p>
      ) : data.status === 'error' ? (
        <p className="task-hover-preview__muted">无法读取任务详情，点击任务可查看完整内容。</p>
      ) : (
        <TaskPreviewBody detail={data.detail} />
      )}
    </div>
  );
}

function TaskPreviewBody({ detail }: { detail: TaskDetailV2Dto }) {
  const note = previewNoteText(detail.note?.contentMarkdown ?? '');
  const steps = previewSteps(detail.steps ?? []);
  const progress = previewStepProgress(steps);
  return (
    <>
      <section className="task-hover-preview__section">
        <span className="task-hover-preview__label">备注</span>
        {note ? (
          <p className="task-hover-preview__note">{note}</p>
        ) : (
          <p className="task-hover-preview__muted">暂无备注</p>
        )}
      </section>
      <section className="task-hover-preview__section">
        <span className="task-hover-preview__label">
          步骤{progress.total ? ` · ${progress.done}/${progress.total} 已完成` : ''}
        </span>
        {steps.length ? (
          <ul className="task-hover-preview__steps">
            {steps.slice(0, TASK_PREVIEW_STEP_LIMIT).map((step) => (
              <li key={step.id}>
                <TaskStatusIndicator status={step.status} />
                <span className="task-hover-preview__step-title">{step.title}</span>
              </li>
            ))}
            {steps.length > TASK_PREVIEW_STEP_LIMIT && (
              <li className="task-hover-preview__more">
                还有 {steps.length - TASK_PREVIEW_STEP_LIMIT} 项步骤
              </li>
            )}
          </ul>
        ) : (
          <p className="task-hover-preview__muted">暂无步骤</p>
        )}
      </section>
    </>
  );
}
