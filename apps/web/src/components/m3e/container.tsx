import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  SPRING_DURATION,
  useFocusTrap,
  usePresence,
  useScrollLock,
  type PresenceState,
} from './behavior.js';
import { Button, IconButton, CloseGlyph, joinClasses, type ButtonVariant } from './button.js';

/** M3E elevated / filled / outlined card. */
export function Card({
  variant = 'filled',
  children,
  className,
  interactive = false,
  as = 'div',
  ...props
}: {
  variant?: 'elevated' | 'filled' | 'outlined';
  children: ReactNode;
  className?: string;
  interactive?: boolean;
} & HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' }) {
  const Component = as;
  return (
    <Component
      {...props}
      className={joinClasses(
        'm3e-card',
        `m3e-card--${variant}`,
        interactive && 'is-interactive',
        className,
      )}
    >
      {children}
    </Component>
  );
}

/**
 * M3E list. `gap` renders the contained-list grouping introduced with the
 * late-2025 list redesign: items are separated rather than divided.
 */
export function List({
  children,
  className,
  gap = false,
  ...props
}: { children: ReactNode; className?: string; gap?: boolean } & HTMLAttributes<HTMLUListElement>) {
  return (
    <ul
      {...props}
      role="list"
      className={joinClasses('m3e-list', gap && 'm3e-list--gap', className)}
    >
      {children}
    </ul>
  );
}

/**
 * M3E list item. Supports 1–3 lines of text, a leading slot and one or two
 * trailing slots. Renders as a `<button>` when interactive.
 */
export function ListItem({
  headline,
  supporting,
  trailingSupporting,
  leading,
  leadingControl,
  trailing,
  actions,
  onClick,
  selected = false,
  className,
  disabled = false,
  as = 'li',
  ariaLabel,
  ...props
}: {
  headline: ReactNode;
  supporting?: ReactNode;
  trailingSupporting?: ReactNode;
  leading?: ReactNode;
  /** Independent leading action, kept outside the row's interactive button. */
  leadingControl?: ReactNode;
  trailing?: ReactNode;
  /** Interactive actions rendered beside an interactive row, never nested in its button. */
  actions?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  disabled?: boolean;
  as?: 'li' | 'div';
  ariaLabel?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'onClick'>) {
  const content = (
    <>
      {leading && <span className="m3e-list-item__leading">{leading}</span>}
      <span className="m3e-list-item__body">
        <span className="m3e-list-item__headline">{headline}</span>
        {supporting && <span className="m3e-list-item__supporting">{supporting}</span>}
        {trailingSupporting && (
          <span className="m3e-list-item__supporting m3e-list-item__supporting--trailing">
            {trailingSupporting}
          </span>
        )}
      </span>
      {trailing && <span className="m3e-list-item__trailing">{trailing}</span>}
    </>
  );

  const classes = joinClasses(
    'm3e-list-item',
    selected && 'is-selected',
    disabled && 'is-disabled',
    onClick && 'is-interactive',
    className,
  );

  if (!onClick && !leadingControl) {
    const Component = as;
    return (
      <Component {...props} className={classes} aria-label={ariaLabel}>
        {content}
      </Component>
    );
  }

  if (!onClick && leadingControl) {
    const Component = as;
    return (
      <Component
        {...props}
        className={joinClasses(
          'm3e-list-item__wrapper',
          'has-leading-control',
          Boolean(actions) && 'has-actions',
          className,
        )}
        aria-label={ariaLabel}
      >
        <span className="m3e-list-item__leading-control">{leadingControl}</span>
        <span className={classes}>{content}</span>
        {actions && <span className="m3e-list-item__actions">{actions}</span>}
      </Component>
    );
  }

  return (
    <li
      className={joinClasses(
        'm3e-list-item__wrapper',
        Boolean(leadingControl) && 'has-leading-control',
        Boolean(actions) && 'has-actions',
      )}
    >
      {leadingControl && (
        <span className="m3e-list-item__leading-control">{leadingControl}</span>
      )}
      <button
        {...(props as HTMLAttributes<HTMLButtonElement>)}
        type="button"
        disabled={disabled}
        className={classes}
        aria-pressed={selected || undefined}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {content}
      </button>
      {actions && <span className="m3e-list-item__actions">{actions}</span>}
    </li>
  );
}

export type BadgeSize = 'small' | 'large';

/** M3E badge. */
export function Badge({
  children,
  size = 'small',
  dot = false,
  className,
}: {
  children?: ReactNode;
  size?: BadgeSize;
  dot?: boolean;
  className?: string;
}) {
  if (dot) return <span className={joinClasses('m3e-badge', 'm3e-badge--dot', className)} />;
  return (
    <span className={joinClasses('m3e-badge', `m3e-badge--${size}`, className)}>{children}</span>
  );
}

/** M3E linear progress indicator with the optional wavy expressive variant. */
export function LinearProgress({
  value,
  max = 100,
  label,
  wavy = false,
  className,
}: {
  value: number;
  max?: number;
  label: string;
  wavy?: boolean;
  className?: string;
}) {
  const percent = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={joinClasses('m3e-progress', wavy && 'm3e-progress--wavy', className)}
    >
      <span className="m3e-progress__track" />
      <span className="m3e-progress__fill" style={{ inlineSize: `${percent}%` }} />
    </div>
  );
}

