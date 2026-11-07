import { useEffect, useRef } from 'react';

import { Button, Dialog, TextArea } from './m3e/index.js';

export interface NoteEditorDialogProps {
  open: boolean;
  taskTitle: string;
  value: string;
  saveLabel: string;
  error?: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onRetry: () => void;
}

/**
 * Full-size writing surface for a task note. It deliberately owns no state:
 * the surrounding editor keeps the single draft and save queue, so the compact
 * and expanded views can never disagree.
 */
export function NoteEditorDialog({
  open,
  taskTitle,
  value,
  saveLabel,
  error,
  onChange,
  onClose,
  onRetry,
}: NoteEditorDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="编辑备注"
      className="note-editor-dialog"
      footer={
        <>
          <span
            className={
              error ? 'note-editor-dialog__status has-error' : 'note-editor-dialog__status'
            }
            role="status"
            aria-live="polite"
          >
            {saveLabel}
          </span>
          <Button variant="filled" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="note-editor-dialog__body">
        <p className="note-editor-dialog__context" title={taskTitle}>
          {taskTitle}
        </p>
        <p className="note-editor-dialog__hint">修改会自动保存</p>
        {error && (
          <div className="note-editor-dialog__error" role="alert">
            <span>{error}</span>
            <Button variant="text" size="s" onClick={onRetry}>
              重试
            </Button>
          </div>
        )}
        <TextArea
          ref={textareaRef}
          className="note-editor-dialog__field"
          label="编辑任务备注"
          hideLabel
          placeholder="添加备注…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          initialFocus
          rows={12}
        />
      </div>
    </Dialog>
  );
}
