import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';

import { haptic, useDismissibleMenu, useRovingFocus } from './behavior.js';

export type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated';
/** M3E button sizes: XS 32, S 40, M 40, L 56, XL 96. */
export type ButtonSize = 'xs' | 's' | 'm' | 'l' | 'xl';
export type ButtonShape = 'round' | 'square';

interface ButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * M3E button. The pressed state morphs the corner radius (round → squarer),
 * which is the expressive "squish" signal; it rides on the spatial spring and
 * is flattened by the reduced-motion block in `motion.css`.
 */
export function Button({
  variant = 'filled',
  size = 'm',
  shape = 'round',
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = 'button',
  onClick,
  ref,
  ...props
}: ButtonBaseProps) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={joinClasses(
        'm3e-button',
        `m3e-button--${variant}`,
        `m3e-button--${size}`,
        `m3e-button--${shape}`,
        className,
      )}
      onClick={(event) => {
        haptic();
        onClick?.(event);
      }}
    >
      {leadingIcon && <span className="m3e-button__icon">{leadingIcon}</span>}
      {children !== undefined && children !== null && (
        <span className="m3e-button__label">{children}</span>
      )}
      {trailingIcon && <span className="m3e-button__icon">{trailingIcon}</span>}
    </button>
  );
}

export type IconButtonVariant = 'standard' | 'filled' | 'tonal' | 'outlined';
export type IconButtonSize = 'xs' | 's' | 'm' | 'l' | 'xl';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name; also used as the tooltip and `title`. */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  shape?: ButtonShape;
  /** Renders the toggled/selected treatment. */
  selected?: boolean;
  children: ReactNode;
}

