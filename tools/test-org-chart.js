#!/usr/bin/env node
'use strict';
/* tools/test-org-chart.js — regression tests for the organization chart.
 *
 * Runs against an ISOLATED throwaway SQLite DB (a per-pid file under data/).
 * It never touches data/portal.db and never connects to production: DATABASE_URL
 * is deleted before the app loads so db.js is forced into SQLite mode. The real
 * Express app starts in-process on a free port.
 *
 *  1. anonymous GET /api/org-chart works and is empty + no-cache
 *  2. anonymous admin operations are refused (401)
 *  3. a STAFF user is refused every admin operation (403)
 *  4. server-side validation rejects bad titles/categories/sort orders
 *  5. entries are created as drafts and drafts never reach the public API
 *  6. publishing makes an entry visible; public rows leak no private columns
 *  7. parent links work; invalid parents, self-parenting and cycles are refused
 *  8. portraits: outside links and unknown /files/ ids refused; a real upload
 *     through POST /api/settings/upload is accepted and returned publicly
 *  9. missing CSRF token is refused even for a signed-in admin
 * 10. deleting a parent moves its children up one level (never orphans them)
 * 11. homepage HTML hosts the dynamic chart (no placeholder cards remain)
 *
 * Exits 0 when every test passes, 1 otherwise. Test users are created inside
 * the throwaway DB with their own credentials — no secrets are hard-coded and
 * .env values are never printed.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const TMP_DB = path.join(ROOT, 'data', 'test-org-chart-' + process.pid + '.db');

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
/* multipart upload through the existing console endpoint.
 * The X-CSRF-Token header is required: the server's CSRF check runs before
 * any multipart body parsing, so a `_csrf` field inside the form is invisible
 * at that point and only the header can authenticate the request. */
