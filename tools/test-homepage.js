#!/usr/bin/env node
'use strict';
/* tools/test-homepage.js — regression tests for the homepage content fix.
 *
 * Runs against an ISOLATED throwaway SQLite DB (a per-pid file under data/).
 * It never touches data/portal.db and never connects to production: DATABASE_URL
 * is deleted before the app loads so db.js is forced into SQLite mode. The real
 * Express app starts in-process on a free port.
 *
 *  1. anonymous GET /api/auth/me returns the public settings
 *  2. GET /api/settings/public returns a valid shape with a no-cache policy
 *  3. an admin settings update persists on a fresh read (isolated DB)
 *  4. updating one setting does NOT blank unrelated settings
 *  5. an unauthorized settings update is rejected
 *  6. homepage HTML loads its loaders, dead inline script gone, no reload loop
 *
 * Exits 0 when every test passes, 1 otherwise. No credentials are hard-coded:
 * login reads OWNER_EMAIL / OWNER_PASSWORD from the env that server.js loads.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const TMP_DB = path.join(ROOT, 'data', 'test-homepage-' + process.pid + '.db');

/* ---- isolate BEFORE anything loads db.js / server.js ------------------ */
delete process.env.DATABASE_URL;           /* force SQLite, never Postgres  */
process.env.NODE_ENV = 'test';             /* no prod HSTS / secure cookies */
process.env.COOKIE_SECURE = '0';
process.env.DB_FILE = TMP_DB;              /* throwaway DB, NOT portal.db   */

/* --------------------------------------------------------------------- */
const results = [];
function record(name, pass, detail) {
  results.push({ name: name, pass: pass, detail: detail });
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}
function setCookiesOf(res) {
  const h = res.headers;
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  if (typeof h.raw === 'function') { const r = h.raw(); return (r && r['set-cookie']) || []; }
  const v = h.get('set-cookie');
  return v ? [v] : [];
}
function newJar() { return { map: {} }; }
function absorb(jar, res) {
  for (const sc of setCookiesOf(res)) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.map[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
}
function cookieHeader(jar) {
  return Object.keys(jar.map).map(function (k) { return k + '=' + jar.map[k]; }).join('; ');
}
function randomToken() { return require('crypto').randomBytes(32).toString('hex'); }
async function call(jar, base, method, p, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.csrf) headers['X-CSRF-Token'] = opts.csrf;
  const ck = cookieHeader(jar);
  if (ck) headers['Cookie'] = ck;
  const res = await fetch(base + p, {
    method: method, headers: headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  absorb(jar, res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, headers: res.headers, data: data, text: text };
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
  });
}
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (e) { /* not up */ }
    if (Date.now() > deadline) return false;
    await new Promise(function (r) { setTimeout(r, 250); });
  }
}
function cleanup(server) {
  /* Close the HTTP listener first: an open server handle alone keeps the Node
   * event loop alive, which is what used to hang `npm run test:home` after
   * every assertion had already passed. Then close the SQLite handle and
   * remove the throwaway DB files (isolated per-pid DB, never portal.db). */
  const closeServer = server && typeof server.close === 'function'
    ? new Promise(function (resolve) { server.close(function () { resolve(); }); })
    : Promise.resolve();
  return closeServer.then(function () {
    try { require(path.join(ROOT, 'db.js')).close(); } catch (e) { /* ignore */ }
    ['', '-shm', '-wal'].forEach(function (suf) {
      try { fs.unlinkSync(TMP_DB + suf); } catch (e) { /* ignore */ }
    });
    try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ }
  });
}

