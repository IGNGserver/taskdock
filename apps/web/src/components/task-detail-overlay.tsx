import type { TaskDetailV2Dto } from '@devtodo/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { requestV2 } from '../api.js';
import { useDevice } from '../device.js';
import { normalizeTaskDetail } from '../task-detail-normalize.js';
import type { TaskEditorDraft } from '../task-editor-draft.js';
import { ErrorBoundary } from './error-boundary.js';
import { TaskDetailEditor } from './task-detail-editor.js';
import {
  Alert,
  BottomSheet,
  Button,
  IconButton,
  LoadingState,
  useWindowSizeClass,
} from './m3e/index.js';

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function TaskDetailV2Overlay({
  taskId,
  onClose,
  onChanged,
  focusTitle = false,
}: {
  taskId: string | null;
  onClose: () => void;
  onChanged: () => void;
  focusTitle?: boolean;
}) {
  const [detail, setDetail] = useState<TaskDetailV2Dto | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const drafts = useRef(new Map<string, TaskEditorDraft>());
  const load = useCallback(async () => {
    if (!taskId) return;
    const requestSequence = ++sequence.current;
    try {
      // Contract validation at the boundary: a partial cached response or an
      // older server shape must produce a retry, not a render crash.
      const nextDetail = normalizeTaskDetail(await requestV2<unknown>(`/tasks/${taskId}`));
      if (!nextDetail) throw new Error('任务详情格式异常，请重试');
      if (requestSequence === sequence.current) {
        setDetail(nextDetail);
        setError('');
      }
    } catch (cause) {
      if (requestSequence === sequence.current) setError(errorMessage(cause, '任务详情加载失败'));
    }
  }, [taskId]);
  useEffect(() => {
    setDetail(null);
    setError('');
    void load();
    const changed = () => void load();
    window.addEventListener('devtodo:data-changed', changed);
    return () => {
      sequence.current += 1;
      window.removeEventListener('devtodo:data-changed', changed);
    };
  }, [load]);
  if (!taskId) return null;
  const current = detail?.task?.id === taskId ? detail : null;
  return (
    <TaskDetailSurface onClose={onClose}>
      {error && (
        <Alert
          tone="error"
          title="任务详情加载失败"
          action={
            <Button variant="text" size="s" onClick={() => void load()}>
              重试
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {current ? (
        <ErrorBoundary
          key={taskId}
          fallback={(cause, reset) => (
            <div role="alert">
              <h2>任务详情暂时无法显示</h2>
              <p>任务数据没有丢失。可以重试，或关闭后重新打开。</p>
              <Button variant="text" size="s" onClick={reset}>
                重试
              </Button>
              <details>
                <summary>错误详情</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{cause.message}</pre>
              </details>
            </div>
          )}
        >
          <TaskDetailEditor
            detail={current}
            drafts={drafts.current}
            focusTitle={focusTitle}
            onClose={onClose}
            onChanged={onChanged}
          />
        </ErrorBoundary>
      ) : (
        !error && <LoadingState label="正在加载任务详情" />
      )}
    </TaskDetailSurface>
  );
}

function TaskDetailSurface({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { isPhone } = useDevice();
  const sizeClass = useWindowSizeClass();
  if (isPhone || sizeClass === 'compact')
    return (
      <BottomSheet open onClose={onClose} title="任务详情" size="full">
        {children}
      </BottomSheet>
    );
  return (
    <aside className="workspace-task-detail" aria-label="任务详情">
      <div className="workspace-detail-header">
        <span>任务详情</span>
        <IconButton size="s" label="关闭任务详情" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="workspace-detail-scroll">{children}</div>
    </aside>
  );
}
