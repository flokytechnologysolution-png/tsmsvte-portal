/**
 * public/sw.js — conservative service worker.
 *
 * Strategy: network-first for everything that matters (pages, API), with a
 * small cache fallback so a flaky office connection still shows the shell.
 * API calls and WebSocket upgrades are never cached.
 */
'use strict';

const CACHE = 'tsmsvte-portal-v1';
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
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;                      /* POST/PUT/DELETE: always network */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       /* cross-origin: not our business */
  if (url.pathname.indexOf('/api/') === 0) return;       /* API: never cache */
  if (url.pathname === '/ws') return;

  /* Pages & assets: network first, fall back to cache when offline. */
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
