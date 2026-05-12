// sw.js — RaxEdge PWA service worker
// App-shell strategy: cache the HTML shell on install, serve from cache on
// repeat visits for instant load. All API requests always go to the network.

const CACHE = 'raxedge-shell-v2';
const SHELL = ['/', '/app.css', '/app.js'];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(SHELL); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  // Never intercept API, Stripe, or external requests
  if (url.includes('/api/') || url.includes('stripe.com') || url.includes('posthog') || !url.startsWith(self.location.origin)) return;
  // Network-first for navigation — fall back to cached shell
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(function() { return caches.match('/'); })
    );
    return;
  }
  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request);
    })
  );
});