/**
 * M3E loading indicator: a morphing shape for waits under five seconds. Longer
 * operations must keep using a determinate progress indicator.
 */
export function LoadingIndicator({
  label,
  visible = true,
  className,
}: {
  label: string;
  visible?: boolean;
  className?: string;
}) {
  if (!visible) return null;
  return (
    <span
      role="status"
      aria-label={label}
      className={joinClasses('m3e-loading-indicator', className)}
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <span
          key={index}
          className="m3e-loading-indicator__shape"
          style={{ '--m3e-loading-index': index } as CSSProperties}
        />
      ))}
    </span>
  );
}

export interface SnackbarAction {
  label: string;
  onAction: () => void;
}

/**
 * M3E snackbar. Rendered in a portal so it is never clipped by a page
 * container, with an optional action (undo) and auto-dismiss.
 */
export function Snackbar({
  message,
  action,
  onDismiss,
  duration = 6000,
  tone = 'default',
}: {
  message: ReactNode;
  action?: SnackbarAction;
  onDismiss?: () => void;
  duration?: number;
  tone?: 'default' | 'error';
}) {
  useEffect(() => {
    if (!onDismiss || duration <= 0) return;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [duration, message, onDismiss]);

  const content = (
    <div
      className={joinClasses('m3e-snackbar', tone === 'error' && 'm3e-snackbar--error')}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="m3e-snackbar__message">{message}</span>
      {action && (
        <button type="button" className="m3e-snackbar__action" onClick={action.onAction}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <IconButton label="关闭提示" size="xs" variant="standard" onClick={onDismiss}>
          <CloseGlyph size={18} />
        </IconButton>
      )}
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export type SheetSize = 'auto' | 'half' | 'full';

/**
 * M3E bottom sheet. Modal sheets trap focus and lock scrolling; the standard
 * variant leaves the page interactive.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  modal = true,
  size = 'auto',
  className,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  modal?: boolean;
  size?: SheetSize;
  className?: string;
  footer?: ReactNode;
}) {
  const presence = usePresence(open, SPRING_DURATION['spatial-slow']);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useScrollLock(modal && presence.state !== 'exiting');
  useFocusTrap(sheetRef, modal && presence.state !== 'exiting', onClose);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStart = useRef<number | null>(null);

  if (!presence.mounted) return null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    setDragOffset(Math.max(0, event.clientY - dragStart.current));
  };
  const onPointerUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (dragOffset > 96) onClose();
    setDragOffset(0);
  };

  const content = (
    <div
      className={joinClasses('m3e-sheet-layer', `presence-${presence.state}`)}
      role="presentation"
      onMouseDown={(event) => {
        if (modal && event.target === event.currentTarget) onClose();
      }}
    >
      {modal && <div className="m3e-sheet-scrim" aria-hidden="true" />}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={title ? titleId : undefined}
        className={joinClasses('m3e-sheet', `m3e-sheet--${size}`, className)}
        style={{ '--m3e-sheet-drag': `${dragOffset}px` } as CSSProperties}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="m3e-sheet__handle"
          role="presentation"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="m3e-sheet__grabber" />
        </div>
        {title && (
          <header className="m3e-sheet__header">
            <h2 id={titleId} className="m3e-sheet__title m3e-type-title-large">
              {title}
            </h2>
            <IconButton label="关闭" onClick={onClose}>
              <CloseGlyph size={20} />
            </IconButton>
          </header>
        )}
        <div className="m3e-sheet__body">{children}</div>
        {footer && <footer className="m3e-sheet__footer">{footer}</footer>}
      </div>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export type DialogState = PresenceState;

/**
 * M3E basic dialog. Full-screen on compact widths via CSS, with the same focus
 * and scroll behaviour as the bottom sheet.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  state,
  size = 'basic',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Overrides the internal presence state, for callers that own the lifecycle. */
  state?: DialogState;
  size?: 'basic' | 'full-screen';
}) {
  const internal = usePresence(open);
  const presence = state ? { mounted: state !== 'exiting' || open, state } : internal;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const interactive = presence.state !== 'exiting';
  useScrollLock(interactive);
  useFocusTrap(dialogRef, interactive, onClose);

  if (!presence.mounted) return null;

  const content = (
    <div
      className={joinClasses('m3e-dialog-layer', `presence-${presence.state}`)}
      role="presentation"
      aria-hidden={!interactive}
      onMouseDown={(event) => {
        if (interactive && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="m3e-dialog-scrim" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={joinClasses('m3e-dialog', `m3e-dialog--${size}`)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="m3e-dialog__header">
          <h2 id={titleId} className="m3e-dialog__title m3e-type-headline-small">
            {title}
          </h2>
          <IconButton label="关闭" onClick={onClose}>
            <CloseGlyph size={20} />
          </IconButton>
        </header>
        <div className="m3e-dialog__body">{children}</div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

/**
 * M3E confirmation dialog. Destructive confirmations use the error fill so the
 * action reads as dangerous; the non-dangerous variant uses tonal.
 */
export function ConfirmDialog({
  open = true,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  danger = true,
  error,
  busyLabel = '处理中…',
  onClose,
  onConfirm,
}: {
  open?: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  error?: ReactNode;
  busyLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<boolean | void> | boolean | void;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const confirmVariant: ButtonVariant = danger ? 'filled' : 'tonal';

  /*
   * The dialog owns the busy/error lifecycle: `onConfirm` may be async, and
   * returning `false` keeps it open. Pages already depend on that contract.
   */
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setLocalError('');
    try {
      const result = await onConfirm();
      if (result !== false) onClose();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const shownError = error || localError;

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={title}>
      <div className="m3e-confirm">
        <div className="m3e-confirm__text m3e-type-body-medium">{description}</div>
        {shownError && (
          <p className="m3e-confirm__error m3e-type-body-small" role="alert">
            {shownError}
          </p>
        )}
        <div className="m3e-confirm__actions">
          <Button variant="text" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            className={danger ? 'm3e-button--danger' : undefined}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** M3E side sheet, used for task detail on expanded widths. */
export function SideSheet({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const presence = usePresence(open, SPRING_DURATION['spatial']);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const interactive = presence.state !== 'exiting';
  useScrollLock(interactive, 'drawer-open');
  useFocusTrap(sheetRef, interactive, onClose);

  if (!presence.mounted) return null;

  const content = (
    <div
      className={joinClasses('m3e-side-sheet-layer', `presence-${presence.state}`)}
      role="presentation"
      aria-hidden={!interactive}
    >
      <div
        className="m3e-side-sheet-scrim"
        aria-hidden="true"
        onMouseDown={() => interactive && onClose()}
      />
      <aside
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={joinClasses('m3e-side-sheet', className)}
      >
        <header className="m3e-side-sheet__header">
          <h2 id={titleId} className="m3e-type-title-large">
            {title}
          </h2>
          <IconButton label="关闭" onClick={onClose}>
            <CloseGlyph size={20} />
          </IconButton>
        </header>
        <div className="m3e-side-sheet__body">{children}</div>
      </aside>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

/** M3E tooltip for icon-only affordances. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="m3e-tooltip" data-tooltip={label}>
      {children}
    </span>
  );
}

/**
 * M3E toolbar. `variant="floating"` lifts the surface; `docked` sits flush at
 * the bottom of its container. Replaces the deprecated bottom app bar.
 */
export function Toolbar({
  children,
  variant = 'docked',
  className,
  ariaLabel,
}: {
  children: ReactNode;
  variant?: 'docked' | 'floating';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className={joinClasses('m3e-toolbar', `m3e-toolbar--${variant}`, className)}
    >
      {children}
    </div>
  );
}
