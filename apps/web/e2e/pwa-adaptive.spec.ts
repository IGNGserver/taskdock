import { expect, test, type Page } from '@playwright/test';

test.beforeEach(() => {
  test.skip(
    !['chromium', 'webkit'].includes(test.info().project.name),
    'adaptive matrix covers Chromium and WebKit',
  );
});

async function loginFixture(page: Page) {
  // Keep mocked HTTP sessions independent from any live fixture on port 3000.
  await page.routeWebSocket('**/api/v2/ws**', () => undefined);
  const user = {
    id: '00000000-0000-7000-8000-000000000901',
    username: 'pwa-layout-owner',
    createdAt: '2026-10-25T10:00:00.000Z',
  };
  const settings = {
    ownerId: user.id,
    timezone: 'Asia/Shanghai',
    weekStartsOn: 1,
    defaultCaptureTarget: 'ROOT',
    version: 1,
    updatedAt: user.createdAt,
  };
  const capabilities = { syncProtocolVersion: 2, websocket: false, offline: true };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [] };
    if (path.endsWith('/bootstrap/status')) body = { initialized: true };
    else if (path.endsWith('/auth/refresh')) body = { accessToken: 'pwa-test-token' };
    else if (path.endsWith('/me')) body = { user, settings, capabilities };
    else if (/\/sync\/(preview|bootstrap)/.test(path) || path.endsWith('/today'))
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"code":"NOT_FOUND"}',
      });
    else if (path.endsWith('/sync/snapshot'))
      body = {
        folders: [],
        tasks: [],
        notes: [],
        taskSteps: [],
        timePoints: [],
        placements: [],
        workflows: [],
        workflowStages: [],
        workflowTaskMemberships: [],
        settings,
        cursor: '0',
      };
    else if (path.endsWith('/sync/pull')) body = { changes: [], nextCursor: '0', hasMore: false };
    else if (path.endsWith('/sync/push')) body = { protocolVersion: 2, results: [] };
    else if (path.endsWith('/settings')) body = settings;
    else if (path.endsWith('/devices')) body = [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

for (const viewport of [
  { width: 390, height: 844, phone: true },
  { width: 844, height: 390, phone: true },
  { width: 600, height: 900, phone: false },
  { width: 834, height: 1194, phone: false },
  { width: 1366, height: 1024, phone: false },
]) {
  test.describe(`adaptive PWA ${viewport.width}x${viewport.height}`, () => {
    test.use({
      viewport,
      hasTouch: true,
      reducedMotion: 'reduce',
      userAgent: viewport.phone
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15',
    });
    test('keeps navigation and all main routes usable with installation help', async ({
      page,
    }, info) => {
      test.skip(process.env['E2E_REAL'] === '1', 'uses a public API fixture');
      await loginFixture(page);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const route of [
        '/today',
        '/tree',
        '/workflows',
        '/time/calendar',
        '/time/events',
        '/settings',
        '/more',
      ]) {
        await page.goto(route);
        await expect(page.locator('.app-frame')).toBeVisible();
        await expect(
          page.locator(viewport.phone ? '.is-phone-frame' : '.is-tablet-frame'),
        ).toBeVisible();
        await expect(
          page.locator(viewport.phone ? '.m3e-navigation-bar' : '.m3e-navigation-rail'),
        ).toBeVisible();
        await expect(page.locator('.page-header')).toBeVisible();
        const overflow = await page.evaluate(() => {
          const root = document.documentElement;
          const page = document.querySelector('.page-wrap');
          const bar = document.querySelector('.m3e-app-bar');
          return {
            appBar: !!bar && bar.scrollWidth > bar.clientWidth + 1,
            document: root.scrollWidth > root.clientWidth + 1,
            page: !!page && page.scrollWidth > page.clientWidth + 1,
          };
        });
        expect(overflow).toEqual({ appBar: false, document: false, page: false });
        if (route === '/today' || route === '/time/calendar')
          await page.screenshot({ path: info.outputPath(route.replaceAll('/', '-') + '.png') });
      }
      if (!viewport.phone) {
        await page.getByRole('button', { name: '退出登录', exact: true }).click();
        const logout = page.getByRole('dialog', { name: '退出登录', exact: true });
        await expect(logout).toBeVisible();
        await logout.getByRole('button', { name: '取消', exact: true }).click();
        await expect(logout).toBeHidden();
      }
      await page.getByRole('button', { name: '安装 TaskDock', exact: true }).click();
      const help = page.getByRole('dialog', { name: '安装与离线使用' });
      await expect(help).toBeVisible();
      await expect(help.getByText(/Safari 分享菜单/)).toBeVisible();
      await help.getByRole('button', { name: '完成' }).click();
      await expect(help).toBeHidden();
      expect(errors).toEqual([]);
    });
  });
}

test('installation help remains available before login without an install event', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"code":"AUTH_SESSION_REVOKED"}',
    }),
  );
  await page.route('**/api/v1/bootstrap/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"initialized":true}' }),
  );
  await page.goto('/login');
  await page.getByRole('button', { name: '安装 TaskDock', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '安装与离线使用' })).toBeVisible();
});
test('uses a captured Chromium installation event only after user action', async ({ page }) => {
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"code":"AUTH_SESSION_REVOKED"}',
    }),
  );
  await page.route('**/api/v1/bootstrap/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"initialized":true}' }),
  );
  await page.goto('/login');
  await page.getByRole('button', { name: '安装 TaskDock', exact: true }).waitFor();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        document.documentElement.dataset.installPrompted = 'yes';
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    window.dispatchEvent(event);
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-install-prompted');
  await page.getByRole('button', { name: '安装 TaskDock', exact: true }).click();
  const help = page.getByRole('dialog', { name: '安装与离线使用' });
  await help.getByRole('button', { name: '安装 TaskDock', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-install-prompted', 'yes');
  await expect(help.getByText('可稍后从浏览器菜单再次安装。')).toBeVisible();
});

test.describe('tablet sign-out', () => {
  test.use({
    viewport: { width: 600, height: 900 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15',
    reducedMotion: 'reduce',
  });
  test('keeps sign-out reachable on the rail without losing the session on cancel', async ({
    page,
  }) => {
    test.skip(process.env['E2E_REAL'] === '1', 'uses a public API fixture');
    await loginFixture(page);
    await page.goto('/settings');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '退出登录', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '退出登录', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.is-tablet-frame')).toBeVisible();
  });
});
