/// <reference lib="webworker" />
import { PrecacheController } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;
const precache = new PrecacheController({ cacheName: 'taskdock-precache-v2' });
precache.addToCacheList(self.__WB_MANIFEST);
const retainedAssets = 'taskdock-hashed-assets-v2';
const immutableAsset = (url: URL) =>
  url.origin === self.location.origin &&
  /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname) &&
  !url.search;

self.addEventListener('install', (event) => {
  void precache.install(event);
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const retained = await caches.open(retainedAssets);
      // Save immutable chunks before Workbox removes previous revision entries.
      // Other open tabs can finish loading their visited graph after this update.
      const oldCaches = (await caches.keys()).filter(
        (name) =>
          name === 'taskdock-precache-v2' ||
          name.startsWith('workbox-precache') ||
          name === 'taskdock-hashed-assets-v1',
      );
      for (const name of oldCaches) {
        const old = await caches.open(name);
        for (const request of await old.keys()) {
          const url = new URL(request.url);
          if (!immutableAsset(url)) continue;
          const response = await old.match(request);
          if (response?.ok) await retained.put(url.href, response);
        }
      }
      const keys = await retained.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - 96))) await retained.delete(key);
      await precache.activate(event);
      // Only obsolete TaskDock shell caches are removed. IndexedDB and its
      // offline queue are independent and must never be cleared by an update.
      for (const name of oldCaches) if (name !== 'taskdock-precache-v2') await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

// Restrict precaching to build-declared public files. API/auth requests and
// uploaded content never enter Cache Storage.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin &&
    request.method === 'GET' &&
    !request.headers.has('Authorization') &&
    !url.pathname.startsWith('/api/') &&
    precache.getURLsToCacheKeys().has(url.href),
  ({ request }) => precache.matchPrecache(request).then((response) => response ?? fetch(request)),
);
registerRoute(
  new NavigationRoute(precache.createHandlerBoundToURL('/index.html'), {
    denylist: [
      /^\/api(?:\/|$)/,
      /^\/health(?:\/|$)/,
      /^\/version$/,
      /^\/assets(?:\/|$)/,
      /^\/sw\.js$/,
      /^\/manifest\.webmanifest$/,
      /\.[a-z0-9]+(?:\?|$)/i,
    ],
  }),
);
registerRoute(
  ({ url, request }) => immutableAsset(url) && !request.headers.has('Authorization'),
  async ({ request }) => {
    const cache = await caches.open(retainedAssets);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    const type = response.headers.get('Content-Type') ?? '';
    if (response.ok && !response.redirected && /javascript|text\/css/.test(type)) {
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - 96))) await cache.delete(key);
    }
    return response;
  },
);
