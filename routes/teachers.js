/**
 * routes/teachers.js — the teachers register: scoped list/search, CRUD and
 * CSV import/export.
 *
 * Read AND write are open to exactly four roles (scope.requireTeacherConsole):
 * OWNER/ADMIN see the whole state, LGA_OFFICER the schools in their own LGA,
 * SCHOOL_ADMIN their one school.  Anything outside the caller's scope is a
 * 404, never a 403; EDITOR/STAFF and anonymous callers are refused outright.
 *
 * Every write is CSRF protected (the global /api guard), rate limited
 * (writeLimiter) and audit logged through db.logAudit.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const scope = require('../middleware/scope');
const { csvMemory } = require('../middleware/upload');
const { clean, toIntOrNull } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const csv = require('../lib/csv');

const router = express.Router();

/* How many per-row error details we are willing to store and return.  The
 * TOTAL number of invalid rows is always kept separately as report.invalid —
 * every decision (may this import proceed?) is made from that count, never
 * from errors.length, which is capped below. */
const MAX_ERRORS_SHOWN = 60;

const STATUSES = db.TEACHER_STATUSES;
const CSV_HEADERS = ['school', 'lga', 'staff_no', 'full_name', 'sex', 'date_of_birth',
  'qualification', 'subject', 'rank', 'phone', 'status'];

/* ------------------------------ helpers ------------------------------- */

function teacherFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    school_id: row.school_id,
    school_name: row.school_name || '',
    lga: row.lga || '',
    staff_no: row.staff_no,
    full_name: row.full_name,
    sex: row.sex,
    date_of_birth: row.date_of_birth,
    qualification: row.qualification,
    subject: row.subject,
    rank: row.rank,
    phone: row.phone,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** '' for empty, 'M'/'F' accepted forms, null for anything else. */
function normSex(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'm' || v === 'male') return 'M';
  if (v === 'f' || v === 'female') return 'F';
  return null;
}

/** A real calendar day in YYYY-MM-DD, between 1900 and today. */
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = parseInt(value.slice(0, 4), 10);
  const m = parseInt(value.slice(5, 7), 10);
  const d = parseInt(value.slice(8, 10), 10);
  if (y < 1900 || y > 2100) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return false;
  return value <= new Date().toISOString().slice(0, 10);
}

/** Optional; when present: digits with one optional leading +, 7–15 digits. */
function validPhone(value) {
  if (!value) return true;
  const s = String(value).replace(/[\s\-().]/g, '');
  return /^\+?\d{7,15}$/.test(s);
}

/** '' -> fallback (create default), unknown -> null (signals invalid). */
function normStatus(value, fallback) {
  const v = String(value || '').trim().toUpperCase();
  if (!v) return fallback;
  return STATUSES.indexOf(v) !== -1 ? v : null;
}

function readTeacherBody(body) {
  const staffNo = clean(body.staff_no).slice(0, 40);
  const fullName = clean(body.full_name).slice(0, 120);
  const sex = normSex(body.sex);
  const dob = clean(body.date_of_birth).slice(0, 10);
  const qualification = clean(body.qualification).slice(0, 120);
  const subject = clean(body.subject).slice(0, 120);
  const rank = clean(body.rank).slice(0, 80);
  const phone = clean(body.phone).slice(0, 40);
  const status = normStatus(body.status, 'ACTIVE');
  const schoolId = toIntOrNull(body.school_id);
  const errors = [];

  if (!staffNo) errors.push('Staff number is required.');
  if (!fullName) errors.push('Full name is required.');
  if (!sex) errors.push('Sex is required (male or female).');
  if (dob && !validDate(dob)) {
    errors.push('Date of birth must be a real day in YYYY-MM-DD format, between 1900 and today.');
  }
  if (!validPhone(phone)) {
    errors.push('Phone must be 7-15 digits with one optional leading + (spaces and dashes are fine).');
  }
  if (!status) errors.push('Status must be one of ' + STATUSES.join(', ') + '.');
  if (!schoolId) errors.push('A school is required.');

  return {
    errors: errors,
    value: {
      school_id: schoolId,
      staff_no: staffNo,
      full_name: fullName,
      sex: sex || '',
      date_of_birth: dob,
      qualification: qualification,
      subject: subject,
      rank: rank,
      phone: phone,
      status: status || 'ACTIVE'
    }
  };
}