export function IconButton({
  label,
  variant = 'standard',
  size = 's',
  shape = 'round',
  selected = false,
  className,
  children,
  type = 'button',
  onClick,
  ...props
}: IconButtonProps) {
  /* An explicit aria-label from the call site is more specific than `label`
     (which is also the tooltip), so it must win. */
  const accessibleName = props['aria-label'] ?? label;
  delete props['aria-label'];
  return (
    <button
      {...props}
      type={type}
      aria-label={accessibleName}
      aria-pressed={props['aria-pressed'] ?? (selected ? true : undefined)}
      title={props.title ?? label}
      className={joinClasses(
        'm3e-icon-button',
        `m3e-icon-button--${variant}`,
        `m3e-icon-button--${size}`,
        `m3e-icon-button--${shape}`,
        selected && 'is-selected',
        className,
      )}
      onClick={(event) => {
        haptic();
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}

export interface ButtonGroupOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: ReactNode;
  disabled?: boolean;
}

/**
 * M3E button group: a container that coordinates width, shape and motion
 * across a set of buttons. Used for filter rows and view switchers, and it
 * implements the WAI-ARIA radiogroup keyboard contract.
 */
export function ButtonGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  variant = 'outlined',
  size = 's',
  className,
}: {
  value: T;
  options: readonly ButtonGroupOption<T>[];
  onChange: (value: T) => void;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const values = options.map((option) => option.value);
  const disabled = (candidate: T) => options.find((o) => o.value === candidate)?.disabled ?? false;
  const { setRef, onKeyDown } = useRovingFocus(values, value, onChange, disabled);

  return (
    <div
      className={joinClasses('m3e-button-group', `m3e-button-group--${variant}`, className)}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, index) => (
        <Button
          key={option.value}
          ref={setRef(index)}
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={option.disabled}
          variant={value === option.value ? 'tonal' : variant}
          size={size}
          shape="square"
          leadingIcon={option.icon}
          trailingIcon={
            option.count !== undefined ? (
              <span className="m3e-button-group__count">{option.count}</span>
            ) : undefined
          }
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

export interface MenuOption {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: ReactNode;
}

/**
 * Overflow menu anchored to its trigger. Handles ArrowUp/ArrowDown roving and
 * Escape dismissal.
 */
export function Menu({
  id,
  options,
  onSelect,
  onClose,
  align = 'end',
  label = '菜单',
  className,
}: {
  id?: string;
  options: readonly MenuOption[];
  onSelect: (id: string) => void;
  onClose: () => void;
  align?: 'start' | 'end';
  label?: string;
  /** Component-layer modifier for contextual menu placement or density. */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
  }, []);
  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      className={joinClasses('m3e-menu', `m3e-menu--${align}`, className)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
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
        <button
          key={option.id}
          type="button"
          role="menuitem"
          disabled={option.disabled}
          className={joinClasses('m3e-menu__item', option.danger && 'm3e-menu__item--danger')}
          onClick={() => onSelect(option.id)}
        >
          {option.icon && <span className="m3e-menu__icon">{option.icon}</span>}
          <span className="m3e-menu__label">{option.label}</span>
          {option.hint && <span className="m3e-menu__hint">{option.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * M3E split button: a leading primary action plus a trailing menu button whose
 * chevron rotates on activation. The two halves coordinate their shape so the
 * pair reads as one control until it is opened.
 */
export function SplitButton({
  label,
  icon,
  onPrimary,
  options,
  onSelect,
  variant = 'filled',
  size = 's',
  disabled = false,
  primaryDisabled,
  menuLabel = '更多操作',
  className,
}: {
  label: ReactNode;
  icon?: ReactNode;
  onPrimary: () => void;
  options: readonly MenuOption[];
  onSelect: (id: string) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  primaryDisabled?: boolean;
  menuLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useDismissibleMenu(open, () => setOpen(false));
  const menuId = useId();
  const toggleSize: IconButtonSize =
    size === 'xs' ? 'xs' : size === 'l' || size === 'xl' ? 'l' : 's';
  const toggleVariant: IconButtonVariant =
    variant === 'text' || variant === 'outlined'
      ? 'outlined'
      : variant === 'elevated'
        ? 'tonal'
        : variant;

  return (
    <div className={joinClasses('m3e-split-button', `m3e-split-button--${size}`, className)}>
      <Button
        variant={variant}
        size={size}
        shape="square"
        leadingIcon={icon}
        disabled={disabled || primaryDisabled}
        onClick={onPrimary}
        className="m3e-split-button__primary"
      >
        {label}
      </Button>
      <div ref={containerRef} className="m3e-split-button__trailing">
        <IconButton
          label={menuLabel}
          variant={toggleVariant}
          size={toggleSize}
          shape="square"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
          className={joinClasses('m3e-split-button__toggle', open && 'is-open')}
        >
          <ChevronGlyph />
        </IconButton>
        {open && (
          <Menu
            id={menuId}
            options={options}
            onSelect={(id) => {
              setOpen(false);
              onSelect(id);
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** Chevron drawn inline so the primitives stay icon-library agnostic. */
export function ChevronGlyph({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={direction === 'right' ? 'm3e-chevron--right' : undefined}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CloseGlyph({ size = 24 }: { size?: number }) {
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
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export type FabSize = 's' | 'm' | 'l';
export type FabVariant = 'primary' | 'secondary' | 'tertiary' | 'surface';

interface FabBaseProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  label?: ReactNode;
  icon: ReactNode;
  size?: FabSize;
  variant?: FabVariant;
  /** Required when the FAB has no visible text label. */
  ariaLabel?: string;
}

/**
 * Floating action button. `size="l"` renders the M3E 96dp variant; supplying
 * `label` switches to the extended form.
 */
export function Fab({
  label,
  icon,
  size = 'm',
  variant = 'primary',
  className,
  ariaLabel,
  type = 'button',
  ...props
}: FabBaseProps) {
  return (
    <button
      {...props}
      type={type}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      className={joinClasses(
        'm3e-fab',
        `m3e-fab--${size}`,
        `m3e-fab--${variant}`,
        label ? 'm3e-fab--extended' : 'm3e-fab--round',
        className,
      )}
    >
      <span className="m3e-fab__icon">{icon}</span>
      {label && <span className="m3e-fab__label">{label}</span>}
    </button>
  );
}

export interface FabMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
}

/**
 * M3E FAB menu: replaces speed-dial and stacked mini-FABs. Holds 2–6 related
 * actions, closes with a contrasting close button, and staggers item entry via
 * the `--m3e-fab-menu-index` custom property.
 */
export function FabMenu({
  items,
  onSelect,
  label,
  open,
  onOpenChange,
  icon,
}: {
  items: readonly FabMenuItem[];
  onSelect: (id: string) => void;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onOpenChange, open]);

  const visible = items.slice(0, 6);

  return (
    <div
      ref={containerRef}
      className={joinClasses('m3e-fab-menu', open && 'is-open')}
      aria-label={label}
    >
      <ul className="m3e-fab-menu__list" aria-hidden={!open} role="menu" aria-label="创建菜单">
        {visible.map((item, index) => (
          <li
            key={item.id}
            role="none"
            className="m3e-fab-menu__row"
            style={{ '--m3e-fab-menu-index': index } as CSSProperties}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={open ? undefined : -1}
              className="m3e-fab-menu__item"
              onClick={() => {
                haptic();
                onOpenChange(false);
                onSelect(item.id);
              }}
            >
              <span className="m3e-fab-menu__item-icon">{item.icon}</span>
              <span className="m3e-fab-menu__item-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <Fab
        ariaLabel={open ? '关闭创建菜单' : label}
        aria-expanded={open}
        icon={open ? <CloseGlyph /> : icon}
        variant={open ? 'secondary' : 'primary'}
        onClick={() => {
          haptic();
          onOpenChange(!open);
        }}
      />
    </div>
  );
}

export function joinClasses(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
