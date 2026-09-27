import { useState, type FormEvent, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { BottomSheet } from './container.js';
import { Button } from './button.js';
import { TextField } from './field.js';
import { haptic } from './behavior.js';

export interface MobileQuickCaptureSheetProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (title: string) => Promise<void> | void;
  placeholder?: string;
  title?: string;
  helperText?: ReactNode;
}

/**
 * Mobile-optimized quick task capture sheet.
 * Automatically handles focus and mobile virtual keyboards, providing a native-app capture experience.
 */
export function MobileQuickCaptureSheet({
  open,
  onClose,
  onSubmit,
  placeholder = '准备做点什么？',
  title = '快速添加任务',
  helperText,
}: MobileQuickCaptureSheetProps) {
  const [taskTitle, setTaskTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = taskTitle.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError('');
    try {
      await onSubmit(trimmed);
      haptic(12);
      setTaskTitle('');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        if (!busy) {
          setTaskTitle('');
          setError('');
          onClose();
        }
      }}
      title={title}
      className="mobile-quick-capture-sheet"
    >
      <form onSubmit={handleSubmit} className="mobile-quick-capture-form">
        <TextField
          label="快速创建任务"
          value={taskTitle}
          onChange={(e) => setTaskTitle(e.target.value)}
          placeholder={placeholder}
          error={error}
          disabled={busy}
          data-autofocus
          autoFocus
          className="mobile-quick-capture-input"
        />
        {helperText && <div className="mobile-quick-capture-helper">{helperText}</div>}
        <div className="mobile-quick-capture-actions">
          <Button type="button" variant="text" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            variant="filled"
            disabled={!taskTitle.trim() || busy}
            leadingIcon={<Plus size={18} />}
          >
            {busy ? '正在添加…' : '创建任务'}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
