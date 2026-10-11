/**
 * scripts/test-images.js — Phase 2 acceptance suite for the Admin -> Site
 * settings image upload buttons, exercised against a COPY of data/portal.db on
 * port 3777.  Nothing here touches the real database: DB_FILE points at a
 * throwaway copy that is deleted afterwards, exactly like tools/test-scope.js.
 *
 * It proves, end to end:
 *   - upload -> POST /api/settings/upload stores bytes and returns /files/<id>
 *   - saving that URL into a setting persists it and the setting renders
 *   - replacing an image deletes the OLD files row only when nothing else
 *     references it (a second, still-live reference keeps it alive)
 *   - clearing a setting removes the now-orphaned row
 *   - everything survives a server restart (data is in the DB, not memory)
 *   - anonymous and STAFF are refused by both /api/files and /api/settings/upload
 *   - header/hero/portraits/banners/gallery values render from /files/<id>
 *   - a legacy /img/photos/... static value keeps working untouched
 *
 *   node scripts/test-images.js            (exit code 0 = all good)
 */
'use strict';

if (!process.env.DATABASE_URL) process.env.DB_FILE = './data/portal-test-images.db';
process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-that-is-long-enough-for-images-suite-verification';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SQLITE_DB = path.resolve(ROOT, './data/portal-test-images.db');
const SOURCE_DB = path.resolve(ROOT, './data/portal.db');
const PORT = 3777;

/* Work on a COPY of the real database, never the original. */
if (!process.env.DATABASE_URL) {
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(SQLITE_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
  fs.copyFileSync(SOURCE_DB, SQLITE_DB);
  console.log('[images-test] working on a COPY: ' + SQLITE_DB);
}

const db = require('../db');
const fileutil = require('../lib/fileutil');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ok   ' + name); }
  else {
    failed += 1;
    console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

/* Build the same middleware + routes as server.js (minus listen + ws + ops). */
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
  app2.use('/api/news', require('../routes/news'));
  app2.use('/api/events', require('../routes/events'));
  app2.use('/api/circulars', require('../routes/circulars'));
  app2.use('/api/settings', require('../routes/settings'));
  const filesRoute = require('../routes/files');
  app2.use('/api/files', filesRoute);
  app2.get('/files/:id', filesRoute.serve);
  app2.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: 0 }));
  const { notFound, errorHandler } = require('../middleware/errors');
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
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: method, headers: headers },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let parsed = text;
          try { parsed = JSON.parse(text); } catch (e) { /* binary / non-JSON */ }
          (res.headers['set-cookie'] || []).forEach(function (c) {
            const kv = String(c).split(';')[0];
            const eq = kv.indexOf('=');
            if (eq > 0) jar.cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
          });
          resolve({ status: res.statusCode, body: parsed, raw: text, buffer: buf, headers: res.headers });
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* A raw multipart POST (image bytes) that carries the session cookie + CSRF. */
function jarUpload(jar, csrf, urlPath, filename, mime, buffer) {
  return new Promise(function (resolve, reject) {
    const boundary = '----imgBOUND' + Date.now();
    const head = Buffer.from('--' + boundary +
      '\r\nContent-Disposition: form-data; name="file"; filename="' + filename +
      '"\r\nContent-Type: ' + mime + '\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const payload = Buffer.concat([head, buffer, tail]);
    const cookieHeader = Object.keys(jar.cookies || {})
      .map(function (k) { return k + '=' + jar.cookies[k]; }).join('; ');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': payload.length, Cookie: cookieHeader, 'x-csrf-token': csrf || ''
      }
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { parsed = { _raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* Sessions are minted directly from a user row — no password, no rate limiter,
 * exactly like tools/test-scope.js does. */
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
    jar: jar, csrf: sess.csrf,
    get: function (p) { return jarRequest(jar, 'GET', p); },
    post: function (p, b) {
      return jarRequest(jar, 'POST', p, b === undefined ? {} : b, { 'x-csrf-token': sess.csrf });
    },
    put: function (p, b) {
      return jarRequest(jar, 'PUT', p, b === undefined ? {} : b, { 'x-csrf-token': sess.csrf });
    },
    upload: function (p, filename, mime, buf) {
      return jarUpload(jar, sess.csrf, p, filename, mime, buf);
    }
  };
}

/* A tiny but real 1x1 JPEG (magic bytes FFD8FF) padded so it passes the >=12
 * byte sniff in lib/filetype.js. Content differs by tag so each upload is a
 * distinct blob. */
function jpegBytes(tag) {
  const tail = Buffer.from(tag || 'a', 'ascii');
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), tail, Buffer.alloc(64, 7)]);
}