async function uploadImage(jar, base, csrf, bytes, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const headers = { 'X-CSRF-Token': csrf };
  const ck = cookieHeader(jar);
  if (ck) headers['Cookie'] = ck;
  const res = await fetch(base + '/api/settings/upload', { method: 'POST', headers: headers, body: fd });
  absorb(jar, res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data: data };
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
/* A real 1x1 PNG (valid magic bytes, > 64 bytes decoded). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');


/* --------------------------------------------------------------------- */
async function main() {
  const port = await freePort();
  process.env.PORT = String(port);
  const base = 'http://127.0.0.1:' + port;

  const appModule = require(path.join(ROOT, 'server.js'));
  const httpServer = appModule && appModule.server;
  const up = await waitFor(base + '/healthz', 30000);
  if (!up) { await cleanup(httpServer); throw new Error('server did not become healthy on port ' + port); }

  /* Test users live inside the throwaway DB with their own credentials. */
  const dbx = require(path.join(ROOT, 'db.js'));
  await dbx.ready;
  const bcrypt = require('bcrypt');
  const hash = bcrypt.hashSync('OrgChart!Test123', 10);
  const suffix = '-' + process.pid + '@org-chart.test';
  const ADMIN_EMAIL = 'ogadmin' + suffix;
  const STAFF_EMAIL = 'ogstaff' + suffix;
  await dbx.run("INSERT INTO users (email, password_hash, full_name, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')",
    [ADMIN_EMAIL, hash, 'Org Chart Test Admin']);
  await dbx.run("INSERT INTO users (email, password_hash, full_name, role, status) VALUES (?, ?, ?, 'STAFF', 'ACTIVE')",
    [STAFF_EMAIL, hash, 'Org Chart Test Staff']);

  async function login(email) {
    const jar = newJar();
    const csrf = randomToken();
    jar.map['tsmsvte_csrf'] = csrf;
    const r = await call(jar, base, 'POST', '/api/auth/login',
      { body: { email: email, password: 'OrgChart!Test123' }, csrf: csrf });
    return { jar: jar, csrf: csrf, ok: r.status === 200 && r.data && r.data.ok === true };
  }
  const admin = await login(ADMIN_EMAIL);
  const staff = await login(STAFF_EMAIL);
  if (!admin.ok || !staff.ok) throw new Error('test logins failed (admin=' + admin.ok + ' staff=' + staff.ok + ')');

  /* 1. anonymous public list: empty, no-cache -------------------------------- */
  try {
    const r = await call(newJar(), base, 'GET', '/api/org-chart');
    const cc = r.headers.get('cache-control') || '';
    record('1. anonymous GET /api/org-chart is empty + no-cache',
      r.status === 200 && r.data && r.data.total === 0 && Array.isArray(r.data.entries) &&
      r.data.entries.length === 0 && /no-cache/.test(cc),
      'status=' + r.status + ' total=' + (r.data && r.data.total) + ' cc=' + cc);
  } catch (e) { record('1. anonymous GET /api/org-chart is empty + no-cache', false, e.message); }

  /* 2. anonymous admin operations refused ----------------------------------- */
  try {
    const jar = newJar();
    const csrf = randomToken();
    jar.map['tsmsvte_csrf'] = csrf;                 /* valid CSRF, NO auth    */
    const post = await call(jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Should not be created' }, csrf: csrf });
    const get = await call(jar, base, 'GET', '/api/org-chart/admin');
    record('2. anonymous admin operations are refused (401)',
      post.status === 401 && get.status === 401,
      'post=' + post.status + ' get=' + get.status);
  } catch (e) { record('2. anonymous admin operations are refused (401)', false, e.message); }

  /* 3. STAFF is refused ------------------------------------------------------ */
  try {
    const post = await call(staff.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Staff should not create' }, csrf: staff.csrf });
    const get = await call(staff.jar, base, 'GET', '/api/org-chart/admin');
    const put = await call(staff.jar, base, 'PUT', '/api/org-chart/1',
      { body: { title: 'nope' }, csrf: staff.csrf });
    const del = await call(staff.jar, base, 'DELETE', '/api/org-chart/1', { csrf: staff.csrf });
    record('3. STAFF user is refused every admin operation (403)',
      post.status === 403 && get.status === 403 && put.status === 403 && del.status === 403,
      'post=' + post.status + ' get=' + get.status + ' put=' + put.status + ' del=' + del.status);
  } catch (e) { record('3. STAFF user is refused every admin operation (403)', false, e.message); }

  /* 4. server-side validation ------------------------------------------------ */
  try {
    const noTitle = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { category: 'leadership', sort_order: 0 }, csrf: admin.csrf });
    const badCat = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Valid title', category: 'emoji', sort_order: 0 }, csrf: admin.csrf });
    const badOrder = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Valid title', category: 'leadership', sort_order: 'first' }, csrf: admin.csrf });
    record('4. validation rejects missing title / bad category / bad sort order',
      noTitle.status === 422 && badCat.status === 422 && badOrder.status === 422,
      'noTitle=' + noTitle.status + ' badCat=' + badCat.status + ' badOrder=' + badOrder.status);
  } catch (e) { record('4. validation rejects missing title / bad category / bad sort order', false, e.message); }
  /* 5. created as draft; drafts never reach the public list ------------------ */
  let sgsId = null;
  try {
    const created = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Secretary to the Government of the State', category: 'leadership', sort_order: 1 },
        csrf: admin.csrf });
    sgsId = created.data && created.data.id;
    const adminList = await call(admin.jar, base, 'GET', '/api/org-chart/admin');
    const row = (adminList.data.entries || []).find(function (e) { return e.id === sgsId; });
    const pub = await call(newJar(), base, 'GET', '/api/org-chart');
    record('5. new entries are drafts and hidden from the public list',
      created.status === 201 && Number.isFinite(Number(sgsId)) &&
      row && row.status === 'draft' && pub.data.total === 0,
      'create=' + created.status + ' id=' + sgsId + ' status=' + (row && row.status) +
      ' publicTotal=' + (pub.data && pub.data.total));
  } catch (e) { record('5. new entries are drafts and hidden from the public list', false, e.message); }

  /* 6. publishing shows the entry; public rows leak nothing private ---------- */
  try {
    const put1 = await call(admin.jar, base, 'PUT', '/api/org-chart/' + sgsId,
      { body: { status: 'published' }, csrf: admin.csrf });
    const pub2 = await call(newJar(), base, 'GET', '/api/org-chart');
    const row = (pub2.data.entries || []).find(function (e) { return e.id === sgsId; });
    record('6. publishing makes the entry public; title survives a partial update',
      put1.status === 200 && pub2.status === 200 && row &&
      row.title === 'Secretary to the Government of the State' &&
      !('status' in row) && !('created_by' in row) && !('created_at' in row),
      'put=' + put1.status + ' publicTotal=' + (pub2.data && pub2.data.total) +
      ' keys=' + (row ? Object.keys(row).join(',') : 'none'));
  } catch (e) { record('6. publishing makes the entry public; title survives a partial update', false, e.message); }

  /* 7. hierarchy: children publish under their parent; draft child hidden ---- */
  let commId = null;
  let psId = null;
  try {
    const comm = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Commissioner', name: '', category: 'leadership',
          parent_id: sgsId, sort_order: 2, status: 'published' }, csrf: admin.csrf });
    commId = comm.data && comm.data.id;
    const ps = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Permanent Secretary', category: 'leadership',
          parent_id: commId, sort_order: 3, status: 'draft' }, csrf: admin.csrf });
    psId = ps.data && ps.data.id;
    const pub = await call(newJar(), base, 'GET', '/api/org-chart');
    const ids = (pub.data.entries || []).map(function (e) { return e.id; });
    const commRow = (pub.data.entries || []).find(function (e) { return e.id === commId; });
    record('7. published child links to its parent; draft child stays hidden',
      comm.status === 201 && ps.status === 201 &&
      ids.indexOf(sgsId) !== -1 && ids.indexOf(commId) !== -1 && ids.indexOf(psId) === -1 &&
      commRow && commRow.parent_id === sgsId,
      'commParent=' + (commRow && commRow.parent_id) + ' publicIds=' + ids.join(','));
  } catch (e) { record('7. published child links to its parent; draft child stays hidden', false, e.message); }

  /* 8. parent validation: missing parent, self-parenting, cycles -------------- */
  try {
    const missing = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'Orphan', parent_id: 999999 }, csrf: admin.csrf });
    const self = await call(admin.jar, base, 'PUT', '/api/org-chart/' + sgsId,
      { body: { parent_id: sgsId }, csrf: admin.csrf });
    const cycle = await call(admin.jar, base, 'PUT', '/api/org-chart/' + sgsId,
      { body: { parent_id: commId }, csrf: admin.csrf });
    const bogus = await call(admin.jar, base, 'PUT', '/api/org-chart/' + sgsId,
      { body: { parent_id: 'not-a-number' }, csrf: admin.csrf });
    record('8. invalid parent, self-parenting and circular hierarchies are refused',
      missing.status === 422 && self.status === 422 && cycle.status === 422 && bogus.status === 422,
      'missing=' + missing.status + ' self=' + self.status + ' cycle=' + cycle.status + ' bogus=' + bogus.status);
  } catch (e) { record('8. invalid parent, self-parenting and circular hierarchies are refused', false, e.message); }
  /* 9. portraits: outside links and unknown ids refused ---------------------- */
  try {
    const external = await call(admin.jar, base, 'PUT', '/api/org-chart/' + commId,
      { body: { portrait: 'https://evil.example/portrait.jpg' }, csrf: admin.csrf });
    const uploads = await call(admin.jar, base, 'PUT', '/api/org-chart/' + commId,
      { body: { portrait: '/uploads/photos/stolen.jpg' }, csrf: admin.csrf });
    const unknown = await call(admin.jar, base, 'PUT', '/api/org-chart/' + commId,
      { body: { portrait: '/files/abcdef0123456789abcdef01' }, csrf: admin.csrf });
    record('9a. outside portrait links and unknown /files ids are refused',
      external.status === 422 && uploads.status === 422 && unknown.status === 422,
      'external=' + external.status + ' uploads=' + uploads.status + ' unknown=' + unknown.status);
  } catch (e) { record('9a. outside portrait links and unknown /files ids are refused', false, e.message); }

  /* 10. the real upload flow: PNG accepted, HTML refused -------------------- */
  let portraitUrl = null;
  try {
    const good = await uploadImage(admin.jar, base, admin.csrf, PNG_BYTES, 'portrait.png', 'image/png');
    portraitUrl = good.data && good.data.url;
    const badBytes = Buffer.from('<html><head><title>not an image</title></head><body>' +
      'x'.repeat(80) + '</body></html>');
    const bad = await uploadImage(admin.jar, base, admin.csrf, badBytes, 'portrait.html', 'text/html');
    record('10. portrait upload: real PNG stored as /files id, HTML refused',
      good.status === 201 && /^\/files\/[a-f0-9]{24}$/.test(portraitUrl || '') && bad.status === 415,
      'upload=' + good.status + ' url=' + portraitUrl + ' html=' + bad.status);
  } catch (e) { record('10. portrait upload: real PNG stored as /files id, HTML refused', false, e.message); }

  /* 11. the uploaded portrait is accepted and served publicly --------------- */
  try {
    const put = await call(admin.jar, base, 'PUT', '/api/org-chart/' + commId,
      { body: { portrait: portraitUrl }, csrf: admin.csrf });
    const pub = await call(newJar(), base, 'GET', '/api/org-chart');
    const row = (pub.data.entries || []).find(function (e) { return e.id === commId; });
    const served = await call(newJar(), base, 'GET', portraitUrl || '/files/nope');
    record('11. an uploaded portrait is stored, published and served',
      put.status === 200 && row && row.portrait === portraitUrl && served.status === 200,
      'put=' + put.status + ' publicPortrait=' + (row && row.portrait) + ' served=' + served.status);
  } catch (e) { record('11. an uploaded portrait is stored, published and served', false, e.message); }

  /* 12. a missing CSRF token is refused even for a signed-in admin ----------- */
  try {
    const r = await call(admin.jar, base, 'POST', '/api/org-chart',
      { body: { title: 'No CSRF token' } });       /* no csrf header */
    record('12. a missing CSRF token is refused for signed-in admins (403)',
      r.status === 403, 'status=' + r.status);
  } catch (e) { record('12. a missing CSRF token is refused for signed-in admins (403)', false, e.message); }

  /* 13. deleting a parent moves its children up one level -------------------- */
  try {
    const del = await call(admin.jar, base, 'DELETE', '/api/org-chart/' + commId, { csrf: admin.csrf });
    const adminList = await call(admin.jar, base, 'GET', '/api/org-chart/admin');
    const rows = adminList.data.entries || [];
    const psRow = rows.find(function (e) { return e.id === psId; });
    const gone = !rows.some(function (e) { return e.id === commId; });
    record('13. deleting a parent reparents its children (never orphans them)',
      del.status === 200 && del.data && del.data.reparented === 1 && gone &&
      psRow && psRow.parent_id === sgsId,
      'del=' + del.status + ' reparented=' + (del.data && del.data.reparented) +
      ' psParent=' + (psRow && psRow.parent_id));
  } catch (e) { record('13. deleting a parent reparents its children (never orphans them)', false, e.message); }

  /* 14. homepage hosts the dynamic chart; placeholders are gone ------------- */
  try {
    const page = await call(newJar(), base, 'GET', '/');
    const html = page.text;
    const sections = html.split('id="org-structure"').length - 1;
    const hosts = html.split('id="org-chart"').length - 1;
    const loadsRenderer = html.indexOf('<script src="/js/pages/org-chart.js">') !== -1;
    const loadsHome = html.indexOf('<script src="/js/pages/home.js">') !== -1;
    const loadsClean = html.indexOf('<script src="/js/pages/home-clean.js">') !== -1;
    const placeholdersGone = html.indexOf('[Name Placeholder]') === -1;
    record('14. homepage: one org section, dynamic host, renderer loaded, no placeholders',
      page.status === 200 && sections === 1 && hosts === 1 && loadsRenderer &&
      loadsHome && loadsClean && placeholdersGone,
      'sections=' + sections + ' hosts=' + hosts + ' renderer=' + loadsRenderer +
      ' home=' + loadsHome + ' clean=' + loadsClean + ' placeholdersGone=' + placeholdersGone);
  } catch (e) { record('14. homepage hosts the dynamic chart; placeholders are gone', false, e.message); }

  /* 15. renderer: chain/side-group/branch/units, placeholders, escaping ----- */
  try {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'org-chart.js'), 'utf8');
    const sandbox = {
      window: {},
      document: {
        getElementById: function () { return null; },
        querySelector: function () { return null; }
      },
      /* App.ready is never fired here, so no request leaves the sandbox. */
      App: {
        ready: function () {},
        esc: function (s) {
          return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
          });
        }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const org = sandbox.window && sandbox.window.__orgChart;

    const E = function (id, parent_id, title, portrait, category, order) {
      return { id: id, parent_id: parent_id, title: title, name: '', category: category,
        description: '', portrait: portrait || '', sort_order: order || 0, status: 'published' };
    };
    /* Commissioner -> Permanent Secretary; the spine NEVER follows a
     * directorate down, so all three directors share one branch row and the
     * heads/units hang underneath their own director. */
    const entries = [
      E(1, null, 'Hon. Commissioner', '', 'leadership', 0),
      E(2, 1, 'Hon. Perm. Secretary', '/files/abcdef0123456789abcdef01', 'leadership', 0),
      E(3, 2, 'Director of Admin', '', 'directorate', 0),
      E(4, 2, 'Director of Vocational', '', 'directorate', 1),
      E(5, 2, 'Director of Planning', '', 'directorate', 2),
      E(6, 4, 'Head, Vocational Studies', '', 'unit_board', 0),
      E(7, 4, 'Head, Skills <script>', 'https://evil.example/x.png', 'unit_board', 1),
      E(8, 6, 'Skills Acquisition Desk', '', 'unit_board', 0),
      E(9, 7, 'Trade Test Desk', '', 'unit_board', 0)
    ];
    const layout = org.buildLayout(entries);
    const html = org.render(layout);
    const n = function (cls) { return (html.split(cls).length - 1); };

    const shapeOk = !!layout && layout.spine.length === 2 &&
      layout.spine[0].id === 1 && layout.spine[1].id === 2 &&
      Object.keys(layout.side).length === 0 &&
      layout.branch.map(function (e) { return e.id; }).join(',') === '3,4,5';
    const cardsOk = n('org-card--chain') === 2 && n('org-card--compact') === 3 &&
      n('org-card--unit') === 4;
    const portraitsOk = html.indexOf('/files/abcdef0123456789abcdef01') !== -1 &&
      n('is-placeholder') === 8;                  /* every card but the uploaded one */
    const safetyOk = html.indexOf('<script>') === -1 &&
      html.indexOf('&lt;script&gt;') !== -1 &&   /* the title is escaped, not run */
      html.indexOf('evil.example') === -1;       /* outside links never render */
    record('15. renderer builds the hierarchy, placeholders and escaping', !!org &&
      shapeOk && cardsOk && portraitsOk && safetyOk,
      'spine=' + (layout && layout.spine.length) + ' side=' + (layout && (layout.side[2] || []).length) +
      ' branch=' + (layout && layout.branch.length) +
      ' cards=' + n('org-card--chain') + '/' + n('org-card--compact') + '/' + n('org-card--unit') +
      ' placeholders=' + n('is-placeholder'));

    /* An empty list never throws and never renders a card. */
    const emptyLayout = org.buildLayout([]);
    record('16. an empty chart renders the neutral note instead of a tree',
      emptyLayout === null, 'layout=' + String(emptyLayout));
  } catch (e) { record('15. renderer builds the hierarchy, placeholders and escaping', false, e.message); }

  /* 17. leadership roots ride ABOVE the chain (ministry diagram) ----------- */
  try {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'org-chart.js'), 'utf8');
    const sandbox = {
      window: {},
      document: {
        getElementById: function () { return null; },
        querySelector: function () { return null; }
      },
      App: {
        ready: function () {},
        esc: function (s) {
          return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
          });
        }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const org = sandbox.window && sandbox.window.__orgChart;

    const E = function (id, parent_id, title, portrait, category, order) {
      return { id: id, parent_id: parent_id, title: title, name: '', category: category,
        description: '', portrait: portrait || '', sort_order: order || 0, status: 'published' };
    };
    /* The production shape: SGS and Commissioner are top-level too, and the
     * chain stops at the Permanent Secretary — the spine never follows a
     * directorate, so all four sibling reports share ONE branch row.
     * A childless non-leadership root stays in the branch row. */
    const entries = [
      E(1, null, 'Secretary to the Government (SGS)', '', 'leadership', 1),
      E(2, null, 'Hon. Commissioner', '', 'leadership', 2),
      E(3, null, 'Permanent Secretary', '', 'leadership', 3),
      E(4, 3, 'Director of Admin', '', 'directorate', 0),
      E(5, 3, 'Director of Vocational', '', 'directorate', 1),
      E(6, 3, 'Director of Planning', '', 'directorate', 2),
      E(7, 3, 'Secretary to the Ministry', '', 'unit_board', 3),
      E(8, 5, 'Head, Vocational Studies', '', 'unit_board', 0),
      E(9, 5, 'Head, Skills Acquisition', '', 'unit_board', 1),
      E(10, 8, 'Trade Test Desk', '', 'unit_board', 0),
      E(11, 9, 'Skills Desk', '', 'unit_board', 0),
      E(12, 99, 'Orphan Unit (parent still draft)', '', 'unit_board', 0)
    ];
    const layout = org.buildLayout(entries);
    const html = org.render(layout);
    const topIds = (layout.top || []).map(function (n) { return n.id; });
    const branchIds = (layout.branch || []).map(function (n) { return n.id; });

    const topOk = topIds.join(',') === '1,2';               /* SGS first, Commissioner beside */
    const spineOk = layout.spine.length === 1 && layout.spine[0].id === 3;
    const sideOk = Object.keys(layout.side).length === 0;   /* nothing parked beside */
    const branchOk = branchIds.join(',') === '4,5,6,7,12';  /* every directorate + orphan, one row */
    const orderOk = html.indexOf('org-leaders') !== -1 &&
      html.indexOf('org-leaders') < html.indexOf('org-spine') &&
      html.indexOf('org-spine') < html.indexOf('org-branch');
    const cardsOk = (html.split('org-card--chain').length - 1) === 3;  /* 2 top + 1 spine */
    const orphanVisible = html.indexOf('Orphan Unit') !== -1 &&
      html.indexOf('Vocational Studies') !== -1 &&           /* heads hang UNDER their director */
      html.indexOf('Trade Test Desk') !== -1;
    record('17. leadership roots render above the chain, the rest in place',
      !!org && topOk && spineOk && sideOk && branchOk && orderOk && cardsOk && orphanVisible,
      'top=[' + topIds + '] spine=[' + layout.spine.map(function (n) { return n.id; }) + ']' +
      ' sideKeys=[' + Object.keys(layout.side) + ']' +
      ' branch=[' + branchIds + '] chainCards=' +
      (html.split('org-card--chain').length - 1));
  } catch (e) { record('17. leadership roots render above the chain, the rest in place', false, e.message); }

  /* 18. fit-to-page: no sideways scrolling anywhere ------------------------ */
  try {
    const vm18 = require('vm');
    const src18 = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'org-chart.js'), 'utf8');
    const sandbox18 = {
      window: {},
      document: { getElementById: function () { return null; }, querySelector: function () { return null; } },
      App: { ready: function () {}, esc: function (s) { return String(s); } }
    };
    vm18.createContext(sandbox18);
    vm18.runInContext(src18, sandbox18);
    const org18 = sandbox18.window && sandbox18.window.__orgChart;
    const E18 = function (id, parent_id, title, category, order) {
      return { id: id, parent_id: parent_id, title: title, name: '', category: category,
        description: '', portrait: '', sort_order: order || 0, status: 'published' };
    };
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'main.css'), 'utf8');
    const layout18 = org18.buildLayout([
      E18(1, null, 'Secretary to the Government (SGS)', 'leadership', 1),
      E18(2, null, 'Hon. Commissioner', 'leadership', 2),
      E18(3, null, 'Permanent Secretary', 'leadership', 3),
      E18(4, 3, 'Director of Admin', 'directorate', 0),
      E18(5, 3, 'Director of Vocational', 'directorate', 1),
      E18(6, 3, 'Director of Planning', 'directorate', 2),
      E18(7, 5, 'Head, Vocational Studies', 'unit_board', 0),
      E18(8, 3, 'Director of New Services', 'directorate', 3),
      E18(9, 3, 'Store Keeper', 'directorate', 4),
      E18(10, 3, 'Director of Extra Duties', 'directorate', 5)
    ]);
    /* All six directors share ONE horizontal row in admin order; nothing is
     * parked beside the chain and no sideways-scroll markup is rendered. */
    const htmlSrc = org18.render(layout18);
    const headPos = htmlSrc.indexOf('Head, Vocational Studies');
    const vocPos = htmlSrc.indexOf('Director of Vocational');
    const planPos = htmlSrc.indexOf('Director of Planning');
    const directorsOnOneRow = layout18 &&
      layout18.branch.map(function (e) { return e.id; }).join(',') === '4,5,6,8,9,10' &&
      Object.keys(layout18.side).length === 0 &&
      htmlSrc.split('org-branch-item').length - 1 === 6 &&
      htmlSrc.indexOf('org-branch-scroll') === -1 &&
      htmlSrc.indexOf('org-scroll-hint') === -1 &&
      vocPos !== -1 && headPos > vocPos && planPos > headPos;
    /* Both fixed rows stay on ONE line (JS scales them with fitChart); only
     * the emergency fallback unwraps, and sideways overflow is clipped
     * inside the homepage slot. */
    const oneLineOk = /\.org-leaders-row\{[^}]*flex-wrap:\s*nowrap/.test(css) &&
      /\.org-branch-row\{[^}]*flex-wrap:\s*nowrap/.test(css) &&
      /\.org-branch-row\{[^}]*justify-content:\s*center/.test(css) &&
      css.indexOf('.org-scroll-hint') === -1;
    record('18. the whole chart fits the page width, no sideways scrolling',
      directorsOnOneRow && oneLineOk,
      'oneRow=' + directorsOnOneRow + ' oneLine=' + oneLineOk);
  } catch (e) { record('18. the whole chart fits the page width, no sideways scrolling', false, e.message); }

  /* ---- report: close resources first, then exit NATURALLY ----------------- */
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


