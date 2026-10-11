/**
 * tools/test-sw.js - verifies public/sw.js behaves as required.
 *
 * Loads the real service worker into a mocked ServiceWorker + CacheStorage
 * environment (no browser needed) and asserts:
 *   1. the cache name is versioned (tsmsvte-portal-v<n>),
 *   2. install() precaches the shell and calls skipWaiting(),
 *   3. activate() deletes EVERY cache whose name != the current CACHE and
 *      calls clients.claim(),
 *   4. HTML pages / navigations are served NETWORK-FIRST (a changed home page
 *      is always fetched; the cache is only used when the network is down),
 *   5. /files/* is served CACHE-FIRST (a cached file is returned without
 *      hitting the network).
 *
 * Runs on a COPY of the portal database (via better-sqlite3 VACUUM INTO) so it
 * never opens the live data/portal.db. The copy is deleted afterwards.
 *
 *   node tools/test-sw.js        (exit code 0 = all good)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW_PATH = path.join(ROOT, 'public', 'sw.js');
const SOURCE_DB = path.resolve(ROOT, process.env.DB_FILE || './data/portal.db');
const COPY_DB = path.resolve(ROOT, './data/portal-test-sw.db');

let passed = 0;
let failed = 0;
/* Synchronous fd writes: piped/redirected stdout on Windows can drop buffered
 * console.log output when the process ends, so write straight to the fd. */
