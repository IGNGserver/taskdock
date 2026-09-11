(() => {
  if (
    window.Capacitor?.isNativePlatform?.() ||
    window.Capacitor?.platform === 'android' ||
    window.Capacitor?.platform === 'ios'
  ) {
    document.documentElement.classList.add('native-mobile-shell');
  }
  const nativeTheme = window.__DEVTODO_NATIVE_THEME__;
  const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
  const theme =
    nativeTheme === 'dark' || nativeTheme === 'light'
      ? nativeTheme
      : mediaQuery?.matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = theme === 'dark' ? '#0d0e13' : '#f5f2f9';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
})();
