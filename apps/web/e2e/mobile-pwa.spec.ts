import { expect, test, type Page } from '@playwright/test';

// This suite uses the real API fixture and real IndexedDB. Enable E2E_PWA=1
// to serve the production build and exercise the actual service worker.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'allow' });
test.skip(process.env['E2E_REAL'] !== '1', 'requires the isolated real API fixture');

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(process.env['E2E_USERNAME'] ?? 'e2e-real-owner');
  await page.getByLabel('密码', { exact: true }).fill('e2e-real-password-change-me');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
  await expect(page.locator('.inline-error')).toHaveCount(0);
}

async function assertFits(page: Page) {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [
      ...document.querySelectorAll<HTMLElement>(
        '.page-wrap, .page, .page-section, .auth-page, [role="dialog"]',
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .filter(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.getBoundingClientRect().right > viewportWidth + 1,
      )
      .map((element) => ({
        className: element.className,
        width: element.clientWidth,
        scroll: element.scrollWidth,
        overflowingChildren: [...element.querySelectorAll<HTMLElement>('*')]
          .filter((child) => child.scrollWidth > child.clientWidth + 1)
          .slice(0, 12)
          .map((child) => ({
            tag: child.tagName,
            className: child.className,
            width: child.clientWidth,
            scroll: child.scrollWidth,
            text: child.innerText.slice(0, 48),
          })),
      }));
  });
  expect(overflow).toEqual([]);
}

for (const width of [320, 390, 430]) {
  test(`mobile ${width}: capture, edit, navigation and long forms remain reachable`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    if (width === 430) await page.emulateMedia({ colorScheme: 'dark' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page);
    await assertFits(page);
    await expect(page.getByRole('heading', { name: '今天要做' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`today-${width}.png`) });

    await page.getByRole('button', { name: '打开创建菜单' }).click();
    await page.getByRole('menuitem', { name: '新建任务' }).click();
    const capture = page.getByRole('dialog', { name: '快速添加', exact: true });
    const title = `手机验收 ${width} ${Date.now()}`;
    await capture.getByLabel('任务标题').fill(title);
    await capture.getByRole('button', { name: '创建', exact: true }).click();
    await expect(capture).toBeHidden();
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    // Task detail must open over the list, not below it, and keep touch scrolling enabled.
    await page.getByText(title, { exact: true }).click();
    const detail = page.getByRole('dialog');
    await expect(detail).toBeVisible();
    await expect(detail.getByLabel('任务标题')).toHaveValue(title);
    expect(await page.evaluate(() => getComputedStyle(document.body).touchAction)).not.toBe('none');
    expect(await detail.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe(
      'none',
    );
    await detail.getByLabel('任务备注').fill('手机编辑后应保留的备注');
    await detail.getByRole('heading', { name: '备注', exact: true }).click();
    await expect(detail.locator('.error-banner')).toHaveCount(0);
    await assertFits(page);
    await page.screenshot({ path: info.outputPath(`detail-${width}.png`) });
    const scrollBody = detail.locator('.m3e-sheet__body');
    await scrollBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(detail).toBeHidden();
    await page.getByText(title, { exact: true }).click();
    await expect(detail.getByLabel('任务备注')).toHaveValue('手机编辑后应保留的备注');
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(detail).toBeHidden();

    // All product routes retain the app shell and fit a narrow viewport.
    for (const route of [
      '/tree',
      '/tasks',
      '/workflows',
      '/time',
      '/time/calendar',
      '/time/events',
      '/archive',
      '/settings',
      '/more',
    ]) {
      if (route === '/more' || route === '/time') {
        await page
          .getByRole('navigation', { name: '移动导航' })
          .getByRole('link', { name: route === '/more' ? '更多' : '计划', exact: true })
          .click();
      } else {
        await page.getByRole('button', { name: '打开侧边栏' }).click();
        const drawer = page.getByRole('complementary', { name: '移动侧边栏' });
        await drawer.locator(`a.m3e-drawer__item[href="${route}"]`).click();
        await expect(drawer).toBeHidden();
      }
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
      await expect(page.locator('.page-header')).toBeVisible();
      await assertFits(page);
      if (route === '/time/calendar')
        await page.screenshot({ path: info.outputPath(`calendar-${width}.png`) });
      if (['/tasks', '/archive', '/settings'].includes(route))
        await expect(
          page.getByRole('navigation', { name: '移动导航' }).getByRole('link', { name: '更多' }),
        ).toHaveAttribute('aria-current', 'page');
    }
    expect(errors).toEqual([]);
  });
}

test('production PWA caches assets and can reopen the workspace offline', async ({
  page,
  context,
}) => {
  test.skip(process.env['E2E_PWA'] !== '1', 'requires a production build with the service worker');
  await login(page);
  const snackbar = page.locator('.m3e-snackbar');
  await expect(snackbar).toBeVisible();
  const snackbarOverlapsControls = await page.evaluate(() => {
    const notice = document.querySelector('.m3e-snackbar')?.getBoundingClientRect();
    if (!notice) return true;
    const overlaps = (control: DOMRect) =>
      notice.left < control.right &&
      notice.right > control.left &&
      notice.top < control.bottom &&
      notice.bottom > control.top;
    const controls = [
      ...document.querySelectorAll('.m3e-navigation-bar, button[aria-label="打开创建菜单"]'),
    ];
    return {
      overlaps: controls.some((element) => overlaps(element.getBoundingClientRect())),
      notice: { top: notice.top, bottom: notice.bottom, left: notice.left, right: notice.right },
      controls: controls.map((element) => {
        const control = element.getBoundingClientRect();
        return { className: element.className, top: control.top, bottom: control.bottom };
      }),
    };
  });
  expect(snackbarOverlapsControls).toMatchObject({ overlaps: false });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/today');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '今天要做' })).toBeVisible();
  const offlineTitle = `离线记录 ${Date.now()}`;
  await page.getByLabel('快速创建任务').fill(offlineTitle);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByText(offlineTitle, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(offlineTitle, { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('.inline-error')).toHaveCount(0);
  await assertFits(page);
});

test('landscape and enlarged text keep navigation and forms within reach', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 780, height: 390 });
  await assertFits(page);
  await page.getByRole('button', { name: '快速添加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '快速添加' });
  await expect(dialog).toBeVisible();
  await assertFits(page);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '日历', exact: true })
    .click();
  await assertFits(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '24px';
  });
  await assertFits(page);
});
