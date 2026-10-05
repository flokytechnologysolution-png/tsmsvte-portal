/**
 * routes/schools.js — public schools directory + admin CRUD + CSV import.
 *
 * The schools table is seeded EMPTY apart from the 16 LGAs: the ministry adds
 * real schools one by one or with the CSV bulk importer.  Nothing is invented.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { csvMemory } = require('../middleware/upload');
const { handleErrors, clean, toIntOrNull } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');
const csv = require('../lib/csv');

const router = express.Router();

const CSV_HEADERS = ['name', 'lga', 'address', 'principal', 'phone', 'email',
  'type', 'category', 'boarding', 'year_established'];

function lgaLookup() {
  const map = {};
  const key = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  db.prepare('SELECT name, slug FROM lgas').all().forEach(function (r) {
    map[r.name.toLowerCase()] = r.name;
    map[r.slug] = r.name;
    /* Also accept any spacing/hyphenation, so a list written before the
     * "Karim-Lamido" rename (e.g. "Karim Lamido") still matches. */
    map[key(r.name)] = r.name;
    map[key(r.slug)] = r.name;
  });
  return map;
}

function normType(value) {
  const v = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!v) return '';
  if (v === 'juniorsecondary' || v === 'junior' || v === 'jss') return 'junior_secondary';
  if (v === 'seniorsecondary' || v === 'senior' || v === 'sss') return 'senior_secondary';
  if (v === 'technical') return 'technical';
  if (v === 'vocational') return 'vocational';
  return '';
}

function normCategory(value) {
  const v = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!v) return '';
  if (v === 'boys' || v === 'allboys' || v === 'male') return 'boys';
  if (v === 'girls' || v === 'allgirls' || v === 'female') return 'girls';
  if (v === 'mixed' || v === 'coed' || v === 'coeducational') return 'mixed';
  return '';
}

function normBoarding(value) {
  const v = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!v) return '';
  if (v === 'boarding' || v === 'board') return 'boarding';
  if (v === 'day') return 'day';
  if (v === 'both') return 'both';
  return '';
}

function schoolFrom(row) {
  return {
    id: row.id,
    name: row.name,
    lga: row.lga,
    address: row.address,
    principal: row.principal,
    phone: row.phone,
    email: row.email,
    type: row.type,
    category: row.category,
    boarding: row.boarding,
    year_established: row.year_established,
    status: row.status,
    updated_at: row.updated_at
  };
}

/* ------------------------------- public ------------------------------- */

/* Filter options for the directory UI */
router.get('/options', function (req, res) {
  res.json({
    lgas: db.prepare('SELECT name, slug FROM lgas ORDER BY sort_order').all(),
    types: db.SCHOOL_TYPES,
    categories: db.SCHOOL_CATEGORIES,
    boarding: db.BOARDING_TYPES
  });
});

/* Per-LGA summary with counts (home page quick stats + directory browse) */
router.get('/lgas', function (req, res) {
  const rows = db.prepare(
    `SELECT l.name, l.slug, COUNT(s.id) AS total
     FROM lgas l LEFT JOIN schools s ON s.lga = l.name AND s.status = 'active'
     GROUP BY l.id ORDER BY l.sort_order`
  ).all();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ lgas: rows, total_lgas: rows.length });
});

