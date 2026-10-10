/**
 * tools/smoke-register-school.js — end-to-end check for the public
 * "Register a school" flow: /register-school.html is served, /api/schools/options
 * feeds the picklists, anonymous POST is refused, and an allowed role can
 * create a school that shows up in the directory. Boots its own app on a
 * throwaway SQLite DB (deleted afterwards). `node tools/smoke-register-school.js`
 */
'use strict';

process.env.DB_FILE = './data/portal-smoke-reg.db';
process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-that-is-long-enough-for-register-school-smoke';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SQLITE_DB = path.resolve(ROOT, './data/portal-smoke-reg.db');
const PORT = 3996;

['', '-wal', '-shm', '-journal'].forEach(function (suf) {
  try { fs.rmSync(SQLITE_DB + suf, { force: true }); } catch (e) { /* ignore */ }
});

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

function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const csrf = require('../middleware/csrf');
  const auth = require('../middleware/auth');
  const { notFound, errorHandler } = require('../middleware/errors');
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
  /* The real page and its script must be served. */
  app2.get('/register-school.html', function (req, res) {
    res.sendFile(path.join(ROOT, 'public', 'register-school.html'));
  });
  app2.get('/js/pages/register-school.js', function (req, res) {
    res.sendFile(path.join(ROOT, 'public', 'js', 'pages', 'register-school.js'));
  });
  app2.use(notFound);
  app2.use(errorHandler);
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
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        (res.headers['set-cookie'] || []).forEach(function (line) {
          const pair = String(line).split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) jar.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        });
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = { _raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sessionFor(userId) {
  const testAuth = require('../middleware/auth');
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  const jar = newJar();
  jar.cookies[testAuth.COOKIE_NAME] = testAuth.signToken(user);
  return { jar: jar, csrf: '' };
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
    }
  };
}

async function runAll() {
  /* The page itself. */
  const anon = { get: function (p) { return jarRequest(newJar(), 'GET', p); } };
  let r = await anon.get('/register-school.html');
  check('GET /register-school.html serves the form',
    r.status === 200 && r.raw.indexOf('id="register-form"') !== -1 &&
    r.raw.indexOf('/js/pages/register-school.js') !== -1, 'got ' + r.status);
  r = await anon.get('/js/pages/register-school.js');
  check('register-school.js is served', r.status === 200, 'got ' + r.status);

  /* The picklists the form depends on. */
  r = await anon.get('/api/schools/options');
  check('GET /options feeds the form (16 LGAs, types, categories, boarding)',
    r.status === 200 && r.body.lgas.length === 16 && r.body.types.length === 4 &&
    r.body.categories.length === 3 && r.body.boarding.length === 3, r.body);

  /* Anonymous creation is refused (401 from requireAuth, behind CSRF). */
  r = await jarRequest(newJar(), 'POST', '/api/schools',
    { name: 'Smoke Anon School', lga: 'Jalingo', type: 'technical',
      category: 'mixed', boarding: 'day' });
  check('anonymous POST /api/schools is refused (401/403)',
    r.status === 401 || r.status === 403, 'got ' + r.status);

  /* A real account can create a school through the same endpoint the form
   * POSTs to, and it lands in the public directory. */
  const hash = await require('bcrypt').hash('Testpass123!', 4);
  const info = await db.run(
    "INSERT INTO users (email, password_hash, full_name, role, status) VALUES (?, ?, ?, 'OWNER', 'ACTIVE')",
    ['smoke-owner@example.com', hash, 'Smoke Owner']);
  const owner = authed(await bootCsrf(await sessionFor(info.lastInsertRowid)));
  const newSchool = {
    name: 'Smoke Registered School', lga: 'Jalingo', type: 'technical',
    category: 'mixed', boarding: 'day', address: 'Smoke Street',
    principal: 'P. Smoke', phone: '08030000000', email: '', year_established: '1999'
  };
  r = await owner.post('/api/schools', newSchool);
  check('owner POST /api/schools answers 201 with an id',
    r.status === 201 && typeof r.body.id === 'number', r);
  r = await anon.get('/api/schools?q=Smoke%20Registered');
  check('the new school is in the public directory',
    r.status === 200 && r.body.total === 1 &&
    r.body.schools[0].name === 'Smoke Registered School', r.body);

  /* Duplicate name in the same LGA is a 409, matching the form's error box. */
  r = await owner.post('/api/schools', newSchool);
  check('duplicate school name answers 409', r.status === 409, 'got ' + r.status);

  /* Validation errors come back as { error, errors:[...] } for the form. */
  r = await owner.post('/api/schools', { name: '', lga: 'Nowhere', type: 'x' });
  check('bad input answers 422 with an errors array',
    r.status === 422 && Array.isArray(r.body.errors) && r.body.errors.length >= 3, r.body);
}

function bootAndRun() {
  return new Promise(function (resolve, reject) {
    const server = buildApp().listen(PORT, '127.0.0.1', function () {
      runAll().then(function () { server.close(function () { resolve(); }); })
        .catch(function (e) { server.close(function () { reject(e); }); });
    });
  });
}

bootAndRun().then(function () {
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(SQLITE_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
  console.log('\n[register-school-smoke] passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.error('[register-school-smoke] FATAL', e);
  process.exit(1);
});
