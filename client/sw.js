/* BMU AI Assistant Service Worker (basic offline shell)
 * - Caches app shell
 * - Network-first for API
 */

// Bump this to force clients to update cached assets after deploys.
const CACHE_NAME = 'bmu-ai-assistant-v64';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/bmulogo.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event?.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE_NAME ? Promise.resolve() : caches.delete(k))));

      // Ensure the freshest shell is in cache after activation.
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);

      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Do not intercept cross-origin requests (prevents CSP/opaque cache issues for fonts/CDN resources)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Network-first for navigations/HTML to prevent stale SPA shells.
  const isNavigation = req.mode === 'navigate';
  const isHtml = req.headers.get('accept')?.includes('text/html');
  if (isNavigation || isHtml || url.pathname === '/index.html') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          return (await caches.match(req)) || (await caches.match('/index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  // Network-first for JS/CSS to pick up deploys; fallback to cache for offline.
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          return (await caches.match(req)) || Response.error();
        }
      })()
    );
    return;
  }

  // Cache-first for other static assets
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
