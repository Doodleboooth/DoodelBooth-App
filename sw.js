/* ── SERVICE WORKER ──────────────────────────────────
   Caches the app shell so the booth opens with no network.
   Bump CACHE_VERSION whenever you change any file below —
   the old cache is deleted on the next activate.        */
const CACHE_VERSION = 'booth-v5';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.webmanifest',
  './Bearlogo3.png',
  './Boylogo3.png',
  './backgroundHERO.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './stickers/TEST2_S1.png',
  './stickers/TEST2.png',
  './stickers/TEST2_S2.png',
  './stickers/TEST2_S3.png',
  './stickers/TEST3_F.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache-first for our own files, network for everything else
   (fonts, Bootstrap CDN). Never cache non-GET.               */
/* NETWORK-FIRST for everything, cache as the fallback.
   This used to be cache-first for the app shell, which meant an
   edited index.html or script.js kept being served from the cache
   long after it changed — the frames you had added were in the new
   files, but the browser was still running the old page. Offline
   still works: when the network isn't there the cached copy is
   used. The only cost is one quick request per file when online. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const ours = new URL(e.request.url).origin === location.origin;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && ours) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