/** Is this staff number already in the register?  Case-insensitive, by design. */
function staffNoTaken(staffNo, exceptId) {
  const row = exceptId
    ? db.prepare('SELECT id FROM teachers WHERE staff_no = ? COLLATE NOCASE AND id <> ?').get(staffNo, exceptId)
    : db.prepare('SELECT id FROM teachers WHERE staff_no = ? COLLATE NOCASE').get(staffNo);
  return row ? row.id : null;
}

/**
 * Does the target school exist, and may the caller write to it?
 * Missing id -> 422 (bad input).  Existing but outside the caller's scope ->
 * 404, exactly like every other out-of-scope row: nothing leaks.
 */
function checkTargetSchool(user, schoolId) {
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(schoolId);
  if (!school) return { error: { status: 422, message: 'That school does not exist.' } };
  if (!scope.canViewSchool(user, school)) return { error: { status: 404, message: 'School not found' } };
  return { school: school };
}

/** Resolve a school from CSV text: name (+ optional lga to disambiguate). */
function resolveSchool(nameRaw, lgaRaw) {
  const name = clean(nameRaw).slice(0, 200);
  const lga = clean(lgaRaw).slice(0, 60);
  if (!name) return { message: 'School name is required.' };
  let rows;
  if (lga) {
    rows = db.prepare('SELECT * FROM schools WHERE name = ? COLLATE NOCASE AND lga = ? COLLATE NOCASE').all(name, lga);
    if (!rows.length) return { message: 'Unknown school: ' + name + ' (' + lga + ').' };
  } else {
    rows = db.prepare('SELECT * FROM schools WHERE name = ? COLLATE NOCASE').all(name);
    if (!rows.length) return { message: 'Unknown school: ' + name + '.' };
    if (rows.length > 1) {
      return { message: 'More than one school is called "' + name + '". Add the lga column to point at the right one.' };
    }
  }
  return { row: rows[0] };
}

/** Tolerant LGA lookup (name, slug, spacing-insensitive) for the ?lga= filter. */
function lgaResolve(text) {
  const raw = clean(text);
  if (!raw) return null;
  const key = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  const lower = raw.toLowerCase();
  const norm = key(raw);
  let hit = null;
  db.prepare('SELECT id, name, slug FROM lgas ORDER BY sort_order').all().some(function (r) {
    if (r.name.toLowerCase() === lower || r.slug === lower || key(r.name) === norm || key(r.slug) === norm) {
      hit = r;
      return true;
    }
    return false;
  });
  return hit;
}

/**
 * Shared filter builder for the list and the export.  Scope is NOT part of
 * this — the caller applies scope.teacherWhere separately, so a filter can
 * only ever narrow the view, never widen it.
 * @returns {{where:string[],params:any[],error?:string}}
 */
