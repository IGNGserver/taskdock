(() => {
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
  const themeColor = theme === 'dark' ? '#11141a' : '#f5f6f8';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
})();
