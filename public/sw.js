/**
 * public/sw.js — conservative service worker.
 *
 * Strategy:
 *   - HTML pages & navigations (the home page especially) are NETWORK-FIRST:
 *     every visit revalidates against the server so a visitor can never be
 *     handed a stale home page. The cache is only an offline fallback.
 *   - /files/* (uploaded images/documents, addressed by a permanent content id)
 *     are CACHE-FIRST: they are immutable, work offline and can never go stale.
 *   - Other assets (css/js/icons) are network-first with a cache fallback.
 *   - API calls and WebSocket upgrades are never cached.
 *
 * RELEASE CHECKLIST — bump CACHE below (e.g. v3 -> v4) on EVERY release. The
 * activate handler deletes every cache whose name != CACHE, so raising the
 * version retires the previous release's cache for all visitors at once.
 */
'use strict';

/* ---------------------------------------------------------------------------
 * Versioned cache. CHANGE THIS STRING ON EVERY RELEASE.
 * Naming it per-release is what lets the activate handler below safely purge
 * the old release's cache without touching the new one.
 * ------------------------------------------------------------------------ */
const CACHE = 'tsmsvte-portal-v4';

const SHELL = [
  '/',
  '/css/main.css',
  '/js/app.js',
  '/icons/logo-192.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    }).catch(function () { /* individual failures must not block install */ })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    /* Delete every cache that is not the current release's CACHE. */
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* An HTML document or a top-level navigation (a link click / fresh page load).
 * Pages MUST come from the network first so visitors never see a stale page. */
function isPageRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.indexOf('text/html') !== -1;
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;                      /* POST/PUT/DELETE: always network */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       /* cross-origin: not our business */
  if (url.pathname.indexOf('/api/') === 0) return;       /* API: never cache */
  if (url.pathname === '/ws') return;

  /* Uploaded files are immutable and addressed by a content id, so serve them
   * cache-first: they work offline and can never go stale (a replacement is a
   * brand-new id). The server also marks them `immutable`. */
  if (url.pathname.indexOf('/files/') === 0) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () { /* noop */ });
          }
          return res;
        });
      })
    );
    return;
  }

  /* HTML pages & navigations: NETWORK-FIRST. Always try the network so the
   * home page and every document are fresh; fall back to cache only when the
   * network is unavailable (offline). Never serve a stale page when online. */
  if (isPageRequest(req)) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () { /* noop */ });
        }
        return res;
      }).catch(function () {
        /* Offline: serve the cached copy of this page, else the cached shell. */
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/');
        });
      })
    );
    return;
  }

  /* Other assets (css/js/icons): network first, fall back to cache when offline. */
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () { /* noop */ });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('/');
      });
    })
  );
});
