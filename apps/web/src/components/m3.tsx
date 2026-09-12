import {
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export type M3ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text';
export type M3ButtonSize = 'small' | 'medium' | 'large';

export type M3SelectSize = 'small' | 'medium' | 'large';

export function M3Select({
  size = 'medium',
  className,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: M3SelectSize }) {
  return (
    <select {...props} className={`m3-select m3-select-${size}${className ? ` ${className}` : ''}`}>
      {children}
    </select>
  );
}

interface M3ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: M3ButtonVariant;
  size?: M3ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function M3Button({
  variant = 'filled',
  size = 'medium',
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = 'button',
  ...props
}: M3ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`m3-button m3-button-${variant} m3-button-${size}${className ? ` ${className}` : ''}`}
    >
      {leadingIcon}
      <span>{children}</span>
      {trailingIcon}
    </button>
  );
}

interface M3IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'small' | 'medium' | 'large';
  variant?: 'standard' | 'filled' | 'tonal' | 'outlined';
}

export function M3IconButton({
  label,
  size = 'medium',
  variant = 'standard',
  className,
  children,
  type = 'button',
  ...props
}: M3IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      className={`m3-icon-button m3-icon-button-${variant} m3-icon-button-${size}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

export interface M3SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: ReactNode;
  disabled?: boolean;
}

export function M3SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly M3SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveFocus = (index: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const nextIndex = (index + offset * direction + options.length) % options.length;
      if (!options[nextIndex]?.disabled) {
        buttonRefs.current[nextIndex]?.focus();
        onChange(options[nextIndex]!.value);
        return;
      }
    }
  };
  return (
    <div className="m3-segmented-control" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttonRefs.current[index] = element;
          }}
          type="button"
          role="radio"
          tabIndex={value === option.value ? 0 : -1}
          aria-checked={value === option.value}
          disabled={option.disabled}
          className={value === option.value ? 'selected' : ''}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(index, 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(index, -1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              const first = options.findIndex((candidate) => !candidate.disabled);
              if (first >= 0) {
                buttonRefs.current[first]?.focus();
                onChange(options[first]!.value);
              }
            } else if (event.key === 'End') {
              event.preventDefault();
              let last = -1;
              for (let optionIndex = options.length - 1; optionIndex >= 0; optionIndex -= 1) {
                if (!options[optionIndex]?.disabled) {
                  last = optionIndex;
                  break;
                }
              }
              if (last >= 0) {
                buttonRefs.current[last]?.focus();
                onChange(options[last]!.value);
              }
            }
          }}
        >
          <span>{option.label}</span>
          {option.count !== undefined && <span className="m3-segment-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function M3Chip({
  children,
  selected = false,
  onClick,
  leadingIcon,
  className,
  ...props
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  leadingIcon?: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const classes = `m3-chip${selected ? ' selected' : ''}${onClick ? ' interactive' : ''}${className ? ` ${className}` : ''}`;
  if (!onClick) {
    return (
      <span className={classes} {...(props as HTMLAttributes<HTMLSpanElement>)}>
        {leadingIcon}
        <span>{children}</span>
      </span>
    );
  }
  return (
    <button {...props} type="button" className={classes} aria-pressed={selected} onClick={onClick}>
      {leadingIcon}
      <span>{children}</span>
    </button>
  );
}
