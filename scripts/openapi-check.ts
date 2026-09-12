import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const document = JSON.parse(
    await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
  ) as { openapi?: string; paths?: Record<string, unknown> };
  if (
    !document.openapi?.startsWith('3.') ||
    !document.paths ||
    Object.keys(document.paths).length < 20
  )
    throw new Error('OpenAPI document is incomplete');
  const expectedPaths = [
    '/bootstrap/status',
    '/bootstrap',
    '/auth/login',
    '/auth/refresh',
    '/auth/logout',
    '/auth/native/challenge',
    '/me',
    '/devices',
    '/settings',
    '/projects',
    '/projects/task-counts',
    '/projects/{id}',
    '/projects/{id}/archive',
    '/projects/{id}/restore',
    '/projects/reorder',
    '/tasks',
    '/tasks/{id}',
    '/tasks/{id}/archive',
    '/tasks/{id}/restore',
    '/tasks/{id}/duplicate',
    '/tasks/reorder',
    '/tasks/{id}/note',
    '/search/tasks',
    '/time-points',
    '/time-points/date',
    '/time-points/events',
    '/time-points/placement-counts',
    '/time-points/{id}',
    '/time-points/{id}/reach',
    '/time-points/{id}/archive',
    '/time-points/{id}/restore',
    '/time-points/events/reorder',
    '/time-points/{id}/placements',
    '/time-points/{id}/placements/reorder',
    '/placements',
    '/placements/{id}',
    '/placements/{id}/move',
    '/placements/{id}/copy',
    '/dates/{localDate}/rollover',
    '/rollovers/{operationId}/undo',
    '/sync/snapshot',
    '/sync/pull',
    '/sync/push',
    '/sync/status',
    '/ws',
  ];
  const actualPaths = Object.keys(document.paths);
  const missing = expectedPaths.filter((path) => !actualPaths.includes(path));
  if (missing.length) throw new Error(`OpenAPI paths missing: ${missing.join(', ')}`);

  const source = await readFile(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8');
  const routePaths = [
    ...source.matchAll(/api\.(?:get|post|patch|put|delete)\(\s*['"]([^'"]+)['"]/g),
  ].map((match) =>
    `/api/v1${match[1]!}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/^\/api\/v1/, ''),
  );
  const missingFromDocument = [...new Set(routePaths)].filter(
    (path) => !actualPaths.includes(path),
  );
  if (missingFromDocument.length)
    throw new Error(`implemented routes missing from OpenAPI: ${missingFromDocument.join(', ')}`);
  console.log(`PASS: OpenAPI ${document.openapi}, ${actualPaths.length} paths match API routes.`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
