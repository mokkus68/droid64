// droid64 service worker: keeps the app available offline.
// The cache name changes with every version, so a new deploy installs a fresh copy.
const CACHE = 'droid64-v{{VERSION}}';
const CORE = ['./', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('droid64-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// the page asks the new version to take over when the user chooses to update
self.addEventListener('message', (e) => { if (e.data === 'update') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // the page itself: from the cache of this version (offline included)
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || fetch(req);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    } catch {
      return hit || Response.error();
    }
  })());
});
