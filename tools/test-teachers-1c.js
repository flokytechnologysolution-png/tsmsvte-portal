/**
 * tools/test-teachers-1c.js — TEMPORARY 1c verification on a DB COPY.
 * DELETE AFTER RUN. Must never be committed.
 *
 * Builds its own Express app (same middleware + routes as server.js) so the
 * real :3000 server is untouched. Users are created with password_hash set
 * directly in the DB, so no login-rate-limit interaction.
 */
'use strict';

process.env.DB_FILE = './data/portal-test-1c.db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-1c-verification';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const REAL_DB = path.resolve(ROOT, './data/portal.db');
const COPY_DB = path.resolve(ROOT, './data/portal-test-1c.db');
const PORT = 3999;

function rmCopy() {
  ['', '-wal', '-shm', '-journal'].forEach(function (suf) {
    try { fs.rmSync(COPY_DB + suf, { force: true }); } catch (e) { /* ignore */ }
  });
}
rmCopy();
['', '-wal', '-shm'].forEach(function (suf) {
  if (fs.existsSync(REAL_DB + suf)) fs.copyFileSync(REAL_DB + suf, COPY_DB + suf);
});
if (!fs.existsSync(COPY_DB)) {
  console.error('[1c-test] FATAL: no live database at ' + REAL_DB);
  process.exit(1);
}

function realCounts() {
  const D = require('better-sqlite3')(REAL_DB, { readonly: true });
  const out = { schools: 0, users: 0, teachers: 0 };
  try { out.teachers = D.prepare('SELECT COUNT(*) AS n FROM teachers').get().n; } catch (e) { out.teachers = -1; }
  out.schools = D.prepare('SELECT COUNT(*) AS n FROM schools').get().n;
  out.users = D.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  D.close();
  return out;
}
const BEFORE = realCounts();

const db = require('../db');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
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
  app2.use('/api/staff', require('../routes/staff'));
  app2.use('/api/schools', require('../routes/schools'));
  app2.use('/api/teachers', require('../routes/teachers'));
  /* Same tail as server.js: the teachers routes report validation failures
   * through next(err), so the JSON error handler must be mounted. */
  app2.use(require('../middleware/errors').errorHandler);
  return app2;
}

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
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function newJar() { return { cookies: {} }; }

/* Sessions are minted directly: insert user row, sign a JWT exactly like the
 * login route does, drop it in the jar. No login limiter involved. */
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
    put: function (p, b) {
      return jarRequest(jar, 'PUT', p, b === undefined ? {} : b, { 'x-csrf-token': sess.csrf });
    },
    del: function (p) {
      return jarRequest(jar, 'DELETE', p, undefined, { 'x-csrf-token': sess.csrf });
    },
    postFile: function (p, filename, content, fields) {
      return new Promise(function (resolve, reject) {
        const boundary = '----1cBOUND' + Date.now();
        const chunks = [];
        Object.keys(fields || {}).forEach(function (k) {
          chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k +
            '"\r\n\r\n' + String(fields[k]) + '\r\n'));
        });
        chunks.push(Buffer.from('--' + boundary +
          '\r\nContent-Disposition: form-data; name="file"; filename="' + filename +
          '"\r\nContent-Type: text/csv\r\n\r\n'));
        chunks.push(Buffer.from(content));
        chunks.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
        const payload = Buffer.concat(chunks);
        const cookieHeader = Object.keys(jar.cookies)
          .map(function (k) { return k + '=' + jar.cookies[k]; }).join('; ');
        const req = http.request({
          host: '127.0.0.1', port: PORT, path: p, method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': payload.length, Cookie: cookieHeader, 'x-csrf-token': sess.csrf
          }
        }, function (res) {
          let raw = '';
          res.on('data', function (c) { raw += c; });
          res.on('end', function () {
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = { _raw: raw }; }
            resolve({ status: res.statusCode, body: parsed });
          });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }
  };
}

