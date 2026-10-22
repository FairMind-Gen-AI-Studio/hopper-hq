/*
 * Service worker for the installed app, scoped to /ui/ (registration: ui/main.ts). Two rules only:
 *  - /ui/assets/* file names carry a content hash, so they are cache-first: once cached, never refetched.
 *  - everything else under /ui/ (the shell at /ui/ and /ui/index.html, plus the unhashed manifest/icons) is
 *    network-first, so a new build is picked up on the next load; the cache is only a fallback when offline.
 * /api/* (especially the /api/events SSE stream, which a cache would break) and /ui/login are never touched:
 * both need a live round trip to the daemon every time.
 */
const CACHE = 'hopper-hq-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/ui/') || url.pathname === '/ui/login') return;

  event.respondWith(url.pathname.startsWith('/ui/assets/') ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}