router.get('/template.csv', function (req, res) {
  const sample = {
    name: 'Full official school name',
    lga: 'Jalingo',
    address: 'Street / town',
    principal: 'Name of principal',
    phone: '08000000000',
    email: '',
    type: 'junior_secondary',
    category: 'mixed',
    boarding: 'day',
    year_established: '2000'
  };
  const body = csv.toCsv(CSV_HEADERS, [sample]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="schools-import-template.csv"');
  res.send(body);
});

router.get('/', function (req, res) {
  const q = clean(req.query.q || '').slice(0, 80);
  const lga = clean(req.query.lga || '').slice(0, 60);
  const type = clean(req.query.type || '');
  const category = clean(req.query.category || '');
  const boarding = clean(req.query.boarding || '');
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '20', 10) || 20));

  const where = ["s.status = 'active'"];
  const params = [];
  if (q) { where.push('(s.name LIKE ? OR s.address LIKE ? OR s.principal LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (lga) { where.push('s.lga = ?'); params.push(lga); }
  if (db.SCHOOL_TYPES.indexOf(type) !== -1) { where.push('s.type = ?'); params.push(type); }
  if (db.SCHOOL_CATEGORIES.indexOf(category) !== -1) { where.push('s.category = ?'); params.push(category); }
  if (db.BOARDING_TYPES.indexOf(boarding) !== -1) { where.push('s.boarding = ?'); params.push(boarding); }

  const whereSql = where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) AS n FROM schools s WHERE ' + whereSql).get(...params).n;
  const rows = db.prepare(
    'SELECT * FROM schools s WHERE ' + whereSql +
    ' ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?'
  ).all(...params, limit, (page - 1) * limit);

  res.json({
    schools: rows.map(schoolFrom),
    total: total,
    page: page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit: limit
  });
});

/* ---------------------------- admin: write ---------------------------- */

function readSchoolBody(body) {
  const lgas = lgaLookup();
  const name = clean(body.name).slice(0, 200);
  const lgaRaw = clean(body.lga);
  const lgaKey = lgaRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lga = lgas[lgaRaw.toLowerCase()] || lgas[db.slugify(lgaRaw)] || lgas[lgaKey] || '';
  const type = normType(body.type);
  const category = normCategory(body.category);
  const boarding = normBoarding(body.boarding);
  const year = toIntOrNull(body.year_established);
  const errors = [];

  if (!name) errors.push('School name is required.');
  if (!lga) errors.push('LGA must be one of the 16 Taraba State LGAs.');
  if (!type) errors.push('Type must be junior_secondary, senior_secondary, technical or vocational.');
  if (!category) errors.push('Category must be boys, girls or mixed.');
  if (!boarding) errors.push('Boarding must be boarding, day or both.');
  if (year !== null && (year < 1800 || year > new Date().getFullYear() + 1)) {
    errors.push('Year established looks wrong.');
  }

  return {
    errors: errors,
    value: {
      name: name,
      lga: lga,
      address: clean(body.address).slice(0, 300),
      principal: clean(body.principal).slice(0, 120),
      phone: clean(body.phone).slice(0, 40),
      email: clean(body.email).slice(0, 120),
      type: type,
      category: category,
      boarding: boarding,
      year_established: year,
      notes: clean(body.notes).slice(0, 1000),
      status: body.status === 'inactive' ? 'inactive' : 'active'
    }
  };
}

router.post('/', requireRole('ADMIN'), writeLimiter, function (req, res, next) {
  const parsed = readSchoolBody(req.body || {});
  if (parsed.errors.length) {
    return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
  }
  const v = parsed.value;
  try {
    const info = db.prepare(
      `INSERT INTO schools (name, lga, address, principal, phone, email, type, category, boarding, year_established, notes, status)
       VALUES (@name, @lga, @address, @principal, @phone, @email, @type, @category, @boarding, @year_established, @notes, @status)`
    ).run(v);
    db.logAudit(req.user, 'school.create', 'school', info.lastInsertRowid, { name: v.name, lga: v.lga }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).indexOf('UNIQUE') !== -1) {
      return res.status(409).json({ error: 'A school with that name already exists in ' + v.lga + '.' });
    }
    return next(err);
  }
});

/* NOTE: the numeric guard keeps /export.csv and /template.csv reachable. */
router.get('/:id([0-9]+)', function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM schools WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'School not found' });
  return res.json({ school: schoolFrom(row) });
});

