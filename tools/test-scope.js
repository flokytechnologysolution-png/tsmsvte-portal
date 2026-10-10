/**
 * tools/test-scope.js — the scope suite: LGA / school isolation end-to-end.
 *
 * Builds its own Express app (same middleware + routes as server.js), seeds a
 * handful of schools and users through the universal db API, and asserts the
 * rules documented in middleware/scope.js:
 *   - scoped roles only ever see their own slice,
 *   - anything outside the scope is 404 (never 403, never leaked),
 *   - an unresolvable scope fails CLOSED (matches nothing).
 *
 * Runs on SQLite (fresh ./data/portal-test-scope.db, deleted afterwards) or on
 * any PostgreSQL database named by DATABASE_URL (drop/create it before each
 * run).  `node tools/test-scope.js`   (exit code 0 = all good)
 */
'use strict';

if (!process.env.DATABASE_URL) process.env.DB_FILE = './data/portal-test-scope.db';
process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-that-is-long-enough-for-scope-suite-verification';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SQLITE_DB = path.resolve(ROOT, './data/portal-test-scope.db');
const PORT = 3998;

/* Fresh SQLite file so the 16 LGAs + owner seed rebuild themselves. */
if (!process.env.DATABASE_URL) {
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(SQLITE_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
}

const db = require('../db');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ok   ' + name); }
  else {
    failed += 1;
    console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

/* Same stack as server.js, minus listen() and the banner. */
function buildTestApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const csrf = require('../middleware/csrf');
  const auth = require('../middleware/auth');
  const app2 = express();
  app2.use(cookieParser());
  app2.use(express.json({ limit: '1mb' }));
  app2.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app2.use(csrf.issueToken);
  app2.use('/api', csrf.verify);
  app2.use(auth.attachUser);
  app2.get('/api/auth/csrf', function (req, res) { res.json({ csrfToken: res.locals.csrfToken }); });
  app2.use('/api/auth', require('../routes/auth'));
  app2.use('/api/schools', require('../routes/schools'));
  app2.use('/api/staff', require('../routes/staff'));
  app2.use('/api/teachers', require('../routes/teachers'));
  return app2;
}

function newJar() { return { cookies: {} }; }

function jarRequest(jar, method, urlPath, body, extraHeaders) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const cookieHeader = Object.keys(jar.cookies || {})
      .map(function (k) { return k + '=' + jar.cookies[k]; }).join('; ');
    const headers = { 'Content-Type': 'application/json' };
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    Object.keys(extraHeaders || {}).forEach(function (k) { headers[k] = extraHeaders[k]; });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method, headers: headers
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (e) { /* non-JSON (CSV etc.) */ }
        const setCookies = res.headers['set-cookie'] || [];
        setCookies.forEach(function (c) {
          const kv = String(c).split(';')[0];
          const eq = kv.indexOf('=');
          if (eq > 0) jar.cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
        });
        resolve({ status: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* Sessions are minted directly: read the user row, sign a JWT exactly like
 * the login route does. No password or rate limiter involved. */
const testAuth = require('../middleware/auth');
async function sessionFor(userId) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  const jar = newJar();
  jar.cookies[testAuth.COOKIE_NAME] = testAuth.signToken(user);
  return { jar: jar, csrf: null };
}

async function bootCsrf(sess) {
  const r = await jarRequest(sess.jar, 'GET', '/api/auth/csrf');
  if (r.status !== 200) throw new Error('csrf bootstrap failed: ' + r.status);
  sess.csrf = sess.jar.cookies.tsmsvte_csrf || '';
  return sess;
}

function authed(sess) {
  const jar = sess.jar;
  return {
    get: function (p) { return jarRequest(jar, 'GET', p); },
    post: function (p, b) {
      return jarRequest(jar, 'POST', p, b === undefined ? {} : b, { 'x-csrf-token': sess.csrf });
    },
    del: function (p) { return jarRequest(jar, 'DELETE', p, undefined, { 'x-csrf-token': sess.csrf }); }
  };
}

async function runAll() {
  const lgas = await db.query('SELECT id, name FROM lgas ORDER BY sort_order');
  const lgaA = lgas[0];
  const lgaB = lgas[1] || lgas[0];
  console.log('[scope-test] LGA A=' + lgaA.name + ' B=' + lgaB.name);

  const mkSchool = async function (name, lga) {
    const info = await db.run(
      "INSERT INTO schools (name, lga, lga_id, type, category, boarding, status)" +
      " VALUES (?, ?, ?, 'junior_secondary', 'mixed', 'day', 'active')",
      [name, lga.name, lga.id]
    );
    return info.lastInsertRowid;
  };
  const s1 = await mkSchool('Scope School One', lgaA);
  const s2 = await mkSchool('Scope School Two', lgaA);
  const s3 = await mkSchool('Scope School Three', lgaB);

  const hash = await require('bcrypt').hash('Testpass123!', 4);
  const mkUser = async function (email, role, lgaId, schoolId) {
    const info = await db.run(
      "INSERT INTO users (email, password_hash, full_name, role, status, lga_id, school_id)" +
      " VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)",
      [email, hash, email.split('@')[0], role, lgaId, schoolId]
    );
    return info.lastInsertRowid;
  };
  const idOwner = await mkUser('scope-owner@example.com', 'OWNER', null, null);
  const idAdmin = await mkUser('scope-admin@example.com', 'ADMIN', null, null);
  const idOffA = await mkUser('scope-offA@example.com', 'LGA_OFFICER', lgaA.id, null);
  const idOffB = await mkUser('scope-offB@example.com', 'LGA_OFFICER', lgaB.id, null);
  const idAdm1 = await mkUser('scope-school1@example.com', 'SCHOOL_ADMIN', lgaA.id, s1);
  const idEditor = await mkUser('scope-editor@example.com', 'EDITOR', null, null);
  const idStaff = await mkUser('scope-staff@example.com', 'STAFF', null, null);
  /* A broken assignment (no such LGA) must fail CLOSED, never open. */
  const idGhost = await mkUser('scope-ghost@example.com', 'LGA_OFFICER', 999999, null);

  const owner = authed(await bootCsrf(await sessionFor(idOwner)));
  const admin = authed(await bootCsrf(await sessionFor(idAdmin)));
  const offA = authed(await bootCsrf(await sessionFor(idOffA)));
  const offB = authed(await bootCsrf(await sessionFor(idOffB)));
  const adm1 = authed(await bootCsrf(await sessionFor(idAdm1)));
  const editor = authed(await bootCsrf(await sessionFor(idEditor)));
  const staff = authed(await bootCsrf(await sessionFor(idStaff)));
  const ghost = authed(await bootCsrf(await sessionFor(idGhost)));
  const anon = { get: function (p) { return jarRequest(newJar(), 'GET', p); } };

  const names = function (rr) {
    return (rr.body.schools || []).map(function (x) { return x.name; }).sort();
  };

  /* ---------------- the public directory and its scoping ---------------- */
  let r = await anon.get('/api/schools');
  check('anonymous sees all 3 schools', r.status === 200 && r.body.total === 3, r.body);
  check('total is a JSON number (bigint parsed)', typeof r.body.total === 'number', typeof r.body.total);

  r = await owner.get('/api/schools');
  check('owner sees all 3', r.status === 200 && r.body.total === 3, r.body);
  r = await admin.get('/api/schools');
  check('admin sees all 3', r.status === 200 && r.body.total === 3, r.body);
  r = await editor.get('/api/schools');
  check('editor sees all 3', r.status === 200 && r.body.total === 3, r.body);
  r = await staff.get('/api/schools');
  check('staff sees all 3', r.status === 200 && r.body.total === 3, r.body);

  r = await offA.get('/api/schools');
  check('officer A sees only their LGA (2)',
    r.status === 200 && r.body.total === 2 &&
    names(r).join() === 'Scope School One,Scope School Two', r.body);
  r = await offB.get('/api/schools');
  check('officer B sees only their LGA (1)',
    r.status === 200 && r.body.total === 1 && names(r)[0] === 'Scope School Three', r.body);
  r = await adm1.get('/api/schools');
  check('school admin sees only their school (1)',
    r.status === 200 && r.body.total === 1 && names(r)[0] === 'Scope School One', r.body);
  r = await ghost.get('/api/schools');
  check('unresolvable scope fails CLOSED (0 rows)',
    r.status === 200 && r.body.total === 0, r.body);

  /* ------------------------ row guards are 404 ------------------------- */
  r = await offA.get('/api/schools/' + s3);
  check('officer A: other LGA row is 404, not 403', r.status === 404, 'got ' + r.status);
  r = await offA.get('/api/schools/' + s1);
  check('officer A: own LGA row is 200',
    r.status === 200 && r.body.school && r.body.school.id === s1, r.body);
  r = await adm1.get('/api/schools/' + s2);
  check('school admin: other school row is 404', r.status === 404, 'got ' + r.status);
  r = await adm1.get('/api/schools/' + s1);
  check('school admin: own school row is 200', r.status === 200, 'got ' + r.status);
  r = await ghost.get('/api/schools/' + s1);
  check('ghost officer: every row is 404', r.status === 404, 'got ' + r.status);
  r = await anon.get('/api/schools/' + s1);
  check('anonymous: directory rows stay public', r.status === 200, 'got ' + r.status);

  /* ---------------- /lgas and /options (both were 500s) ---------------- */
  r = await anon.get('/api/schools/lgas');
  check('GET /lgas answers 200 with 16 LGAs',
    r.status === 200 && r.body.total_lgas === 16 && r.body.lgas.length === 16, r.body);
  check('per-LGA COUNT total comes back as a number',
    typeof r.body.lgas[0].total === 'number', typeof r.body.lgas[0].total);
  r = await offA.get('/api/schools/lgas');
  check('officer A: /lgas is scoped to their LGA',
    r.status === 200 && r.body.total_lgas === 1, r.body);
  r = await anon.get('/api/schools/options');
  check('GET /options answers 200 with 16 LGAs',
    r.status === 200 && r.body.lgas.length === 16, r.body);

  /* ------------------ creating rows inside / outside scope -------------- */
  const newSchool = {
    name: 'Scope Created By Officer A', lga: lgaA.name, type: 'junior_secondary',
    category: 'mixed', boarding: 'day', address: 'x', principal: 'p', phone: '0800', email: ''
  };
  r = await offA.post('/api/schools', newSchool);
  check('officer A may create inside own LGA (201)',
    r.status === 201 && typeof r.body.id === 'number',
    r.status + ' ' + JSON.stringify(r.body));
  r = await offA.post('/api/schools', Object.assign({}, newSchool, { name: 'Outside A', lga: lgaB.name }));
  check('officer A may NOT create in another LGA (422)', r.status === 422, 'got ' + r.status);
  r = await offB.post('/api/schools', Object.assign({}, newSchool, { name: 'Outside B', lga: lgaA.name }));
  check("officer B may NOT create in officer A's LGA (422)", r.status === 422, 'got ' + r.status);
  r = await adm1.post('/api/schools', Object.assign({}, newSchool, { name: 'School admin create' }));
  check('school admin cannot create schools (403)', r.status === 403, 'got ' + r.status);

  /* ------------------------- the users console -------------------------- */
  r = await jarRequest(newJar(), 'GET', '/api/staff/users/list');
  check('anonymous: users list is 401', r.status === 401, 'got ' + r.status);
  r = await editor.get('/api/staff/users/list');
  check('editor: users list is 403', r.status === 403, 'got ' + r.status);

  const emails = function (rr) {
    return (rr.body.users || []).map(function (u) { return u.email; });
  };
  r = await owner.get('/api/staff/users/list');
  const ownerList = emails(r);
  check('owner list includes owner and admin',
    r.status === 200 && r.body.scope === 'all' &&
    ownerList.indexOf('scope-owner@example.com') !== -1 &&
    ownerList.indexOf('scope-admin@example.com') !== -1, r.body);
  r = await admin.get('/api/staff/users/list');
  check('admin list hides the owner',
    r.status === 200 && emails(r).indexOf('scope-owner@example.com') === -1 &&
    emails(r).indexOf('scope-admin@example.com') !== -1, r.body);
  r = await offA.get('/api/staff/users/list');
  const aList = emails(r);
  check('officer A list: own LGA accounts only (no owner/admin/other LGA)',
    r.status === 200 && r.body.scope === 'lga' &&
    aList.indexOf('scope-offA@example.com') !== -1 &&
    aList.indexOf('scope-school1@example.com') !== -1 &&
    aList.indexOf('scope-offB@example.com') === -1 &&
    aList.indexOf('scope-owner@example.com') === -1 &&
    aList.indexOf('scope-admin@example.com') === -1 &&
    aList.indexOf('scope-editor@example.com') === -1, r.body);
  r = await adm1.get('/api/staff/users/list');
  check('school admin list: own school account only',
    r.status === 200 && r.body.scope === 'school' &&
    emails(r).join() === 'scope-school1@example.com', r.body);
  r = await ghost.get('/api/staff/users/list');
  check('ghost officer: users list refused (403, fails closed)', r.status === 403, 'got ' + r.status);

  /* -------------------- teachers console role gate ---------------------- */
  r = await editor.get('/api/teachers');
  check('editor: teachers register is 403', r.status === 403, 'got ' + r.status);
  r = await staff.get('/api/teachers');
  check('staff: teachers register is 403', r.status === 403, 'got ' + r.status);
  r = await offA.get('/api/teachers');
  check('officer A: teachers register is 200', r.status === 200, 'got ' + r.status);
  r = await offA.get('/api/teachers/options');
  check('officer A: teachers /options answers 200', r.status === 200, 'got ' + r.status);
}

function bootAndRun() {
  return new Promise(function (resolve, reject) {
    const server = buildTestApp().listen(PORT, '127.0.0.1', function () {
      runAll().then(function () { server.close(function () { resolve(); }); })
        .catch(function (e) { server.close(function () { reject(e); }); });
    });
  });
}

function cleanupSqlite() {
  if (process.env.DATABASE_URL) return;
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(SQLITE_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
}

bootAndRun().then(function () {
  cleanupSqlite();
  console.log('\n[scope-test] passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.error('[scope-test] FATAL', e);
  cleanupSqlite();
  process.exit(1);
});
