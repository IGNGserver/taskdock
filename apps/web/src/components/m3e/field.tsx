import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import { haptic, useDismissibleMenu } from './behavior.js';
import { joinClasses } from './button.js';

export type FieldVariant = 'outlined' | 'filled';

interface TextFieldBaseProps {
  label: string;
  variant?: FieldVariant;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  helperText?: ReactNode;
  error?: ReactNode;
  /** Hides the visible label but keeps it for assistive tech. */
  hideLabel?: boolean;
  className?: string;
}

/**
 * M3E text field. The floating label is driven by `:focus-within` and the
 * `has-value` class rather than by JS, so it stays correct when the value is
 * changed programmatically.
 */
export function TextField({
  label,
  variant = 'outlined',
  leadingIcon,
  trailingIcon,
  helperText,
  error,
  hideLabel = false,
  className,
  id,
  value,
  ...props
}: TextFieldBaseProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const helperId = `${inputId}-helper`;
  const hasValue = value !== undefined && value !== null && String(value).length > 0;
  const describedBy = helperText || error ? helperId : undefined;

  return (
    <div
      className={joinClasses(
        'm3e-field',
        `m3e-field--${variant}`,
        Boolean(error) && 'm3e-field--error',
        Boolean(props.disabled) && 'm3e-field--disabled',
        Boolean(hasValue) && 'has-value',
        className,
      )}
    >
      <div className="m3e-field__box">
        {leadingIcon && (
          <span className="m3e-field__icon m3e-field__icon--leading">{leadingIcon}</span>
        )}
        <input
          {...props}
          id={inputId}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          placeholder={props.placeholder ?? ' '}
          className="m3e-field__input"
        />
        <label
          htmlFor={inputId}
          className={joinClasses('m3e-field__label', hideLabel && 'm3e-visually-hidden')}
        >
          {label}
        </label>
        {trailingIcon && (
          <span className="m3e-field__icon m3e-field__icon--trailing">{trailingIcon}</span>
        )}
      </div>
      {(helperText || error) && (
        <p className="m3e-field__helper" id={helperId} role={error ? 'alert' : undefined}>
          {error ?? helperText}
        </p>
      )}
    </div>
  );
}