router.put('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, function (req, res, next) {
  const id = toIntOrNull(req.params.id);
  const existing = id ? db.prepare('SELECT * FROM schools WHERE id = ?').get(id) : null;
  if (!existing) return res.status(404).json({ error: 'School not found' });

  const parsed = readSchoolBody(Object.assign({}, existing, req.body || {}));
  if (parsed.errors.length) {
    return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
  }

  const v = parsed.value;
  v.id = id;
  try {
    db.prepare(
      `UPDATE schools SET name=@name, lga=@lga, address=@address, principal=@principal, phone=@phone,
        email=@email, type=@type, category=@category, boarding=@boarding, year_established=@year_established,
        notes=@notes, status=@status, updated_at=datetime('now') WHERE id=@id`
    ).run(v);
    db.logAudit(req.user, 'school.update', 'school', id, { name: v.name }, req);
    return res.json({ ok: true });
  } catch (err) {
    if (String(err.message).indexOf('UNIQUE') !== -1) {
      return res.status(409).json({ error: 'Another school already uses that name in ' + v.lga + '.' });
    }
    return next(err);
  }
});

router.delete('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM schools WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'School not found' });
  db.prepare('DELETE FROM schools WHERE id = ?').run(id);
  db.logAudit(req.user, 'school.delete', 'school', id, { name: row.name }, req);
  return res.json({ ok: true });
});

/* ----------------------------- CSV import ----------------------------- */

router.get('/export.csv', requireRole('ADMIN'), function (req, res) {
  const rows = db.prepare('SELECT * FROM schools ORDER BY lga, name COLLATE NOCASE').all()
    .map(function (r) {
      return {
        name: r.name, lga: r.lga, address: r.address, principal: r.principal, phone: r.phone,
        email: r.email, type: r.type, category: r.category, boarding: r.boarding,
        year_established: r.year_established === null ? '' : r.year_established
      };
    });
  db.logAudit(req.user, 'school.export', 'school', '', { count: rows.length }, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="schools-export.csv"');
  res.send(csv.toCsv(CSV_HEADERS, rows));
});

router.post('/import', requireRole('ADMIN'), writeLimiter, csvMemory.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file) return res.status(400).json({ error: 'Upload a CSV file (use the downloadable template).' });
    const dryRun = String(req.body.dry_run || '') === '1' || String(req.body.dry_run || '') === 'true';
    const rows = csv.toObjects(req.file.buffer.toString('utf8').slice(0, 2 * 1024 * 1024));
    if (!rows.length) return res.status(422).json({ error: 'The CSV file contains no data rows.' });

    const report = { total: rows.length, created: 0, updated: 0, failed: 0, errors: [], dry_run: dryRun };
    const insert = db.prepare(
      `INSERT INTO schools (name, lga, address, principal, phone, email, type, category, boarding, year_established, notes, status)
       VALUES (@name, @lga, @address, @principal, @phone, @email, @type, @category, @boarding, @year_established, @notes, @status)
       ON CONFLICT (name, lga) DO UPDATE SET
         address=excluded.address, principal=excluded.principal, phone=excluded.phone, email=excluded.email,
         type=excluded.type, category=excluded.category, boarding=excluded.boarding,
         year_established=excluded.year_established, updated_at=datetime('now')`
    );
    const exists = db.prepare('SELECT id FROM schools WHERE name = ? AND lga = ?');

    const run = db.transaction(function () {
      rows.forEach(function (row, i) {
        const parsed = readSchoolBody(row);
        if (parsed.errors.length) {
          report.failed += 1;
          if (report.errors.length < 60) report.errors.push({ row: i + 2, error: parsed.errors[0] });
          return;
        }
        const v = parsed.value;
        const had = exists.get(v.name, v.lga);
        if (dryRun) {
          if (had) report.updated += 1; else report.created += 1;
          return;
        }
        insert.run(v);
        if (had) report.updated += 1; else report.created += 1;
      });
    });
    run();

    if (!dryRun) db.logAudit(req.user, 'school.import', 'school', '', report, req);
    return res.json({ ok: true, report: report });
  }), handleErrors);

module.exports = router;