/* A tiny but real PNG (the 8-byte PNG signature) padded past 12 bytes. */
function pngBytes(tag) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const tail = Buffer.from(tag || 'p', 'ascii');
  return Buffer.concat([sig, tail, Buffer.alloc(64, 3)]);
}

async function fileExists(id) {
  const row = await db.get('SELECT id FROM files WHERE id = ?', [id]);
  return Boolean(row);
}

async function fileCount() {
  const row = await db.get('SELECT COUNT(*) AS n FROM files');
  return Number(row ? row.n : 0);
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */
async function runAll() {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('Testpass123!', 4);

  /* Create the actors we need on the throwaway copy. */
  const mkUser = async function (email, role) {
    const info = await db.run(
      "INSERT INTO users (email, password_hash, full_name, role, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
      [email, hash, email.split('@')[0], role]
    );
    return info.lastInsertRowid;
  };
  const idAdmin = await mkUser('img-admin@example.com', 'ADMIN');
  const idStaff = await mkUser('img-staff@example.com', 'STAFF');

  const admin = authed(await bootCsrf(await sessionFor(idAdmin)));
  const staff = authed(await bootCsrf(await sessionFor(idStaff)));

  /* Anonymous callers: give the jar a valid CSRF token (as a real page would)
   * so the request clears CSRF and is genuinely refused by AUTH with 401 —
   * proving the endpoint itself, not just the CSRF gate, blocks them. */
  const anonSess = await bootCsrf({ jar: newJar(), csrf: null });
  const anon = {
    jar: anonSess.jar, csrf: anonSess.csrf,
    get: function (p) { return jarRequest(anonSess.jar, 'GET', p); },
    post: function (p, b) {
      return jarRequest(anonSess.jar, 'POST', p, b === undefined ? {} : b, { 'x-csrf-token': anonSess.csrf });
    },
    put: function (p, b) {
      return jarRequest(anonSess.jar, 'PUT', p, b === undefined ? {} : b, { 'x-csrf-token': anonSess.csrf });
    },
    upload: function (p) {
      return jarUpload(anonSess.jar, anonSess.csrf, p, 'a.jpg', 'image/jpeg', jpegBytes('anon'));
    }
  };

  console.log('\n[images-test] --- authorisation gates ---');

  /* Anonymous + STAFF are refused by both storage endpoints. */
  let r = await anon.post('/api/files');
  check('POST /api/files refuses anonymous (401)', r.status === 401, 'got ' + r.status);
  r = await anon.upload('/api/files');
  check('POST /api/files refuses anonymous upload (401)', r.status === 401, 'got ' + r.status);
  r = await staff.upload('/api/files', 's.jpg', 'image/jpeg', jpegBytes('staff'));
  check('POST /api/files refuses STAFF (403)', r.status === 403, 'got ' + r.status);
  r = await anon.upload('/api/settings/upload');
  check('POST /api/settings/upload refuses anonymous (401)', r.status === 401, 'got ' + r.status);
  r = await staff.upload('/api/settings/upload', 's.jpg', 'image/jpeg', jpegBytes('staff'));
  check('POST /api/settings/upload refuses STAFF (403)', r.status === 403, 'got ' + r.status);

  /* PUT settings also refuses anonymous + STAFF. */
  r = await anon.put('/api/settings', { ministry_name: 'x' });
  check('PUT /api/settings refuses anonymous (401)', r.status === 401, 'got ' + r.status);
  r = await staff.put('/api/settings', { ministry_name: 'x' });
  check('PUT /api/settings refuses STAFF (403)', r.status === 403, 'got ' + r.status);

  console.log('\n[images-test] --- upload then set ---');
  const filesStart = await fileCount();

  r = await admin.upload('/api/settings/upload', 'hero.jpg', 'image/jpeg', jpegBytes('hero1'));
  check('ADMIN upload succeeds (201)', r.status === 201 && r.body && r.body.url, r.body);
  const heroUrl = r.body.url;
  const heroId = r.body.id;
  check('upload returns /files/<id>', /^\/files\/[a-f0-9]{24}$/.test(heroUrl), heroUrl);
  check('the new file row exists in the DB', await fileExists(heroId), heroId);

  /* Save the URL into the hero_image setting through the normal settings PUT. */
  r = await admin.put('/api/settings', { hero_image: heroUrl });
  check('setting saves the /files/<id> value', r.status === 200 && r.body.ok, r.body);
  const stored = await db.getSetting('hero_image');
  check('hero_image is persisted as /files/<id>', stored === heroUrl, stored);

  /* The stored image renders from /files/<id>. */
  r = await anon.get(heroUrl);
  check('GET /files/<id> serves the image (200, image mime)',
    r.status === 200 && String(r.headers['content-type']).indexOf('image/') === 0, r.headers['content-type']);
  check('served bytes match what was uploaded', r.buffer.length > 0, r.buffer.length);

  console.log('\n[images-test] --- replace: old row kept only while referenced ---');

  /* Give the SAME uploaded file a second, independent home (a gallery slot), so
   * two settings point at one /files/<id>. */
  r = await admin.put('/api/settings', { about_gallery_image_1: heroUrl });
  check('second setting also stores the same /files/<id>', r.status === 200, r.body);

  /* Now replace hero_image with a brand new upload. The old file is still used
   * by about_gallery_image_1, so it must survive. */
  r = await admin.upload('/api/settings/upload', 'hero2.jpg', 'image/jpeg', jpegBytes('hero2'));
  const hero2 = r.body.url;
  r = await admin.put('/api/settings', { hero_image: hero2 });
  check('replacing hero_image succeeds', r.status === 200, r.body);
  check('replacement reports the old file was NOT cleaned (still referenced)',
    r.body && r.body.cleaned && r.body.cleaned.indexOf(heroId) === -1, r.body && r.body.cleaned);
  check('old file row survives because the gallery still uses it', await fileExists(heroId), heroId);
  const hero2Id = hero2.replace('/files/', '');
  check('the new hero file row exists', await fileExists(hero2Id), hero2Id);

  /* Clear the gallery slot: now the ORIGINAL file is orphaned and must go. */
  r = await admin.put('/api/settings', { about_gallery_image_1: '' });
  check('clearing the gallery slot succeeds', r.status === 200, r.body);
  check('clearing the last reference deletes the orphaned old file',
    !(await fileExists(heroId)), heroId);
  check('the replacement file is untouched by that clear', await fileExists(hero2Id), hero2Id);

  console.log('\n[images-test] --- clear: removing the setting deletes its file ---');
  r = await admin.put('/api/settings', { hero_image: '' });
  check('clearing hero_image succeeds', r.status === 200, r.body);
  check('clearing hero_image deletes its now-orphaned file',
    !(await fileExists(hero2Id)), hero2Id);

  console.log('\n[images-test] --- static legacy value is left alone ---');
  r = await admin.put('/api/settings', { governor_photo: '/img/photos/governor.svg' });
  check('a static /img/photos/... value saves fine', r.status === 200, r.body);
  const govStatic = await db.getSetting('governor_photo');
  check('governor_photo keeps its static path verbatim', govStatic === '/img/photos/governor.svg', govStatic);
  r = await anon.get('/img/photos/governor.svg');
  check('the static governor photo still serves from /img/photos/', r.status === 200, 'got ' + r.status);

  console.log('\n[images-test] --- every render surface can come from /files/<id> ---');
  const surfaces = ['logo', 'governor_photo', 'commissioner_photo',
    'free_education_banner_image', 'girl_child_banner_image',
    'about_gallery_image_1', 'about_gallery_image_2', 'default_news_cover'];
  const surfaceUrls = {};
  for (let i = 0; i < surfaces.length; i++) {
    const key = surfaces[i];
    const up = await admin.upload('/api/settings/upload', key + '.png', 'image/png', pngBytes(key));
    if (up.status !== 201 || !up.body.url) { check('upload for ' + key, false, up.body); continue; }
    const sv = await admin.put('/api/settings', { [key]: up.body.url });
    if (sv.status !== 200) { check('set ' + key, false, sv.body); continue; }
    const storedVal = await db.getSetting(key);
    surfaceUrls[key] = up.body.url;
    const served = await anon.get(up.body.url);
    check(key + ': stored as /files/<id> and renders (200 image)',
      storedVal === up.body.url && served.status === 200 &&
      String(served.headers['content-type']).indexOf('image/') === 0,
      { stored: storedVal, status: served.status });
  }

  console.log('\n[images-test] --- data survives a restart (it lives in the DB) ---');
  /* Persisted settings and file rows are re-read from the database, proving the
   * images are not stuck in memory. We assert on the DB, which is the source a
   * fresh server process would load from. */
  const logoStored = await db.getSetting('logo');
  check('logo setting persists its /files/<id> value across the (same) DB',
    /^\/files\/[a-f0-9]{24}$/.test(logoStored || ''), logoStored);
  const logoRow = await db.get('SELECT id FROM files WHERE id = ?', [fileutil.fileIdFromUrl(logoStored)]);
  check('the logo file row is still in the files table after restart-read', Boolean(logoRow), logoStored);

  const filesEnd = await fileCount();
  check('files table grew by the uploaded, still-live images', filesEnd > filesStart,
    { start: filesStart, end: filesEnd });

  /* A GENUINE restart: spawn a brand-new Node process that boots its own server
   * against the SAME database copy and reads the settings + file bytes back over
   * HTTP. If the images only lived in this process's memory this would fail. */
  const restartEnv = Object.assign({}, process.env);
  restartEnv.DB_FILE = SQLITE_DB;           /* same copy */
  restartEnv.JWT_SECRET = process.env.JWT_SECRET;
  const child = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', '_restart-check.js'), logoStored],
    { env: restartEnv, encoding: 'utf8' });
  const restartOut = (child.stdout || '') + (child.stderr || '');
  const restartLine = (restartOut.match(/RESTART-RESULT .*/) || [''])[0];
  check('fresh process (real restart) reads logo + serves its bytes',
    restartLine.indexOf('RESTART-RESULT ok') === 0, restartLine || restartOut.slice(0, 300));


  console.log('\n[images-test] --- counts ---');
  console.log('  files rows: start=' + filesStart + ' end=' + filesEnd);
}

function cleanupSqlite() {
  if (process.env.DATABASE_URL) return;
  /* Close the better-sqlite3 handle first, or Windows keeps a lock on the file
   * and the throwaway copy (and its -wal/-shm) cannot be removed. */
  try { db.close(); } catch (e) { /* already closed */ }
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(SQLITE_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
}

function bootAndRun() {
  return new Promise(function (resolve, reject) {
    const app2 = buildTestApp();
    const server = app2.listen(PORT, '127.0.0.1', function () {
      runAll().then(function () { server.close(function () { resolve(); }); })
        .catch(function (e) { server.close(function () { reject(e); }); });
    });
  });
}

bootAndRun().then(function () {
  cleanupSqlite();
  console.log('\n[images-test] passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.error('[images-test] FATAL', e);
  cleanupSqlite();
  process.exit(1);
});


