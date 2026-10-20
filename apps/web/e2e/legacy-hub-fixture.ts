import type { Route } from '@playwright/test';

/** Older-Hub fixtures deliberately do not implement the new optional routes. */
export async function missingProgressiveRoute(route: Route, path: string): Promise<boolean> {
  if (!/\/(?:sync\/(?:preview|bootstrap)|today)$/.test(path)) return false;
  await route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: '{"code":"NOT_FOUND"}',
  });
  return true;
}