async function runAll() {
  const lgas = await db.query('SELECT id, name FROM lgas ORDER BY sort_order');
  const lgaA = lgas[0];
  const lgaB = lgas[1] || lgas[0];
  console.log('[1c-test] LGA A=' + lgaA.name + ' B=' + lgaB.name);

  const mkSchool = async function (name, lga) {
    const info = await db.run(
      "INSERT INTO schools (name, lga, lga_id, type, category, boarding, status)" +
      " VALUES (?, ?, ?, 'junior_secondary', 'mixed', 'day', 'active')",
      [name, lga.name, lga.id]
    );
    return info.lastInsertRowid;
  };
  const sA1 = await mkSchool('1C Fake School A1', lgaA);
  const sA2 = await mkSchool('1C Fake School A2', lgaA);
  const sB1 = await mkSchool('1C Fake School B1', lgaB);
  const hash = await require('bcrypt').hash('Testpass123!', 4);
  const mkUser = async function (email, role, lgaId, schoolId) {
    const info = await db.run(
      "INSERT INTO users (email, password_hash, full_name, role, status, lga_id, school_id)" +
      " VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)",
      [email, hash, email.split('@')[0], role, lgaId, schoolId]
    );
    return info.lastInsertRowid;
  };
  const idOwner = await mkUser('t1c-owner@example.com', 'OWNER', null, null);
  const idAdmin = await mkUser('t1c-admin@example.com', 'ADMIN', null, null);
  const idOffA = await mkUser('t1c-lgaA@example.com', 'LGA_OFFICER', lgaA.id, null);
  const idOffB = await mkUser('t1c-lgaB@example.com', 'LGA_OFFICER', lgaB.id, null);
  const idAdmA = await mkUser('t1c-schoolA1@example.com', 'SCHOOL_ADMIN', lgaA.id, sA1);
  const idAdmB = await mkUser('t1c-schoolB1@example.com', 'SCHOOL_ADMIN', lgaB.id, sB1);
  const idEditor = await mkUser('t1c-editor@example.com', 'EDITOR', null, null);
  const idStaff = await mkUser('t1c-staff@example.com', 'STAFF', null, null);
  const mkTeacher = async function (schoolId, staffNo, name, subject) {
    const info = await db.run(
      'INSERT INTO teachers (school_id, staff_no, full_name, sex, date_of_birth,' +
      " qualification, subject, rank, phone, status)" +
      " VALUES (?, ?, ?, 'M', '1980-01-01', 'B.Ed', ?, 'Teacher II', '08030000001', 'ACTIVE')",
      [schoolId, staffNo, name, subject || 'Mathematics']
    );
    return info.lastInsertRowid;
  };
  const tA1 = await mkTeacher(sA1, 'T1C-A1', 'Fake Teacher A1');
  const tA2 = await mkTeacher(sA2, 'T1C-A2', 'Fake Teacher A2', 'English');
  const tB1 = await mkTeacher(sB1, 'T1C-B1', 'Fake Teacher B1');

  const owner = authed(await bootCsrf(await sessionFor(idOwner)));
  const admin = authed(await bootCsrf(await sessionFor(idAdmin)));
  const offA = authed(await bootCsrf(await sessionFor(idOffA)));
  const offB = authed(await bootCsrf(await sessionFor(idOffB)));
  const admA = authed(await bootCsrf(await sessionFor(idAdmA)));
  const admB = authed(await bootCsrf(await sessionFor(idAdmB)));
  const editor = authed(await bootCsrf(await sessionFor(idEditor)));
  const staff = authed(await bootCsrf(await sessionFor(idStaff)));
  const anon = { get: function (p) { return jarRequest(newJar(), 'GET', p); } };

  const names = function (r) {
    return (r.body.teachers || []).map(function (t) { return t.staff_no; }).sort();
  };

  /* The PUT route takes the FULL record (same as the admin console: load the
   * row, apply the edits, save everything back) and answers { ok: true }. */
  async function putMerged(sess, id, changes) {
    const cur = (await sess.get('/api/teachers/' + id)).body.teacher;
    return sess.put('/api/teachers/' + id, Object.assign({}, cur, changes));
  }

  let r = await owner.get('/api/teachers');
  check('owner sees all 3', r.status === 200 && names(r).join() === 'T1C-A1,T1C-A2,T1C-B1', JSON.stringify(r.body));
  r = await admin.get('/api/teachers');
  check('admin sees all 3', r.status === 200 && names(r).join() === 'T1C-A1,T1C-A2,T1C-B1', JSON.stringify(r.body));
  r = await offA.get('/api/teachers');
  check('officer A sees 2', r.status === 200 && names(r).join() === 'T1C-A1,T1C-A2', JSON.stringify(r.body));
  r = await offB.get('/api/teachers');
  check('officer B sees 1', r.status === 200 && names(r).join() === 'T1C-B1', JSON.stringify(r.body));
  r = await admA.get('/api/teachers');
  check('school A1 sees 1', r.status === 200 && names(r).join() === 'T1C-A1', JSON.stringify(r.body));
  r = await admB.get('/api/teachers');
  check('school B1 sees 1', r.status === 200 && names(r).join() === 'T1C-B1', JSON.stringify(r.body));
  r = await offA.get('/api/teachers/' + tB1);
  check('officer A by-id cross LGA 404', r.status === 404, 'got ' + r.status);
  r = await admA.get('/api/teachers/' + tA2);
  check('school A1 other school 404', r.status === 404, 'got ' + r.status);
  r = await offA.get('/api/teachers/' + tA1);
  check('officer A own by-id 200', r.status === 200 && r.body.teacher.staff_no === 'T1C-A1', 'got ' + r.status);
  r = await editor.get('/api/teachers');
  check('editor refused 403', r.status === 403, 'got ' + r.status);
  r = await staff.get('/api/teachers');
  check('staff refused 403', r.status === 403, 'got ' + r.status);
  r = await anon.get('/api/teachers');
  check('anonymous 401', r.status === 401, 'got ' + r.status);

  const good = {
    school_id: sA1, staff_no: 'T1C-NEW', full_name: 'New Teacher',
    sex: 'F', date_of_birth: '1990-05-05', qualification: 'B.Ed',
    subject: 'Physics', rank: 'Teacher I', phone: '+2348030000000', status: 'ACTIVE'
  };
  r = await admA.post('/api/teachers', good);
  check('school A creates own 201', r.status === 201 && typeof r.body.id === 'number',
    'got ' + r.status + ' ' + JSON.stringify(r.body));
  const newId = r.body.id || null;
  r = await admA.post('/api/teachers', Object.assign({}, good, { school_id: sA2, staff_no: 'T1C-X1' }));
  check('school A create at A2 404', r.status === 404, 'got ' + r.status);
  r = await admA.post('/api/teachers', Object.assign({}, good, { school_id: sB1, staff_no: 'T1C-X2' }));
  check('school A create at B1 404', r.status === 404, 'got ' + r.status);
  r = await offA.post('/api/teachers', Object.assign({}, good, { school_id: sB1, staff_no: 'T1C-X3' }));
  check('officer A create in LGA B 404', r.status === 404, 'got ' + r.status);
  r = await offA.post('/api/teachers', Object.assign({}, good, { school_id: sA2, staff_no: 'T1C-OA1' }));
  check('officer A creates in LGA 201', r.status === 201, 'got ' + r.status);
  r = await editor.post('/api/teachers', good);
  check('editor create 403', r.status === 403, 'got ' + r.status);
  r = await staff.post('/api/teachers', good);
  check('staff create 403', r.status === 403, 'got ' + r.status);
  r = await admA.post('/api/teachers', Object.assign({}, good, { staff_no: '' }));
  check('missing staff_no 422', r.status === 422, 'got ' + r.status);
  r = await admA.post('/api/teachers', Object.assign({}, good, { staff_no: 'T1C-BAD1', phone: 'notaphone' }));
  check('bad phone 422', r.status === 422, 'got ' + r.status);
  r = await admA.post('/api/teachers', Object.assign({}, good, { staff_no: 'T1C-BAD2', date_of_birth: '31-12-1990' }));
  check('bad date 422', r.status === 422, 'got ' + r.status);
  r = await admA.post('/api/teachers', Object.assign({}, good, { staff_no: 'T1C-A1' }));
  check('duplicate staff_no 409', r.status === 409, 'got ' + r.status);
  r = await admA.post('/api/teachers', Object.assign({}, good, { staff_no: 't1c-a1' }));
  check('duplicate case-insensitive 409', r.status === 409, 'got ' + r.status);

  r = await putMerged(admA, newId, { subject: 'Chemistry', rank: 'Senior Teacher' });
  check('school A edits own 200', r.status === 200 && r.body.ok === true, 'got ' + r.status);
  r = await admA.get('/api/teachers/' + newId);
  check('edit persisted (subject Chemistry)',
    r.status === 200 && r.body.teacher.subject === 'Chemistry', JSON.stringify(r.body));
  r = await admA.put('/api/teachers/' + newId, Object.assign({}, good, { school_id: sB1 }));
  check('school A cannot move teacher out 404', r.status === 404, 'got ' + r.status);
  r = await admA.put('/api/teachers/' + tB1, { subject: 'Hacked' });
  check('school A edit cross-school 404', r.status === 404, 'got ' + r.status);
  r = await offA.put('/api/teachers/' + tB1, { subject: 'Hacked' });
  check('officer A edit cross-LGA 404', r.status === 404, 'got ' + r.status);
  r = await putMerged(offA, tA1, { school_id: sA2 });
  check('officer A moves within LGA 200', r.status === 200, 'got ' + r.status);
  r = await editor.put('/api/teachers/' + tA1, { subject: 'Hacked' });
  check('editor edit 403', r.status === 403, 'got ' + r.status);
  r = await admA.del('/api/teachers/' + tB1);
  check('school A delete cross-school 404', r.status === 404, 'got ' + r.status);
  r = await offA.del('/api/teachers/' + tB1);
  check('officer A delete cross-LGA 404', r.status === 404, 'got ' + r.status);
  r = await offA.del('/api/teachers/' + tA2);
  check('officer A deletes own-LGA 200', r.status === 200, 'got ' + r.status);
  r = await offA.get('/api/teachers/' + tA2);
  check('deleted teacher gone 404', r.status === 404, 'got ' + r.status);
  r = await admA.del('/api/schools/' + sA1);
  check('school admin cannot delete schools (403)', r.status === 403, 'got ' + r.status);
  r = await admin.del('/api/schools/' + sA1);
  check('school with teachers 409', r.status === 409, 'got ' + r.status);
  const emptySchool = await mkSchool('1C Fake Empty School', lgaA);
  r = await admin.del('/api/schools/' + emptySchool);
  check('empty school deletes 200', r.status === 200, 'got ' + r.status);

  r = await offA.get('/api/teachers?q=Fake%20Teacher');
  check('search scoped', r.status === 200 &&
    (r.body.teachers || []).every(function (t) { return t.staff_no !== 'T1C-B1'; }), JSON.stringify(r.body));
  r = await offA.get('/api/teachers?subject=mathematics');
  check('subject filter lowercase', r.status === 200 && (r.body.teachers || []).length >= 1, JSON.stringify(r.body));
  r = await offA.get('/api/teachers?lga=' + encodeURIComponent(lgaB.name));
  check('cannot widen via ?lga= (total 0)', r.status === 200 && r.body.total === 0, JSON.stringify(r.body));
  r = await owner.get('/api/teachers?lga=' + encodeURIComponent(lgaA.name));
  check('owner ?lga= works', r.status === 200 && r.body.total >= 2, JSON.stringify(r.body));
  r = await offA.get('/api/teachers?school_id=' + sB1);
  check('cannot widen via ?school_id= (total 0)', r.status === 200 && r.body.total === 0, JSON.stringify(r.body));
  r = await offA.get('/api/teachers?limit=1&page=1');
  check('pagination page 1', r.status === 200 && r.body.teachers.length === 1 && r.body.pages >= 2,
    JSON.stringify(r.body));
  r = await offA.get('/api/teachers/options');
  check('options schools scoped to LGA A', r.status === 200 &&
    (r.body.schools || []).length > 0 &&
    (r.body.schools || []).every(function (s) { return s.lga === lgaA.name; }) &&
    (r.body.lgas || []).length === 16, JSON.stringify(r.body));
  r = await admA.get('/api/teachers/options');
  check('options single school', r.status === 200 &&
    (r.body.schools || []).length === 1 && r.body.schools[0].id === sA1, JSON.stringify(r.body));
  r = await anon.get('/api/teachers/template.csv');
  check('template requires auth (401 for anonymous)', r.status === 401, 'got ' + r.status);
  r = await offA.get('/api/teachers/template.csv');
  check('template csv for console roles', r.status === 200 &&
    String(r.headers['content-type'] || '').indexOf('text/csv') !== -1, 'got ' + r.status);
  r = await offA.get('/api/teachers/export.csv');
  check('export scoped', r.status === 200 &&
    (r.body._raw || '').indexOf('T1C-B1') === -1 &&
    (r.body._raw || '').indexOf('T1C-A1') !== -1, 'got ' + r.status);
  r = await admA.get('/api/teachers/export.csv');
  check('school export own only', r.status === 200 &&
    (r.body._raw || '').indexOf('1C Fake School A2') === -1, 'leaked A2');
  r = await editor.get('/api/teachers/export.csv');
  check('editor export 403', r.status === 403, 'got ' + r.status);
  r = await anon.get('/api/teachers/export.csv');
  check('anonymous export 401', r.status === 401, 'got ' + r.status);
  const audits = (await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'teacher.%'")).n;
  check('teacher audit rows written', audits >= 4, 'got ' + audits);

  const csvGood =
    'school,lga,staff_no,full_name,sex,date_of_birth,qualification,subject,rank,phone,status\n' +
    '"1C Fake School A1","' + lgaA.name + '",T1C-IMP1,"Import One",M,1985-03-03,B.Ed,Mathematics,Teacher II,08030000010,ACTIVE\n' +
    '"1C Fake School A2","' + lgaA.name + '",T1C-IMP2,"Import Two",F,1988-07-07,B.Sc,English,Teacher I,08030000011,ACTIVE\n';
  r = await offA.postFile('/api/teachers/import', 'imp.csv', csvGood, { dry_run: '1' });
  check('preview 2 valid 0 invalid', r.status === 200 && r.body.report.valid === 2 &&
    r.body.report.invalid === 0 && r.body.report.created === 0, JSON.stringify(r.body));
  check('preview wrote nothing',
    (await db.get("SELECT COUNT(*) AS n FROM teachers WHERE staff_no LIKE 'T1C-IMP%'")).n === 0);
  r = await offA.postFile('/api/teachers/import', 'imp.csv', csvGood, {});
  check('commit created 2', r.status === 200 && r.body.report.created === 2, JSON.stringify(r.body));
  const csvMixed =
    'school,lga,staff_no,full_name,sex,date_of_birth,qualification,subject,rank,phone,status\n' +
    '"1C Fake School A1","' + lgaA.name + '",T1C-MX1,"Mixed Good",M,1985-03-03,B.Ed,Maths,TII,08030000020,ACTIVE\n' +
    '"1C Fake School B1","' + lgaB.name + '",T1C-MX2,"Out Of Scope",M,1985-03-03,B.Ed,Maths,TII,08030000021,ACTIVE\n' +
    '"1C Fake School A1","' + lgaA.name + '",T1C-A1,"Dupe",M,1985-03-03,B.Ed,Maths,TII,08030000022,ACTIVE\n' +
    '"1C Fake School A1","' + lgaA.name + '",T1C-MX3,"Bad Phone",M,1985-03-03,B.Ed,Maths,TII,xyz,ACTIVE\n' +
    '"No Such School","' + lgaA.name + '",T1C-MX4,"No School",M,1985-03-03,B.Ed,Maths,TII,08030000023,ACTIVE\n';
  r = await offA.postFile('/api/teachers/import', 'mix.csv', csvMixed, { dry_run: '1' });
  check('mixed preview 1 valid 4 invalid', r.status === 200 && r.body.report.valid === 1 &&
    r.body.report.invalid === 4, JSON.stringify(r.body));
  r = await offA.postFile('/api/teachers/import', 'mix.csv', csvMixed, {});
  check('partial commit creates 1', r.status === 200 && r.body.report.created === 1 &&
    r.body.report.invalid === 4, JSON.stringify(r.body));

  const csvAtomic =
    'school,lga,staff_no,full_name,sex,date_of_birth,qualification,subject,rank,phone,status\n' +
    '"1C Fake School A1","' + lgaA.name + '",T1C-AT1,"Atomic Good",M,1985-03-03,B.Ed,Maths,TII,08030000030,ACTIVE\n' +
    '"1C Fake School A1","' + lgaA.name + '",T1C-A1,"Atomic Dupe",M,1985-03-03,B.Ed,Maths,TII,08030000031,ACTIVE\n';
  r = await offA.postFile('/api/teachers/import', 'atom.csv', csvAtomic, { mode: 'all' });
  check('atomic with bad row creates 0', r.status === 200 && r.body.report.created === 0 &&
    r.body.report.invalid === 1, JSON.stringify(r.body));
  check('atomic row not stored', !(await db.get('SELECT id FROM teachers WHERE staff_no = ?', ['T1C-AT1'])));
  let big = 'school,lga,staff_no,full_name,sex,date_of_birth,qualification,subject,rank,phone,status\n';
  for (let i = 1; i <= 75; i += 1) {
    big += '"1C Fake School A1","' + lgaA.name + '",T1C-TR' + i + ',"Trunc ' + i +
      '",M,not-a-date,B.Ed,Maths,TII,08030000040,ACTIVE\n';
  }
  r = await offA.postFile('/api/teachers/import', 'big.csv', big, { dry_run: '1' });
  check('truncation invalid=75 errors<=60 truncated',
    r.status === 200 && r.body.report.invalid === 75 &&
    (r.body.report.errors || []).length <= 60 && r.body.report.truncated === true,
    'invalid=' + (r.body && r.body.report && r.body.report.invalid) +
    ' errors=' + (r.body && r.body.report && (r.body.report.errors || []).length));
  r = await offA.postFile('/api/teachers/import', 'big.csv', big, { mode: 'all' });
  check('all-or-nothing by invalid count: created 0', r.status === 200 && r.body.report.created === 0,
    JSON.stringify((r.body && r.body.report) || r.body));
  const csvScope =
    'school,lga,staff_no,full_name,sex,date_of_birth,qualification,subject,rank,phone,status\n' +
    '"1C Fake School B1","' + lgaB.name + '",T1C-SC1,"Scope Probe",M,1985-03-03,B.Ed,Maths,TII,08030000050,ACTIVE\n';
  r = await admA.postFile('/api/teachers/import', 'scope.csv', csvScope, {});
  check('school import other school writes 0', r.status === 200 && r.body.report.created === 0 &&
    r.body.report.invalid === 1, JSON.stringify(r.body));
  r = await editor.postFile('/api/teachers/import', 'scope.csv', csvGood, { dry_run: '1' });
  check('editor import 403', r.status === 403, 'got ' + r.status);
}

function bootAndRun() {
  return new Promise(function (resolve, reject) {
    const server = buildTestApp().listen(PORT, '127.0.0.1', function () {
      runAll().then(function () { server.close(function () { resolve(); }); })
        .catch(function (e) { server.close(function () { reject(e); }); });
    });
  });
}

bootAndRun().then(function () {
  console.log('\n[1c-test] passed=' + passed + ' failed=' + failed);
  const D = require('better-sqlite3')(REAL_DB, { readonly: true });
  let t = -1;
  try { t = D.prepare('SELECT COUNT(*) AS n FROM teachers').get().n; } catch (e) { t = -1; }
  const now = {
    teachers: t,
    schools: D.prepare('SELECT COUNT(*) AS n FROM schools').get().n,
    users: D.prepare('SELECT COUNT(*) AS n FROM users').get().n
  };
  D.close();
  check('real DB unchanged',
    now.teachers === BEFORE.teachers && now.schools === BEFORE.schools && now.users === BEFORE.users,
    JSON.stringify({ before: BEFORE, now: now }));
  rmCopy();
  console.log('[1c-test] passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.error('[1c-test] FATAL', e);
  try { rmCopy(); } catch (x) { /* ignore */ }
  process.exit(1);
});
