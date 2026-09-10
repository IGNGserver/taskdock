export type ThemeName = 'light' | 'dark';

interface DesktopThemeBridge {
  getSystemTheme: () => Promise<ThemeName>;
  onSystemThemeChanged: (listener: (theme: ThemeName) => void) => () => void;
}

declare global {
  interface Window {
    devtodoDesktop?: DesktopThemeBridge;
  }
}

const darkMediaQuery = '(prefers-color-scheme: dark)';

function normalizeTheme(value: unknown): ThemeName | null {
  return value === 'dark' || value === 'light' ? value : null;
}

export function resolveTheme(isDark: boolean): ThemeName {
  return isDark ? 'dark' : 'light';
}

export function readSystemTheme(): ThemeName {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return resolveTheme(window.matchMedia(darkMediaQuery).matches);
}

function updateThemeColor(theme: ThemeName): void {
  const themeColor = theme === 'dark' ? '#11141a' : '#f5f6f8';
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = themeColor;
}

export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  updateThemeColor(theme);
}

export function installTheme(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;

  const mediaQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia(darkMediaQuery) : null;
  const applySystemTheme = (value: unknown) => {
    const theme =
      normalizeTheme(value) ?? (mediaQuery ? resolveTheme(mediaQuery.matches) : 'light');
    applyTheme(theme);
  };

  applySystemTheme(null);
  const onMediaChange = (event: MediaQueryListEvent) =>
    applySystemTheme(event.matches ? 'dark' : 'light');
  mediaQuery?.addEventListener('change', onMediaChange);

  const desktop = window.devtodoDesktop;
  const removeDesktopListener = desktop?.onSystemThemeChanged((theme) => applySystemTheme(theme));
  if (desktop)
    void desktop
      .getSystemTheme()
      .then(applySystemTheme)
      .catch(() => undefined);

  return () => {
    mediaQuery?.removeEventListener('change', onMediaChange);
    removeDesktopListener?.();
  };
}