/* --------------------------------------------------------------------- */
async function main() {
  const port = await freePort();
  process.env.PORT = String(port);
  const base = 'http://127.0.0.1:' + port;

  /* Starts the real server and seeds the isolated DB. The required module now
   * exposes its HTTP server (server.js `module.exports.server`) so the run
   * can close it at the end and exit naturally instead of hanging. */
  const appModule = require(path.join(ROOT, 'server.js'));
  const httpServer = appModule && appModule.server;
  const up = await waitFor(base + '/healthz', 30000);
  if (!up) { await cleanup(httpServer); throw new Error('server did not become healthy on port ' + port); }

  const anon = newJar();
  const before = await call(anon, base, 'GET', '/api/settings/public');

  /* 1. anonymous /api/auth/me returns public settings -------------------- */
  try {
    const me = await call(newJar(), base, 'GET', '/api/auth/me');
    const s = me.data && me.data.settings;
    const nonEmpty = s && typeof s === 'object' && Object.keys(s).length > 0;
    const anonUser = me.data && me.data.user === null;
    const leaksPrivate = s && ('privacy_notice' in s || 'sms_api_key' in s);
    record('1. anonymous /api/auth/me returns public settings',
      me.status === 200 && nonEmpty && anonUser && !leaksPrivate,
      'status=' + me.status + ' keys=' + (s ? Object.keys(s).length : 0));
  } catch (e) { record('1. anonymous /api/auth/me returns public settings', false, e.message); }

  /* 2. public settings shape + no-cache ---------------------------------- */
  try {
    const cc = before.headers.get('cache-control') || '';
    const s = before.data && before.data.settings;
    const nonEmpty = s && typeof s === 'object' && Object.keys(s).length > 0;
    const hasHero = s && typeof s.hero_heading === 'string';
    record('2. GET /api/settings/public shape + no-cache',
      before.status === 200 && nonEmpty && hasHero && /no-cache/.test(cc),
      'status=' + before.status + ' cache-control=' + cc);
  } catch (e) { record('2. GET /api/settings/public shape + no-cache', false, e.message); }

  const beforeSettings = (before.data && before.data.settings) || {};
  const marker = 'TEST-HOME-' + process.pid + '-' + Date.now();
  /* ---- owner login for the write tests (env creds, never hard-coded) ---- */
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  const authJar = newJar();
  const csrf = randomToken();
  authJar.map['tsmsvte_csrf'] = csrf;
  let loggedIn = false;
  if (email && password) {
    try {
      const r = await call(authJar, base, 'POST', '/api/auth/login',
        { body: { email: email, password: password }, csrf: csrf });
      loggedIn = r.status === 200 && r.data && r.data.ok === true;
      if (!loggedIn) console.log('  (login status ' + r.status + ')');
    } catch (e) { console.log('  (login threw: ' + e.message + ')'); }
  } else { console.log('  (OWNER creds absent; skipping login)'); }

  /* 3. admin update persists after a fresh read (isolated DB) ------------ */
  try {
    if (!loggedIn) throw new Error('owner login failed');
    const put = await call(authJar, base, 'PUT', '/api/settings',
      { body: { office_hours: marker }, csrf: csrf });
    const fresh = await call(newJar(), base, 'GET', '/api/settings/public');
    const stored = fresh.data && fresh.data.settings && fresh.data.settings.office_hours;
    record('3. admin settings update persists on a fresh read',
      put.status === 200 && stored === marker,
      'put=' + put.status + ' stored=' + JSON.stringify(stored));
  } catch (e) { record('3. admin settings update persists on a fresh read', false, e.message); }

  /* 4. one-key update does not blank unrelated settings ------------------ */
  try {
    const fresh = await call(newJar(), base, 'GET', '/api/settings/public');
    const s = (fresh.data && fresh.data.settings) || {};
    const ministryOk = typeof s.ministry_name === 'string' && s.ministry_name.length > 0;
    const heroOk = typeof s.hero_heading === 'string' && s.hero_heading.length > 0;
    const keptMarker = s.office_hours === marker;
    record('4. updating one setting does not blank unrelated settings',
      keptMarker && ministryOk && heroOk,
      'office_hours kept=' + keptMarker + ' ministry ok=' + ministryOk + ' hero ok=' + heroOk);
  } catch (e) { record('4. updating one setting does not blank unrelated settings', false, e.message); }

  /* 5. unauthorized settings update rejected ----------------------------- */
  try {
    const unauth = newJar();
    const ucsrf = randomToken();
    unauth.map['tsmsvte_csrf'] = ucsrf;         /* valid CSRF, but NO auth   */
    const r = await call(unauth, base, 'PUT', '/api/settings',
      { body: { office_hours: 'SHOULD-NOT-SAVE' }, csrf: ucsrf });
    record('5. unauthorized settings update is rejected',
      r.status === 401 || r.status === 403, 'status=' + r.status);
  } catch (e) { record('5. unauthorized settings update is rejected', false, e.message); }

  /* 6. homepage HTML: loaders present, dead inline script gone, no loops  */
  try {
    const page = await call(newJar(), base, 'GET', '/');
    const html = page.text;
    const loadsHome = html.indexOf('<script src="/js/pages/home.js">') !== -1;
    const loadsClean = html.indexOf('<script src="/js/pages/home-clean.js">') !== -1;
    const commentGone = html.indexOf('REMOVED OLD CONFLICT') === -1;
    record('6a. homepage loads home.js + home-clean.js (active, not commented)',
      page.status === 200 && loadsHome && loadsClean && commentGone,
      'home=' + loadsHome + ' clean=' + loadsClean + ' commentGone=' + commentGone);

    const inlineGone = html.indexOf("fetch('/api/settings/public')") === -1
      && html.indexOf('NUCLEAR') === -1;
    record('6b. dead inline NUCLEAR/settings script removed from index.html',
      inlineGone, 'inlineGone=' + inlineGone);

    const homeJs = fs.readFileSync(path.join(ROOT, 'public/js/pages/home.js'), 'utf8');
    const cleanJs = fs.readFileSync(path.join(ROOT, 'public/js/pages/home-clean.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const all = homeJs + cleanJs + idx;
    const noReload = !/location\.reload\s*\(/.test(all);
    const noPoll = !/setInterval\s*\(/.test(all);
    const loaders = /function loadNews/.test(homeJs) && /loadNews\(\)/.test(homeJs)
      && /function loadFaq/.test(homeJs) && /loadLgas/.test(homeJs);
    record('6c. no reload loop / setInterval poll, loaders retained',
      noReload && noPoll && loaders,
      'noReload=' + noReload + ' noPoll=' + noPoll + ' loaders=' + loaders);
  } catch (e) { record('6. homepage HTML checks', false, e.message); }

  /* ---- report: close resources first, then exit NATURALLY (no process.exit
   * while handles are open). exitCode carries the result once the event loop
   * drains, so piped stdout fully flushes and `npm run test:home` returns. */
  const failed = results.filter(function (r) { return !r.pass; });
  console.log('\n' + results.length + ' tests, ' +
    (results.length - failed.length) + ' passed, ' + failed.length + ' failed.');
  await cleanup(httpServer);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async function (err) {
  console.error('\nFATAL: ' + ((err && err.stack) || err));
  try { await cleanup(); } catch (e) { /* ignore */ }
  process.exitCode = 1;
});