function buildFilters(query) {
  const where = [];
  const params = [];

  const q = clean(query.q || '').slice(0, 80);
  const statusRaw = clean(query.status || '').toUpperCase();
  const subject = clean(query.subject || '').slice(0, 120);
  const schoolRaw = clean(query.school_id || '');
  const lgaRaw = clean(query.lga || '');

  if (q) {
    where.push('(t.full_name LIKE ? OR t.staff_no LIKE ? OR t.subject LIKE ? OR t.phone LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  if (statusRaw) {
    if (STATUSES.indexOf(statusRaw) === -1) {
      return { where: where, params: params, error: 'Unknown status. Allowed: ' + STATUSES.join(', ') + '.' };
    }
    where.push('t.status = ?');
    params.push(statusRaw);
  }
  if (subject) {
    where.push('t.subject = ? COLLATE NOCASE');
    params.push(subject);
  }
  if (schoolRaw) {
    const id = toIntOrNull(schoolRaw);
    if (!id) return { where: where, params: params, error: 'school_id must be a numeric school id.' };
    where.push('t.school_id = ?');
    params.push(id);
  }
  if (lgaRaw) {
    const hit = lgaResolve(lgaRaw);
    if (!hit) return { where: where, params: params, error: 'Unknown LGA: ' + lgaRaw.slice(0, 60) + '.' };
    where.push('s.lga_id = ?');
    params.push(hit.id);
  }
  return { where: where, params: params };
}

/* --------------------------------- list --------------------------------- */

/* Search, four filters (school, LGA, subject, status) and pagination.  The
 * scope clause is ANDed in last: a ?school_id= or ?lga= outside the caller's
 * scope simply matches nothing — the scoped caller stays inside their slice. */
router.get('/', requireAuth, scope.requireTeacherConsole, function (req, res) {
  const filt = buildFilters(req.query || {});
  if (filt.error) return res.status(422).json({ error: filt.error });

  const page = Math.min(Math.max(toIntOrNull(req.query.page) || 1, 1), 10000);
  const limit = Math.min(Math.max(toIntOrNull(req.query.limit) || 25, 1), 100);
  const offset = (page - 1) * limit;

  const where = filt.where.slice();
  const params = filt.params.slice();
  const sc = scope.teacherWhere(req.user, 't');
  if (sc.sql) { where.push(sc.sql); params.push.apply(params, sc.params); }
  const clause = where.length ? (' WHERE ' + where.join(' AND ')) : '';

  const countRow = db.prepare(
    'SELECT COUNT(*) AS n FROM teachers t JOIN schools s ON s.id = t.school_id' + clause
  ).get.apply(null, params);
  const rows = db.prepare(
    'SELECT t.*, s.name AS school_name, s.lga AS lga FROM teachers t ' +
    'JOIN schools s ON s.id = t.school_id' + clause +
    ' ORDER BY t.full_name COLLATE NOCASE LIMIT ? OFFSET ?'
  ).all.apply(null, params.concat([limit, offset]));
  const total = countRow ? countRow.n : 0;

  res.json({
    teachers: rows.map(teacherFrom),
    total: total, page: page, limit: limit,
    pages: Math.max(1, Math.ceil(total / limit))
  });
});

/* Filter dropdowns: schools are already limited to the caller's scope. */
router.get('/options', requireAuth, scope.requireTeacherConsole, function (req, res) {
  const sc = scope.schoolWhere(req.user, 's');
  const where = sc.sql ? (' WHERE ' + sc.sql) : '';
  const schools = db.prepare(
    'SELECT s.id, s.name, s.lga FROM schools s' + where + ' ORDER BY s.name COLLATE NOCASE LIMIT 2000'
  ).all.apply(null, sc.params);
  const lgas = db.prepare('SELECT name, slug FROM lgas ORDER BY sort_order').all();
  res.json({ schools: schools, lgas: lgas, statuses: STATUSES });
});

/* NOTE: /export.csv and /template.csv sit ABOVE /:id so Express does not
 * treat "export.csv" as an id.  The numeric guard on /:id below is the
 * second half of the same protection. */

/* Scope-limited export honours the same search + filters as the list. */
router.get('/export.csv', requireAuth, scope.requireTeacherConsole, function (req, res) {
  const filt = buildFilters(req.query || {});
  if (filt.error) return res.status(422).json({ error: filt.error });
  const where = filt.where.slice();
  const params = filt.params.slice();
  const sc = scope.teacherWhere(req.user, 't');
  if (sc.sql) { where.push(sc.sql); params.push.apply(params, sc.params); }
  const clause = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  const rows = db.prepare(
    'SELECT t.*, s.name AS school_name, s.lga AS lga FROM teachers t ' +
    'JOIN schools s ON s.id = t.school_id' + clause + ' ORDER BY t.full_name COLLATE NOCASE LIMIT 20000'
  ).all.apply(null, params).map(function (r) {
    return {
      school: r.school_name, lga: r.lga, staff_no: r.staff_no, full_name: r.full_name,
      sex: r.sex, date_of_birth: r.date_of_birth, qualification: r.qualification,
      subject: r.subject, rank: r.rank, phone: r.phone, status: r.status
    };
  });
  db.logAudit(req.user, 'teacher.export', 'teacher', '', { count: rows.length }, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="teachers-export.csv"');
  res.send(csv.toCsv(CSV_HEADERS, rows));
});

router.get('/template.csv', requireAuth, scope.requireTeacherConsole, function (req, res) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="teachers-template.csv"');
  res.send(csv.toCsv(CSV_HEADERS, [{
    school: 'Example Secondary School', lga: 'Jalingo', staff_no: 'TSM/001',
    full_name: 'Amina Bello', sex: 'F', date_of_birth: '1985-03-12',
    qualification: 'B.Ed Mathematics', subject: 'Mathematics',
    rank: 'Senior Teacher', phone: '08031234567', status: 'ACTIVE'
  }]));
});

/* NOTE: the numeric guard keeps /export.csv and /template.csv reachable. */
router.get('/:id([0-9]+)', requireAuth, scope.requireTeacherConsole, scope.requireTeacherScope, function (req, res) {
  const row = db.prepare(
    'SELECT t.*, s.name AS school_name, s.lga AS lga FROM teachers t ' +
    'JOIN schools s ON s.id = t.school_id WHERE t.id = ?'
  ).get(req.teacher.id);
  return res.json({ teacher: teacherFrom(row) });
});

/* --------------------------------- write -------------------------------- */

function invalidBody(res, errors, next) {
  const err = new Error(errors[0]);
  err.status = 422;
  err.errors = errors.map(function (m) { return { message: m }; });
  err.publicMessage = errors[0] + (errors.length > 1 ? ' (and ' + (errors.length - 1) + ' more)' : '');
  return next(err);
}

router.post('/', requireAuth, scope.requireTeacherConsole, writeLimiter, function (req, res, next) {
  const parsed = readTeacherBody(req.body || {});
  if (parsed.errors.length) return invalidBody(res, parsed.errors, next);
  const v = parsed.value;
  const gate = checkTargetSchool(req.user, v.school_id);
  if (gate.error) return res.status(gate.error.status).json({ error: gate.error.message });
  const clash = staffNoTaken(v.staff_no, null);
  if (clash) return res.status(409).json({ error: 'That staff number is already in use.' });
  const info = db.prepare(
    'INSERT INTO teachers (school_id, staff_no, full_name, sex, date_of_birth, qualification, ' +
    'subject, rank, phone, status) VALUES ' +
    '(@school_id, @staff_no, @full_name, @sex, @date_of_birth, @qualification, @subject, @rank, @phone, @status)'
  ).run(v);
  db.logAudit(req.user, 'teacher.create', 'teacher', info.lastInsertRowid, { staff_no: v.staff_no }, req);
  return res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

/* Out-of-scope id -> 404 via requireTeacherScope; a new school_id outside
 * the caller's scope is refused the same way (the target school "not found"). */
router.put('/:id([0-9]+)', requireAuth, scope.requireTeacherConsole, scope.requireTeacherScope, writeLimiter,
  function (req, res, next) {
    const id = req.teacher.id;
    const parsed = readTeacherBody(req.body || {});
    if (parsed.errors.length) return invalidBody(res, parsed.errors, next);
    const v = parsed.value;
    const gate = checkTargetSchool(req.user, v.school_id);
    if (gate.error) return res.status(gate.error.status).json({ error: gate.error.message });
    const clash = staffNoTaken(v.staff_no, id);
    if (clash) return res.status(409).json({ error: 'That staff number is already in use.' });
    db.prepare(
      'UPDATE teachers SET school_id = @school_id, staff_no = @staff_no, full_name = @full_name, ' +
      'sex = @sex, date_of_birth = @date_of_birth, qualification = @qualification, ' +
      'subject = @subject, rank = @rank, phone = @phone, status = @status, ' +
      "updated_at = datetime('now') WHERE id = @id"
    ).run({
      school_id: v.school_id, staff_no: v.staff_no, full_name: v.full_name, sex: v.sex,
      date_of_birth: v.date_of_birth, qualification: v.qualification, subject: v.subject,
      rank: v.rank, phone: v.phone, status: v.status, id: id
    });
    db.logAudit(req.user, 'teacher.update', 'teacher', id, { staff_no: v.staff_no }, req);
    return res.json({ ok: true });
  });

router.delete('/:id([0-9]+)', requireAuth, scope.requireTeacherConsole, scope.requireTeacherScope, writeLimiter,
  function (req, res) {
    const row = req.teacher;
    db.prepare('DELETE FROM teachers WHERE id = ?').run(row.id);
    db.logAudit(req.user, 'teacher.delete', 'teacher', row.id, { staff_no: row.staff_no }, req);
    return res.json({ ok: true });
  });

/* --------------------------------- import ------------------------------- */

/**
 * Validate every CSV row against the caller's scope WITHOUT writing.
 * Keeps the TOTAL bad-row count apart from the stored error details:
 * at most MAX_ERRORS_SHOWN details are kept and `truncated` says more exist.
 */
function previewTeacherImport(user, rows) {
  const seen = {};                       /* staff_no duplicates inside the file */
  const valid = [];
  let invalid = 0;
  const errors = [];
  const pushError = function (rowNum, message) {
    if (errors.length < MAX_ERRORS_SHOWN) errors.push({ row: rowNum, error: message });
  };

  rows.forEach(function (raw, i) {
    const rowNum = i + 2;                /* +1 header, +1 one-based */
    const raw0 = raw || {};
    let src = raw0;
    /* CSV rows carry the school NAME (+ optional lga), not the numeric id
     * the form posts — resolve it before validating. */
    if (!src.school_id && src.school) {
      const hit = resolveSchool(src.school, src.lga);
      if (hit.row) src = Object.assign({}, src, { school_id: hit.row.id });
      else {
        invalid += 1;
        pushError(rowNum, hit.message);
        return;
      }
    }
    const parsed = readTeacherBody(src);
    if (parsed.errors.length) {
      invalid += 1;
      pushError(rowNum, parsed.errors[0]);
      return;
    }
    const v = parsed.value;
    const key = v.staff_no.toLowerCase();
    if (seen[key]) {
      invalid += 1;
      pushError(rowNum, 'Duplicate staff number in this file: ' + v.staff_no +
        ' (first seen on row ' + seen[key] + ').');
      return;
    }
    seen[key] = rowNum;
    const gate = checkTargetSchool(user, v.school_id);
    if (gate.error) {
      invalid += 1;
      pushError(rowNum, gate.error.message);
      return;
    }
    if (staffNoTaken(v.staff_no, null)) {
      invalid += 1;
      pushError(rowNum, 'That staff number is already in use: ' + v.staff_no + '.');
      return;
    }
    valid.push(v);
  });

  return { valid: valid, invalid: invalid, errors: errors, truncated: invalid > errors.length };
}

/* Upload, preview (dry_run=1), per-row validation, duplicate staff_no
 * detection in-file and against the DB, scope check per row.  ?mode=all
 * makes the commit all-or-nothing; the default commits the valid rows.
 * The may-proceed decision uses the invalid COUNT — never errors.length,
 * which stops at MAX_ERRORS_SHOWN. */
router.post('/import', requireAuth, scope.requireTeacherConsole, writeLimiter, csvMemory.single('file'),
  function (req, res) {
    if (!req.file) return res.status(400).json({ error: 'Upload a CSV file (use the downloadable template).' });
    const body = req.body || {};
    const dryRun = String(body.dry_run || '') === '1' || String(body.dry_run || '').toLowerCase() === 'true';
    const atomic = String(body.mode || '').toLowerCase() === 'all';
    let rows;
    try {
      rows = csv.toObjects(req.file.buffer.toString('utf8').slice(0, 2 * 1024 * 1024));
    } catch (err) {
      return res.status(422).json({ error: 'That file could not be read as CSV.' });
    }
    if (!rows.length) return res.status(422).json({ error: 'The CSV file contains no data rows.' });
    if (rows.length > 5000) return res.status(422).json({ error: 'That file holds too many rows (maximum 5000).' });

    const report = previewTeacherImport(req.user, rows);
    const payload = {
      ok: true,
      report: {
        total: rows.length,
        valid: report.valid.length,
        invalid: report.invalid,
        created: 0,
        errors: report.errors,
        truncated: report.truncated,
        dry_run: dryRun
      }
    };

    /* Preview, nothing worth writing, or an atomic import with ANY bad row:
     * stop before touching the database. */
    if (dryRun || report.valid.length === 0 || (atomic && report.invalid > 0)) {
      return res.json(payload);
    }

    const insert = db.prepare(
      'INSERT INTO teachers (school_id, staff_no, full_name, sex, date_of_birth, qualification, ' +
      'subject, rank, phone, status) VALUES ' +
      '(@school_id, @staff_no, @full_name, @sex, @date_of_birth, @qualification, @subject, @rank, @phone, @status)'
    );
    db.transaction(function () {
      report.valid.forEach(function (v) { insert.run(v); });
    })();
    payload.report.created = report.valid.length;
    db.logAudit(req.user, 'teacher.import', 'teacher', '', {
      total: rows.length, created: report.valid.length, invalid: report.invalid, atomic: atomic
    }, req);
    return res.json(payload);
  });

module.exports = router;