/** Multiline M3E text field. */
export function TextArea({
  label,
  variant = 'outlined',
  helperText,
  error,
  hideLabel = false,
  className,
  id,
  value,
  ...props
}: TextFieldBaseProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const helperId = `${fieldId}-helper`;
  const hasValue = value !== undefined && value !== null && String(value).length > 0;

  return (
    <div
      className={joinClasses(
        'm3e-field',
        `m3e-field--${variant}`,
        'm3e-field--multiline',
        Boolean(error) && 'm3e-field--error',
        Boolean(props.disabled) && 'm3e-field--disabled',
        Boolean(hasValue) && 'has-value',
        className,
      )}
    >
      <div className="m3e-field__box">
        <textarea
          {...props}
          id={fieldId}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={helperText || error ? helperId : undefined}
          placeholder={props.placeholder ?? ' '}
          className="m3e-field__input m3e-field__input--multiline"
        />
        <label
          htmlFor={fieldId}
          className={joinClasses('m3e-field__label', hideLabel && 'm3e-visually-hidden')}
        >
          {label}
        </label>
      </div>
      {(helperText || error) && (
        <p className="m3e-field__helper" id={helperId} role={error ? 'alert' : undefined}>
          {error ?? helperText}
        </p>
      )}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * M3E exposed dropdown. The trigger is a real `<button>` with `role="combobox"`
 * while the popup carries `role="listbox"`, and a visually hidden native
 * `<select>` mirrors the value so existing form semantics and tests keep
 * working.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  variant = 'outlined',
  disabled = false,
  name,
  className,
  id,
}: {
  label: string;
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  variant?: FieldVariant;
  disabled?: boolean;
  name?: string;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useDismissibleMenu(open, () => setOpen(false));
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const list = containerRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    (list ?? containerRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [containerRef, open]);

  return (
    <div
      ref={containerRef}
      className={joinClasses(
        'm3e-select',
        `m3e-field--${variant}`,
        disabled && 'm3e-select--disabled',
        className,
      )}
    >
      <span className="m3e-select__label" id={`${listId}-label`}>
        {label}
      </span>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${listId}-label`}
        disabled={disabled}
        className="m3e-select__trigger"
        onClick={() => {
          haptic();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
          }
        }}
      >
        <span className="m3e-select__value">{selected?.label ?? ''}</span>
        <ChevronDown />
      </button>
      {/* Keeps native form/value semantics available to tests and autofill. */}
      <select
        name={name}
        value={value}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="m3e-visually-hidden"
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={`${listId}-label`}
          className="m3e-select__popup"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              buttonRef.current?.focus();
              return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = Array.from(
              containerRef.current?.querySelectorAll<HTMLElement>(
                '[role="option"]:not([disabled])',
              ) ?? [],
            );
            if (items.length === 0) return;
            const index = items.indexOf(document.activeElement as HTMLElement);
            const next =
              event.key === 'ArrowDown'
                ? items[(index + 1) % items.length]
                : items[(index - 1 + items.length) % items.length];
            next?.focus();
          }}
        >
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={joinClasses('m3e-select__option', option.value === value && 'is-selected')}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              <span className="m3e-select__check" aria-hidden="true">
                {option.value === value ? <CheckGlyph /> : null}
              </span>
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Kept for call sites that pass a native `select`; delegates to `Select`. */
export function SelectField({
  label,
  value,
  onChange,
  children,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const options: SelectOption[] = [];
  const visit = (nodes: ReactNode) => {
    if (Array.isArray(nodes)) {
      nodes.forEach(visit);
      return;
    }
    if (nodes && typeof nodes === 'object' && 'props' in (nodes as never)) {
      const element = nodes as { props?: { value?: unknown; children?: ReactNode } };
      const props = element.props;
      if (props && props.value !== undefined) {
        options.push({
          value: String(props.value),
          label: typeof props.children === 'string' ? props.children : String(props.value),
        });
      }
    }
  };
  visit(children);
  return (
    <Select
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      className={className}
      disabled={disabled}
    />
  );
}

export function CheckGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function ChevronDown({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export type ChipKind = 'assist' | 'filter' | 'input' | 'suggestion';

/**
 * M3E chip. `filter` maps to an `aria-pressed` toggle, `input` to a removable
 * value, and `assist`/`suggestion` to plain actions.
 */
export function Chip({
  kind = 'assist',
  label,
  selected = false,
  onClick,
  onRemove,
  leadingIcon,
  className,
  disabled = false,
}: {
  kind?: ChipKind;
  label: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  leadingIcon?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const interactive = Boolean(onClick) || kind === 'filter' || kind === 'input';
  const classes = joinClasses(
    'm3e-chip',
    `m3e-chip--${kind}`,
    selected && 'is-selected',
    interactive && 'is-interactive',
    className,
  );

  const content = (
    <>
      {kind === 'filter' && (
        <span className="m3e-chip__check" aria-hidden="true">
          <CheckGlyph size={16} />
        </span>
      )}
      {leadingIcon && <span className="m3e-chip__icon">{leadingIcon}</span>}
      <span className="m3e-chip__label">{label}</span>
      {kind === 'input' && onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label={typeof label === 'string' ? `移除 ${label}` : '移除'}
          className="m3e-chip__remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onRemove();
            }
          }}
        >
          <CloseGlyphSmall />
        </span>
      )}
    </>
  );

  if (!interactive) {
    return (
      <span className={classes}>
        {leadingIcon && <span className="m3e-chip__icon">{leadingIcon}</span>}
        <span className="m3e-chip__label">{label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      aria-pressed={kind === 'filter' ? selected : undefined}
      onClick={() => {
        haptic();
        onClick?.();
      }}
    >
      {content}
    </button>
  );
}

function CloseGlyphSmall() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** M3E switch. */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  helperText,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  helperText?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={joinClasses('m3e-switch', disabled && 'is-disabled')}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className="m3e-switch__track"
        onClick={() => {
          haptic();
          onChange(!checked);
        }}
      >
        <span className="m3e-switch__thumb" />
      </button>
      <label htmlFor={id} className="m3e-switch__label">
        {label}
        {helperText && <small className="m3e-switch__helper">{helperText}</small>}
      </label>
    </div>
  );
}