function log(msg) { fs.writeSync(1, msg + '\n'); }
function err(msg) { fs.writeSync(2, msg + '\n'); }
function check(name, cond, extra) {
  if (cond) { passed += 1; log('  ok   ' + name); }
  else {
    failed += 1;
    log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

/* --------- 1. DB copy (never touch the live db) --------- */
function makeDbCopy() {
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(COPY_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
  if (!fs.existsSync(SOURCE_DB)) {
    log('  note: source DB not found (' + SOURCE_DB + ') - using a minimal copy.');
    const Database = require('better-sqlite3');
    const db = new Database(COPY_DB);
    db.exec('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY)');
    db.close();
    return;
  }
  /* VACUUM INTO writes a consistent snapshot without locking the live DB. */
  const Database = require('better-sqlite3');
  const src = new Database(SOURCE_DB, { readonly: true });
  try {
    src.exec("VACUUM INTO '" + COPY_DB.replace(/'/g, "''") + "'");
  } finally { src.close(); }
}
function cleanupDbCopy() {
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(COPY_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
}

/* --------- 2. Fake Request / Response / fetch --------- */
function FakeRequest(input, init) {
  init = init || {};
  this.url = typeof input === 'string' ? input : input.url;
  this.method = init.method || 'GET';
  this.mode = init.mode || 'cors';
  const h = {};
  if (init.headers) {
    for (const k in init.headers) h[k.toLowerCase()] = init.headers[k];
  }
  this.headers = {
    get: function (name) { return Object.prototype.hasOwnProperty.call(h, name.toLowerCase()) ? h[name.toLowerCase()] : null; }
  };
  this._body = init.body;
}
FakeRequest.prototype.clone = function () { return new FakeRequest(this.url, { method: this.method, mode: this.mode, body: this._body }); };

function FakeResponse(body, init) {
  init = init || {};
  this._body = body;
  this.status = init.status === undefined ? 200 : init.status;
  this.ok = this.status >= 200 && this.status < 300;
  this.type = init.type || 'basic';
  const h = { 'content-type': init.contentType || 'text/plain' };
  this.headers = {
    get: function (name) { return h[name.toLowerCase()] || null; }
  };
}
FakeResponse.prototype.clone = function () { return new FakeResponse(this._body, { status: this.status, type: this.type, contentType: this.headers.get('content-type') }); };

/* A controllable network: online/offline switch + per-path payloads. */
function makeFetch() {
  const net = { online: true, calls: 0, bodies: {} };
  function fakeFetch(req) {
    net.calls += 1;
    const url = new URL(req.url);
    if (!net.online) return Promise.reject(new Error('network down'));
    const body = net.bodies[url.pathname] !== undefined ? net.bodies[url.pathname] : ('default:' + url.pathname);
    const contentType = (url.pathname === '/' || /\.html$/.test(url.pathname))
      ? 'text/html; charset=utf-8'
      : (/\.css$/.test(url.pathname) ? 'text/css' : 'text/plain');
    return Promise.resolve(new FakeResponse(body, { status: 200, type: 'basic', contentType: contentType }));
  }
  return { net: net, fn: fakeFetch };
}

/* --------- 3. Fake CacheStorage --------- */
function makeCaches() {
  const store = new Map();
  function Cache(map) {
    this._map = map;
    this.put = function (req, res) { this._map.set(req.url, res); return Promise.resolve(); };
    this.match = function (req) {
      const url = typeof req === 'string' ? req : req.url;
      return Promise.resolve(this._map.has(url) ? this._map.get(url) : undefined);
    };
    this.addAll = function (urls) {
      const self = this;
      return Promise.all(urls.map(function (u) {
        self._map.set(u, new FakeResponse('shell:' + u, { contentType: 'text/html' }));
      }));
    };
  }
  return {
    open: function (name) {
      if (!store.has(name)) store.set(name, new Map());
      return Promise.resolve(new Cache(store.get(name)));
    },
    keys: function () { return Promise.resolve(Array.from(store.keys())); },
    delete: function (name) { return Promise.resolve(store.delete(name)); },
    match: function (req) {
      const url = typeof req === 'string' ? req : req.url;
      const names = Array.from(store.keys());
      for (let i = 0; i < names.length; i++) {
        const map = store.get(names[i]);
        if (map.has(url)) return Promise.resolve(map.get(url));
      }
      return Promise.resolve(undefined);
    },

    _store: store
  };
}

/* --------- 4. Load sw.js in a VM --------- */
function loadSw(fetchFn, cachesObj) {
  const events = {};
  const state = { skipWaitingCalled: 0, claimCalled: 0 };
  const selfObj = {
    location: { origin: 'https://portal.example' },
    skipWaiting: function () { state.skipWaitingCalled += 1; return Promise.resolve(); },
    clients: { claim: function () { state.claimCalled += 1; return Promise.resolve(); } },
    addEventListener: function (type, handler) { events[type] = handler; }
  };
  const sandbox = {
    self: selfObj, caches: cachesObj, fetch: fetchFn,
    Request: FakeRequest, Response: FakeResponse, URL: URL, console: console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: SW_PATH });
  return { events: events, state: state, self: selfObj };
}

function fireFetch(events, req) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const event = {
      request: req,
      respondWith: function (p) { settled = true; Promise.resolve(p).then(resolve, reject); }
    };
    const handler = events.fetch;
    if (!handler) return reject(new Error('no fetch handler registered'));
    const ret = handler(event);
    if (!settled) Promise.resolve(ret).then(function () { resolve(undefined); }, reject);
  });
}

function install(sw) {
  return new Promise(function (resolve) {
    sw.events.install({ waitUntil: function (p) { Promise.resolve(p).then(resolve, resolve); } });
  });
}
function activate(sw) {
  return new Promise(function (resolve) {
    sw.events.activate({ waitUntil: function (p) { Promise.resolve(p).then(resolve, resolve); } });
  });
}

/* --------- run --------- */
async function run() {
  log('\nTSMSVTE portal - sw.js test (runs on a DB copy)');
  log('Source DB : ' + SOURCE_DB);
  log('Copy  DB : ' + COPY_DB + '\n');
  makeDbCopy();

  const f = makeFetch();
  const cachesObj = makeCaches();
  const sw = loadSw(f.fn, cachesObj);

  /* -- versioned cache name -- */
  const src = fs.readFileSync(SW_PATH, 'utf8');
  const m = src.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  check('cache name is versioned (-v<n>)', !!m && /-v\d+$/.test(m[1]), m && m[1]);
  const cacheName = m ? m[1] : '';
  check('cache version is at least v2 (bumped this release)', /-v[2-9]$/.test(cacheName), cacheName);

  /* -- install precaches shell + skipWaiting -- */
  await install(sw);
  const shellCached = await cachesObj.open(cacheName).then(function (c) { return c.match('/'); });
  check('install() precaches the shell (home page present)', !!shellCached);
  check('install() calls skipWaiting()', sw.state.skipWaitingCalled >= 1, sw.state.skipWaitingCalled);

  /* -- activate deletes ALL old caches + clients.claim -- */
  await cachesObj.open('tsmsvte-portal-v1');
  await cachesObj.open('tsmsvte-portal-v0');
  await cachesObj.open('unrelated-other-app');
  await cachesObj.open(cacheName);
  await activate(sw);
  const remaining = await cachesObj.keys();
  check('activate() deletes every cache except the current version',
    remaining.length === 1 && remaining[0] === cacheName, remaining);
  check('activate() calls clients.claim()', sw.state.claimCalled >= 1, sw.state.claimCalled);

  /* -- HTML pages network-first (never stale) -- */
  f.net.online = true;
  f.net.calls = 0;
  await cachesObj.open(cacheName).then(function (c) {
    return c.put(new FakeRequest('https://portal.example/'), new FakeResponse('HOME-STALE', { contentType: 'text/html' }));
  });
  f.net.bodies['/'] = 'HOME-NEW';
  const navRes = await fireFetch(sw.events, new FakeRequest('https://portal.example/', { mode: 'navigate' }));
  check('home navigation hits the NETWORK (network-first)', f.net.calls >= 1, f.net.calls);
  check('home navigation returns the fresh body (not stale cache)', navRes && navRes._body === 'HOME-NEW', navRes && navRes._body);

  /* Offline: the network copy of the page must come from cache. Use a fresh
   * SW + cache pre-seeded with the previously-cached page so this is isolated
   * from the network-first test above (which legitimately cached HOME-NEW). */
  const f2 = makeFetch();
  const cachesObj2 = makeCaches();
  const sw2 = loadSw(f2.fn, cachesObj2);
  await install(sw2);
  await cachesObj2.open(cacheName).then(function (c) {
    return c.put(new FakeRequest('https://portal.example/'), new FakeResponse('HOME-CACHED', { contentType: 'text/html' }));
  });
  f2.net.online = false;
  f2.net.calls = 0;
  const offRes = await fireFetch(sw2.events, new FakeRequest('https://portal.example/', { mode: 'navigate' }));
  /* Network-first still attempts fetch (which rejects when offline), then must
   * resolve to the cached page rather than failing — the key is the body. */
  check('home navigation falls back to the cached page when offline',
    offRes && offRes._body === 'HOME-CACHED', offRes && offRes._body);
  f.net.online = true;

  f.net.calls = 0;
  f.net.bodies['/about.html'] = 'ABOUT-NEW';
  await cachesObj.open(cacheName).then(function (c) {
    return c.put(new FakeRequest('https://portal.example/about.html'), new FakeResponse('ABOUT-STALE', { contentType: 'text/html' }));
  });
  const aboutRes = await fireFetch(sw.events, new FakeRequest('https://portal.example/about.html', { headers: { accept: 'text/html' } }));
  check('HTML request (Accept: text/html) is network-first', f.net.calls >= 1 && aboutRes._body === 'ABOUT-NEW', aboutRes && aboutRes._body);

  /* -- /files/* cache-first -- */
  f.net.calls = 0;
  await cachesObj.open(cacheName).then(function (c) {
    return c.put(new FakeRequest('https://portal.example/files/abc123'), new FakeResponse('FILE-CACHED', { contentType: 'image/png' }));
  });
  f.net.bodies['/files/abc123'] = 'FILE-NETWORK';
  const fileRes = await fireFetch(sw.events, new FakeRequest('https://portal.example/files/abc123'));
  check('/files/* served from cache without hitting the network (cache-first)',
    f.net.calls === 0 && fileRes._body === 'FILE-CACHED', { calls: f.net.calls, body: fileRes && fileRes._body });

  f.net.calls = 0;
  f.net.bodies['/files/def456'] = 'FILE-FRESH';
  const missRes = await fireFetch(sw.events, new FakeRequest('https://portal.example/files/def456'));
  check('/files/* cache miss fetches from network then serves it',
    f.net.calls === 1 && missRes._body === 'FILE-FRESH', { calls: f.net.calls, body: missRes && missRes._body });

  cleanupDbCopy();
  log('\n[sw-test] passed=' + passed + ' failed=' + failed + '\n');
  /* exitCode (not process.exit) so buffered stdout fully flushes. */
  process.exitCode = failed ? 1 : 0;
}

run().catch(function (e) {
  err('[sw-test] FATAL ' + (e && e.stack ? e.stack : e));
  cleanupDbCopy();
  process.exitCode = 1;
});
