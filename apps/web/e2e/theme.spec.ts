import { expect, test } from '@playwright/test';

test('follows the browser color scheme at startup and during runtime', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/login');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 246, 248)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 20, 26)');
});
