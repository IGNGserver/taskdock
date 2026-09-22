import type {
  ComponentProps,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEventHandler,
  ReactNode,
} from 'react';
import { Link, NavLink } from 'react-router-dom';

import { Button, IconButton, joinClasses, type ButtonVariant } from './button.js';
import { haptic } from './behavior.js';
import { Card, LoadingIndicator } from './container.js';
import { CheckGlyph, TextField } from './field.js';

/**
 * A date-aware field that keeps the native date picker, keyboard behaviour and
 * form semantics while presenting it through the M3 Expressive field surface.
 */
export function DateField({ className, ...props }: Omit<ComponentProps<typeof TextField>, 'type'>) {
  return <TextField {...props} type="date" className={joinClasses('m3e-date-field', className)} />;
}

/**
 * Compact capture input for creating an item without opening a full editor.
 * It deliberately owns the native input so pages never have to hand-roll a
 * pseudo-search field for a creation flow.
 */
export function CaptureField({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  leading,
  trailing,
  error,
  disabled = false,
  autoFocus = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  placeholder: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <form
      className={joinClasses('m3e-capture-field', className, Boolean(error) && 'has-error')}
      onSubmit={onSubmit}
    >
      {leading && <span className="m3e-capture-field__leading">{leading}</span>}
      <input
        className="m3e-capture-field__input"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        enterKeyHint="done"
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <span className="m3e-capture-field__trailing">{trailing}</span>
      {error && (
        <span className="m3e-capture-field__error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

/** Contextual, persistent feedback surface — not a transient toast. */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const urgent = tone === 'warning' || tone === 'error';
  return (
    <div
      className={joinClasses('m3e-alert', `m3e-alert--${tone}`, className)}
      role={urgent ? 'alert' : 'status'}
    >
      <span className="m3e-alert__marker" aria-hidden="true" />
      <div className="m3e-alert__copy">
        {title && <strong className="m3e-alert__title">{title}</strong>}
        <span className="m3e-alert__message">{children}</span>
      </div>
      {action && <span className="m3e-alert__action">{action}</span>}
    </div>
  );
}

/** M3E empty state with a clear next action instead of a bare placeholder. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <Card
      variant="outlined"
      className={joinClasses('m3e-empty-state', compact && 'm3e-empty-state--compact', className)}
    >
      {icon && <span className="m3e-empty-state__icon">{icon}</span>}
      <div className="m3e-empty-state__copy">
        <strong className="m3e-empty-state__title">{title}</strong>
        {description && <span className="m3e-empty-state__description">{description}</span>}
      </div>
      {action && <div className="m3e-empty-state__action">{action}</div>}
    </Card>
  );
}

/** Semantic loading state paired with the expressive morphing indicator. */
export function LoadingState({
  label,
  description,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={joinClasses('m3e-loading-state', className)} role="status" aria-live="polite">
      <LoadingIndicator label={typeof label === 'string' ? label : '正在加载'} />
      <div>
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
    </div>
  );
}

/**
 * M3E expandable disclosure. It keeps the browser's robust details/summary
 * keyboard semantics inside the component boundary while adding a state layer.
 */
export function Disclosure({
  title,
  description,
  leading,
  children,
  className,
  defaultOpen = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={joinClasses('m3e-disclosure', className)} open={defaultOpen}>
      <summary className="m3e-disclosure__summary">
        {leading && <span className="m3e-disclosure__leading">{leading}</span>}
        <span className="m3e-disclosure__copy">
          <strong>{title}</strong>
          {description && <small>{description}</small>}
        </span>
        <span className="m3e-disclosure__chevron" aria-hidden="true" />
      </summary>
      <div className="m3e-disclosure__body">{children}</div>
    </details>
  );
}

/** Settings grouping that preserves a clear destructive-action hierarchy. */
export function DestructiveSection({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card variant="outlined" className={joinClasses('m3e-destructive-section', className)}>
      <div className="m3e-destructive-section__header">
        <div>
          <strong>{title}</strong>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="m3e-destructive-section__body">{children}</div>
    </Card>
  );
}

/** A calendar-grid cell with M3 Expressive shape, state layer and selection. */
export function CalendarDayCell({
  label,
  selected = false,
  today = false,
  muted = false,
  disabled = false,
  onClick,
  onKeyDown,
  indicator,
  className,
  ariaLabel,
  tabIndex,
}: {
  label: string;
  selected?: boolean;
  today?: boolean;
  muted?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  indicator?: ReactNode;
  className?: string;
  /** Full local-date label for assistive technology. */
  ariaLabel?: string;
  tabIndex?: number;
}) {
  return (
    <button
      type="button"
      className={joinClasses(
        'm3e-calendar-day',
        selected && 'is-selected',
        today && 'is-today',
        muted && 'is-muted',
        className,
      )}
      aria-pressed={selected}
      aria-current={today ? 'date' : undefined}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span>{label}</span>
      {indicator && <span className="m3e-calendar-day__indicator">{indicator}</span>}
    </button>
  );
}

/** Small action affordance used inside dense contextual feedback. */
export function AlertAction({
  label,
  onClick,
  tone = 'text',
}: {
  label: string;
  onClick: () => void;
  tone?: ButtonVariant;
}) {
  return (
    <Button variant={tone} size="s" onClick={onClick}>
      {label}
    </Button>
  );
}

/** Lightweight close affordance for patterns that need a labelled icon action. */
export function PatternCloseButton({
  label = '关闭',
  onClick,
}: {
  label?: string;
  onClick: () => void;
}) {
  return (
    <IconButton label={label} onClick={onClick}>
      ×
    </IconButton>
  );
}

/**
 * Router bridge used exclusively by M3E navigation primitives. It retains real
 * link semantics (including modified-click/new-tab behavior), while a normal
 * primary activation delegates to the shell's navigation callback so drawers
 * can close and native haptics can run before route transition.
 */
export function RouterLinkAdapter({
  to,
  className,
  children,
  'aria-current': ariaCurrent,
  tabIndex,
  onClick,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  'aria-current'?: 'page' | undefined;
  tabIndex?: number;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      className={className}
      aria-current={ariaCurrent}
      tabIndex={tabIndex}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.defaultPrevented
        )
          return;
        if (onClick) {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </Link>
  );
}

export type NavigationCardVariant = 'card' | 'context' | 'timeline' | 'account' | 'inline';

/**
 * A router-backed M3E navigation surface. Business pages supply only content
 * slots; its state layer, focus ring, shape morph and selected treatment live
 * in the component layer.
 */
export function NavigationCard({
  to,
  children,
  variant = 'card',
  className,
  ariaLabel,
  title,
  onClick,
}: {
  to: string;
  children: ReactNode;
  variant?: NavigationCardVariant;
  className?: string;
  ariaLabel?: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <NavLink
      to={to}
      aria-label={ariaLabel}
      title={title}
      className={({ isActive }) =>
        joinClasses(
          'm3e-navigation-card',
          `m3e-navigation-card--${variant}`,
          isActive && 'is-active',
          className,
        )
      }
      onClick={(event) => {
        onClick?.(event);
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          !event.defaultPrevented
        ) {
          haptic();
        }
      }}
    >
      {children}
    </NavLink>
  );
}

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

/** A compact visual state token shared by task rows across every web surface. */
export function TaskStatusIndicator({ status }: { status: TaskStatus }) {
  return (
    <span
      className={joinClasses('m3e-task-status-indicator', `is-${status.toLowerCase()}`)}
      aria-hidden="true"
    >
      {status === 'DONE' ? (
        <CheckGlyph size={18} />
      ) : status === 'IN_PROGRESS' ? (
        <span className="m3e-task-status-indicator__progress" />
      ) : (
        <span className="m3e-task-status-indicator__todo" />
      )}
    </span>
  );
}

/**
 * Task-state action with an expressive status morph. The action remains a
 * labelled button while its state representation can be reused noninteractively
 * in lists and detail views.
 */
export function TaskStatusButton({
  status,
  label,
  onClick,
  disabled = false,
  className,
}: {
  status: TaskStatus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <IconButton
      label={label}
      variant="tonal"
      size="m"
      selected={status !== 'TODO'}
      disabled={disabled}
      className={joinClasses('m3e-task-status-button', `is-${status.toLowerCase()}`, className)}
      onClick={onClick}
    >
      <TaskStatusIndicator status={status} />
    </IconButton>
  );
}

/**
 * Primary task-row affordance. It deliberately constrains a row's main action
 * to the M3E button surface instead of allowing a page to create a bespoke
 * pseudo-button for every list context.
 */
export function TaskRowAction({
  className,
  children,
  busy = false,
  disabled = false,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'shape' | 'className'> & {
  /** Keeps pending mutations within the component state layer instead of a page override. */
  busy?: boolean;
  className?: string;
}) {
  return (
    <Button
      {...props}
      variant="text"
      shape="square"
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={joinClasses('m3e-task-row-action', busy && 'is-busy', className)}
    >
      {children}
    </Button>
  );
}
