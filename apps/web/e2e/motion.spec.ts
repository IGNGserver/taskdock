import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: '00000000-0000-7000-8000-000000000011',
  username: 'motion-user',
  createdAt: '2026-09-04T10:00:00.000Z',
};

const settings = {
  ownerId: user.id,
  timezone: 'Asia/Shanghai',
  weekStartsOn: 1 as const,
  defaultCaptureTarget: 'GLOBAL_MISC',
  version: 1,
  updatedAt: user.createdAt,
};

async function installMockApi(page: Page): Promise<void> {
  let authenticated = false;
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (value: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.endsWith('/auth/refresh'))
      return authenticated
        ? body({ accessToken: 'motion-access-token' })
        : route.fulfill({ status: 401, body: '{}' });
    if (path.endsWith('/bootstrap/status')) return body({ initialized: true });
    if (path.endsWith('/auth/login')) {
      authenticated = true;
      return body({
        accessToken: 'motion-access-token',
        user,
        device: {
          id: '00000000-0000-7000-8000-000000000013',
          name: '浏览器',
          platform: 'web',
          lastSeenAt: user.createdAt,
          createdAt: user.createdAt,
          revokedAt: null,
        },
      });
    }
    if (path.endsWith('/me'))
      return body({
        user,
        settings,
        capabilities: { syncProtocolVersion: 1, websocket: true, offline: true },
      });
    return body({ items: [] });
  });

  await page.route('**/api/v2/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/time-points/date'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '00000000-0000-7000-8000-000000000021',
          type: 'DATE',
          title: '今天',
          localDate: '2026-09-19',
          timezone: 'Asia/Shanghai',
          reachedAt: null,
          archivedAt: null,
          version: 1,
          createdAt: '2026-09-19T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
        }),
      });
    if (path.endsWith('/sync/snapshot'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          folders: [],
          tasks: [],
          notes: [],
          taskSteps: [],
          timePoints: [],
          placements: [],
          workflows: [],
          workflowStages: [],
          workflowTaskMemberships: [],
          archiveOperations: [],
          settings,
          cursor: '0',
        }),
      });
    if (path.endsWith('/sync/pull'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ changes: [], nextCursor: '0', hasMore: false }),
      });
    if (path.endsWith('/sync/push'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 2, results: [] }),
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });
}

/** Parse a CSS time value (`150ms` or `.15s`) into milliseconds. */
function toMilliseconds(value: string): number {
  const match = /^([0-9.]+)(ms|s)$/.exec(value.trim());
  if (!match) return Number.NaN;
  return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1]);
}

async function signIn(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/login');
  await page.getByLabel('用户名').fill(user.username);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(
    test.info().project.name === 'mobile'
      ? page.getByRole('button', { name: '打开创建菜单' })
      : page.getByRole('button', { name: '快速添加' }),
  ).toBeVisible();
}

/**
 * The M3E migration replaces duration+easing with spring physics. The reduced
 * motion contract is that springs degrade to short fades instead of being
 * globally flattened with `animation-duration: 0.01ms` — the previous approach
 * removed the *meaning* of a transition as well as its motion. These assertions
 * pin the token-level behaviour that makes that possible.
 */
test('spring tokens are flattened to non-overshooting ramps under reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installMockApi(page);
  await page.goto('/login');

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    return {
      spatial: read('--m3-spring-spatial'),
      spatialSlow: read('--m3-spring-spatial-slow'),
      expressive: read('--m3-spring-expressive-spatial'),
      spatialDuration: read('--m3-spring-spatial-duration'),
      effectsDuration: read('--m3-spring-effects-duration'),
    };
  });

  // Spatial springs become a straight 0 -> 1 ramp: no overshoot remains.
  expect(tokens.spatial).toBe('linear(0 0%, 1 100%)');
  expect(tokens.spatialSlow).toBe('linear(0 0%, 1 100%)');
  expect(tokens.expressive).toBe('linear(0 0%, 1 100%)');

  // Effects tokens are critically damped already, so they keep their curves.
  expect(toMilliseconds(tokens.effectsDuration)).toBeGreaterThan(0);

  // The move is compressed but not eliminated, so the transition still reads.
  // The production CSS minifier rewrites `150ms` as `.15s`, so parse both units.
  const spatialMs = toMilliseconds(tokens.spatialDuration);
  expect(spatialMs).toBeGreaterThan(0);
  expect(spatialMs).toBeLessThanOrEqual(200);
});

test('spring tokens overshoot only in the expressive scheme by default', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installMockApi(page);
  await page.goto('/login');

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    /** Largest value in a `linear()` ramp; > 1 means the spring overshoots. */
    const peak = (value: string) =>
      Math.max(...Array.from(value.matchAll(/([0-9.]+) [0-9.]+%/g), (m) => Number(m[1])));
    return {
      spatial: peak(read('--m3-spring-spatial')),
      expressive: peak(read('--m3-spring-expressive-spatial')),
      effects: peak(read('--m3-spring-effects')),
    };
  });

  // Effects springs are critically damped: colour and alpha must never bounce.
  expect(tokens.effects).toBeLessThanOrEqual(1);

  /*
   * Browsers truncate the serialisation of very long `linear()` streams, so the
   * absolute peak is not reliable here. The ordering is: the expressive scheme
   * is the one allowed a visible overshoot and must exceed both the standard
   * spatial spring and the effects spring, which is what makes a hero moment
   * distinguishable from a routine transition.
   * `apps/web/test/m3e-tokens.test.ts` asserts the exact peaks against the
   * token file.
   */
  expect(tokens.spatial).toBeGreaterThan(1);
  expect(tokens.expressive).toBeGreaterThan(tokens.spatial);
  expect(tokens.effects).toBeLessThan(tokens.spatial);
});

test('reduced motion still lets the navigation drawer open and close', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'the drawer is the compact navigation surface');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);

  const menuButton = page.getByRole('button', { name: '打开侧边栏' });
  await menuButton.click();
  const drawer = page.getByRole('complementary', { name: '移动侧边栏' });
  await expect(drawer).toBeVisible();

  await page.keyboard.press('Escape');
  // The close must still complete: the presence lifecycle reads the same token
  // the stylesheet uses, so a flattened spring cannot strand the overlay.
  await expect(drawer).toBeHidden();
});
