/*
 * Office Hours service worker. It does ONE thing: when a page cannot be opened because the phone is offline,
 * it shows a friendly offline page. It never stores or answers any data (times, leave, the API), because the
 * server's clock and records are the only truth. Everything else goes straight to the network, untouched.
 */
const CACHE = 'office-hours-offline-v1';
const OFFLINE = ['/offline.html', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only page openings, and never the API. Anything else is not our business.
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  if (new URL(request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
});
