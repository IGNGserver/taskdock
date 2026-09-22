import { useRef, type ComponentType, type ReactNode, type Ref } from 'react';

import { SPRING_DURATION, haptic, useFocusTrap, usePresence, useScrollLock } from './behavior.js';
import { IconButton, CloseGlyph, joinClasses } from './button.js';

export interface NavigationDestination {
  to: string;
  label: string;
  icon: ReactNode;
  /** Optional badge/count rendered next to the label. */
  badge?: ReactNode;
}

/**
 * Navigation destinations must be real links: a `<button>` would lose
 * middle-click, "open in new tab" and the link role assistive tech announces.
 * The router owns that behaviour, so the shell injects its `NavLink` here and
 * the primitives stay router-agnostic.
 */
export interface NavigationLinkProps {
  to: string;
  className?: string;
  children: ReactNode;
  'aria-current'?: 'page' | undefined;
  tabIndex?: number;
  onClick?: () => void;
}

export type NavigationLinkComponent = ComponentType<NavigationLinkProps>;

/**
 * M3E navigation bar (compact widths). Up to five destinations, each with an
 * active pill indicator behind the icon.
 */
export function NavigationBar({
  destinations,
  activeTo,
  onNavigate,
  label,
  className,
  linkAs,
}: {
  destinations: readonly NavigationDestination[];
  activeTo: string;
  onNavigate: (to: string) => void;
  label: string;
  className?: string;
  linkAs?: NavigationLinkComponent;
}) {
  const Link = linkAs;
  return (
    <nav
      aria-label={label}
      className={joinClasses('m3e-navigation-bar', className)}
      data-count={destinations.length}
    >
      {destinations.map((destination) => {
        const active = destination.to === activeTo;
        const className = joinClasses('m3e-navigation-bar__item', active && 'is-active');
        const inner = (
          <>
            <span className="m3e-navigation-bar__indicator" aria-hidden="true" />
            <span className="m3e-navigation-bar__icon">{destination.icon}</span>
            <span className="m3e-navigation-bar__label">{destination.label}</span>
            {destination.badge && (
              <span className="m3e-navigation-bar__badge">{destination.badge}</span>
            )}
          </>
        );
        if (Link)
          return (
            <Link
              key={destination.to}
              to={destination.to}
              className={className}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                haptic();
                onNavigate(destination.to);
              }}
            >
              {inner}
            </Link>
          );
        return (
          <button
            key={destination.to}
            type="button"
            aria-current={active ? 'page' : undefined}
            className={className}
            onClick={() => {
              haptic();
              onNavigate(destination.to);
            }}
          >
            {inner}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * M3E navigation rail (medium widths). Visible labels sit beside a collapsed
 * icon stack with an active indicator pill.
 */
export function NavigationRail({
  destinations,
  activeTo,
  onNavigate,
  label,
  header,
  footer,
  className,
  linkAs,
}: {
  destinations: readonly NavigationDestination[];
  activeTo: string;
  onNavigate: (to: string) => void;
  label: string;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  linkAs?: NavigationLinkComponent;
}) {
  const Link = linkAs;
  return (
    <nav aria-label={label} className={joinClasses('m3e-navigation-rail', className)}>
      {header && <div className="m3e-navigation-rail__header">{header}</div>}
      <ul className="m3e-navigation-rail__list">
        {destinations.map((destination) => {
          const active = destination.to === activeTo;
          const className = joinClasses('m3e-navigation-rail__item', active && 'is-active');
          const inner = (
            <>
              <span className="m3e-navigation-rail__indicator" aria-hidden="true" />
              <span className="m3e-navigation-rail__icon">{destination.icon}</span>
              <span className="m3e-navigation-rail__label">{destination.label}</span>
              {destination.badge && (
                <span className="m3e-navigation-rail__badge">{destination.badge}</span>
              )}
            </>
          );
          return (
            <li key={destination.to}>
              {Link ? (
                <Link
                  to={destination.to}
                  className={className}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    haptic();
                    onNavigate(destination.to);
                  }}
                >
                  {inner}
                </Link>
              ) : (
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  className={className}
                  onClick={() => {
                    haptic();
                    onNavigate(destination.to);
                  }}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {footer && <div className="m3e-navigation-rail__footer">{footer}</div>}
    </nav>
  );
}

/**
 * M3E modal navigation drawer (expanded widths and the compact overflow menu).
 * Supports the standard, modal and expanded-drawer intent through `modal`.
 */
export function NavigationDrawer({
  open,
  onClose,
  destinations,
  activeTo,
  onNavigate,
  label,
  header,
  footer,
  modal = true,
  side = 'start',
  className,
  linkAs,
}: {
  open: boolean;
  onClose: () => void;
  destinations: readonly NavigationDestination[];
  activeTo: string;
  onNavigate: (to: string) => void;
  label: string;
  header?: ReactNode;
  footer?: ReactNode;
  modal?: boolean;
  side?: 'start' | 'end';
  className?: string;
  linkAs?: NavigationLinkComponent;
}) {
  const Link = linkAs;
  const drawerRef = useRef<HTMLElement | null>(null);
  /*
   * The drawer uses the shared presence lifecycle rather than `transitionend`:
   * a transition event can be missed (interrupted, reduced motion, or no
   * property change), which would leave the drawer mounted and visible.
   */
  const presence = usePresence(open, SPRING_DURATION['spatial-slow']);
  const interactive = presence.state !== 'exiting';
  useScrollLock(modal && interactive, 'drawer-open');
  useFocusTrap(drawerRef, modal && interactive, onClose);

  if (!presence.mounted) return null;

  return (
    <div
      className={joinClasses(
        'm3e-drawer-layer',
        `presence-${presence.state}`,
        side === 'end' && 'm3e-drawer-layer--end',
        className,
      )}
      aria-hidden={!interactive}
    >
      {modal && (
        <button
          className="m3e-drawer-scrim"
          aria-label="关闭导航"
          onClick={onClose}
          tabIndex={interactive ? 0 : -1}
        />
      )}
      <aside ref={drawerRef} aria-label={label} className="m3e-drawer">
        <header className="m3e-drawer__header">
          {header}
          {modal && (
            <IconButton label="关闭侧边栏" onClick={onClose}>
              <CloseGlyph size={20} />
            </IconButton>
          )}
        </header>
        <nav aria-label={label} className="m3e-drawer__nav">
          <ul>
            {destinations.map((destination) => {
              const active = destination.to === activeTo;
              const className = joinClasses('m3e-drawer__item', active && 'is-active');
              const inner = (
                <>
                  <span className="m3e-drawer__indicator" aria-hidden="true" />
                  <span className="m3e-drawer__icon">{destination.icon}</span>
                  <span className="m3e-drawer__label">{destination.label}</span>
                  {destination.badge && (
                    <span className="m3e-drawer__badge">{destination.badge}</span>
                  )}
                </>
              );
              return (
                <li key={destination.to}>
                  {Link ? (
                    <Link
                      to={destination.to}
                      className={className}
                      aria-current={active ? 'page' : undefined}
                      tabIndex={interactive ? undefined : -1}
                      onClick={() => {
                        haptic();
                        onNavigate(destination.to);
                      }}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className={className}
                      aria-current={active ? 'page' : undefined}
                      tabIndex={interactive ? undefined : -1}
                      onClick={() => {
                        haptic();
                        onNavigate(destination.to);
                      }}
                    >
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        {footer && <div className="m3e-drawer__footer">{footer}</div>}
      </aside>
    </div>
  );
}

export type AppBarVariant = 'small' | 'medium' | 'large';

/**
 * M3E top app bar. `large` renders the flexible headline that collapses into
 * the bar on scroll; `small` keeps a single row.
 */
export function TopAppBar({
  variant = 'small',
  title,
  eyebrow,
  leading,
  actions,
  className,
  id,
}: {
  variant?: AppBarVariant;
  title: ReactNode;
  eyebrow?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <header
      id={id}
      className={joinClasses('m3e-app-bar', `m3e-app-bar--${variant}`, className)}
      data-app-bar-variant={variant}
    >
      <div className="m3e-app-bar__row">
        {leading && <div className="m3e-app-bar__leading">{leading}</div>}
        <div className="m3e-app-bar__titles">
          {eyebrow && <span className="m3e-app-bar__eyebrow m3e-type-label-medium">{eyebrow}</span>}
          <div
            className={joinClasses(
              'm3e-app-bar__title',
              variant === 'small' ? 'm3e-type-title-large' : 'm3e-type-headline-medium',
            )}
          >
            {title}
          </div>
        </div>
        {actions && <div className="m3e-app-bar__actions">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * M3E search bar. `view` opens the expanded search surface with suggestions;
 * `docked` is the inline affordance in the app bar.
 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  label,
  onSubmit,
  onClear,
  leadingIcon,
  trailing,
  variant = 'docked',
  autoFocus = false,
  className,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  onSubmit?: () => void;
  onClear?: () => void;
  leadingIcon?: ReactNode;
  trailing?: ReactNode;
  variant?: 'docked' | 'view';
  autoFocus?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <form
      className={joinClasses('m3e-search-bar', `m3e-search-bar--${variant}`, className)}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      {leadingIcon && <span className="m3e-search-bar__leading">{leadingIcon}</span>}
      <input
        ref={inputRef}
        type="search"
        className="m3e-search-bar__input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length > 0 && onClear && (
        <IconButton label="清除搜索" size="xs" variant="standard" onClick={onClear}>
          <CloseGlyph size={18} />
        </IconButton>
      )}
      {trailing && <span className="m3e-search-bar__trailing">{trailing}</span>}
    </form>
  );
}
