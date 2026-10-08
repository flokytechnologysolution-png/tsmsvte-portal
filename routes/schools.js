/**
 * routes/schools.js — public schools directory + admin CRUD + CSV import.
 *
 * The schools table is seeded EMPTY apart from the 16 LGAs: the ministry adds
 * real schools one by one or with the CSV bulk importer.  Nothing is invented.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const scope = require('../middleware/scope');
const { csvMemory } = require('../middleware/upload');
const { handleErrors, clean, toIntOrNull } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');
const csv = require('../lib/csv');

const router = express.Router();

const CSV_HEADERS = ['name', 'lga', 'address', 'principal', 'phone', 'email',
  'type', 'category', 'boarding', 'year_established'];

async function lgaLookup() {
  const map = {};
  const key = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  (await db.query('SELECT id, name, slug FROM lgas')).forEach(function (r) {
    /* The entry carries the id as well as the display name so the write paths
     * can set schools.lga_id from a row they have actually validated. */
    const hit = { id: r.id, name: r.name };
    map[r.name.toLowerCase()] = hit;
    map[r.slug] = hit;
    /* Also accept any spacing/hyphenation, so a list written before the
     * "Karim-Lamido" rename (e.g. "Karim Lamido") still matches. */
    map[key(r.name)] = hit;
    map[key(r.slug)] = hit;
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

/* SQLite says "UNIQUE constraint failed: ..."; PostgreSQL says "duplicate key
 * value violates unique constraint ...".  Both mean the same 409. */
function isDuplicateKey(err) {
  const msg = String((err && err.message) || '');
  return msg.indexOf('UNIQUE') !== -1 || msg.indexOf('duplicate key') !== -1;
}

/* Filter options for the directory UI */
router.get('/options', asyncHandler(async function (req, res) {
  res.json({
    lgas: await db.query('SELECT name, slug FROM lgas ORDER BY sort_order'),
    types: db.SCHOOL_TYPES,
    categories: db.SCHOOL_CATEGORIES,
    boarding: db.BOARDING_TYPES
  });
}));

/* Per-LGA summary with counts (home page quick stats + directory browse) */
router.get('/lgas', asyncHandler(async function (req, res) {
  /* `id` is included so administrative pickers (LGA-scoped roles) can post it
   * back; the summary fields are unchanged. */
  const sc = await scope.lgaListWhere(req.user, 'l');
  const where = sc.sql ? (' WHERE ' + sc.sql) : '';
  const rows = await db.query(
    `SELECT l.id, l.name, l.slug, COUNT(s.id) AS total
     FROM lgas l LEFT JOIN schools s ON s.lga_id = l.id AND s.status = 'active'
     ${where}
     GROUP BY l.id ORDER BY l.sort_order`,
    sc.params
  );
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ lgas: rows, total_lgas: rows.length });
}));

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

router.get('/', asyncHandler(async function (req, res) {
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

  /* Scope is applied here, not in the filters above, so a scoped caller cannot
   * widen their view by passing ?lga= of somebody else's. */
  const sc = await scope.schoolWhere(req.user, 's');
  if (sc.sql) { where.push(sc.sql); params.push.apply(params, sc.params); }

  const whereSql = where.join(' AND ');
  const totalRow = await db.get('SELECT COUNT(*) AS n FROM schools s WHERE ' + whereSql, params);
  const total = totalRow ? totalRow.n : 0;
  /* LOWER() instead of COLLATE NOCASE: the SQLite-only collation does not
   * exist in PostgreSQL, and LOWER() orders case-insensitively on both. */
  const rows = await db.query(
    'SELECT * FROM schools s WHERE ' + whereSql +
    ' ORDER BY LOWER(s.name) LIMIT ? OFFSET ?',
    params.concat([limit, (page - 1) * limit])
  );

  res.json({
    schools: rows.map(schoolFrom),
    total: total,
    page: page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit: limit
  });
}));

/* ---------------------------- admin: write ---------------------------- */

async function readSchoolBody(body) {
  const lgas = await lgaLookup();
  const name = clean(body.name).slice(0, 200);
  const lgaRaw = clean(body.lga);
  const lgaKey = lgaRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = lgas[lgaRaw.toLowerCase()] || lgas[db.slugify(lgaRaw)] || lgas[lgaKey] || null;
  const lga = hit ? hit.name : '';
  /* The id is only ever taken from a row that matched the real lgas table —
   * an unknown name yields null and is rejected below, never guessed. */
  const lgaId = hit ? hit.id : null;
  const type = normType(body.type);
  const category = normCategory(body.category);
  const boarding = normBoarding(body.boarding);
  const year = toIntOrNull(body.year_established);
  const errors = [];

  if (!name) errors.push('School name is required.');
  if (!lga || !lgaId) errors.push('LGA must be one of the 16 Taraba State LGAs.');
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
      lga_id: lgaId,
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

/* LGA_OFFICER may add schools inside their own LGA; SCHOOL_ADMIN may not add
 * schools at all.  requireRole('ADMIN') is dropped here because it would refuse
 * the LGA_OFFICER outright — requireSchoolCreate does the finer check. */
router.post('/', requireAuth, scope.requireSchoolCreate, writeLimiter, asyncHandler(async function (req, res, next) {
  const parsed = await readSchoolBody(req.body || {});
  if (parsed.errors.length) {
    return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
  }
  const v = parsed.value;
  if (!(await scope.canCreateSchool(req.user, v.lga_id))) {
    return res.status(422).json({ error: 'You can only add schools inside your own LGA.' });
  }
  try {
    const info = await db.run(
      `INSERT INTO schools (name, lga, lga_id, address, principal, phone, email, type, category, boarding, year_established, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.name, v.lga, v.lga_id, v.address, v.principal, v.phone, v.email,
       v.type, v.category, v.boarding, v.year_established, v.notes, v.status]
    );
    await db.logAudit(req.user, 'school.create', 'school', info.lastInsertRowid, { name: v.name, lga: v.lga }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return res.status(409).json({ error: 'A school with that name already exists in ' + v.lga + '.' });
    }
    return next(err);
  }
}));

/* NOTE: the numeric guard keeps /export.csv and /template.csv reachable. */
router.get('/:id([0-9]+)', scope.requireSchoolScope, function (req, res) {
  return res.json({ school: schoolFrom(req.school) });
});

/* Scope decides who may reach the row at all (out-of-scope -> 404); the caller's
 * scope kind then decides how much of the record they may rewrite. */
router.put('/:id([0-9]+)', requireAuth, scope.requireSchoolScope, writeLimiter, asyncHandler(async function (req, res, next) {
  const existing = req.school;
  const id = existing.id;

  const parsed = await readSchoolBody(Object.assign({}, existing, req.body || {}));
  if (parsed.errors.length) {
    return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
  }

  const v = parsed.value;
  const kind = (await scope.scopeOf(req.user)).kind;
  if (kind === 'lga' || kind === 'school') {
    /* Nobody may relocate a record into or out of their own scope — the text
     * column and the FK are pinned together. */
    v.lga = existing.lga;
    v.lga_id = existing.lga_id;
  }
  if (kind === 'school') {
    /* A school admin may not rename or retire their own record either. */
    v.name = existing.name;
    v.status = existing.status;
  }
  v.id = id;
  try {
    await db.run(
      `UPDATE schools SET name=?, lga=?, lga_id=?, address=?, principal=?, phone=?,
        email=?, type=?, category=?, boarding=?, year_established=?,
        notes=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [v.name, v.lga, v.lga_id, v.address, v.principal, v.phone,
       v.email, v.type, v.category, v.boarding, v.year_established,
       v.notes, v.status, v.id]
    );
    await db.logAudit(req.user, 'school.update', 'school', id, {
      name: v.name, scope: kind
    }, req);
    return res.json({ ok: true });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return res.status(409).json({ error: 'Another school already uses that name in ' + v.lga + '.' });
    }
    return next(err);
  }
}));

/* Deleting is a statewide action: an out-of-scope row is a 404, then a row the
 * caller can see but not delete is a 403.  Nothing outside their scope leaks. */
router.delete('/:id([0-9]+)', requireAuth, scope.requireSchoolScope, writeLimiter,
  asyncHandler(async function (req, res) {
    const row = req.school;
    if (!(await scope.canDeleteSchool(req.user))) {
      return res.status(403).json({ error: 'Your role cannot delete schools from the directory.' });
    }
    /* A school with teachers on its books cannot be deleted: the register
     * points at it, and silently orphaning people is worse than refusing. */
    const held = await db.get('SELECT COUNT(*) AS n FROM teachers WHERE school_id = ?', [row.id]);
    if (held && held.n > 0) {
      return res.status(409).json({
        error: 'That school still has ' + held.n + ' teacher' + (held.n === 1 ? '' : 's') +
          ' on its books. Transfer or remove them first.'
      });
    }
    await db.run('DELETE FROM schools WHERE id = ?', [row.id]);
    await db.logAudit(req.user, 'school.delete', 'school', row.id, { name: row.name }, req);
    return res.json({ ok: true });
  }));

/* ----------------------------- CSV import ----------------------------- */

/* Export and import honour the same scope as the list: an officer's export
 * contains only their LGA, so it cannot become a side channel. */
router.get('/export.csv', requireAuth, asyncHandler(async function (req, res) {
  const sc = await scope.schoolWhere(req.user, 's');
  const where = sc.sql ? (' WHERE ' + sc.sql) : '';
  const rows = (await db.query(
    'SELECT * FROM schools s' + where + ' ORDER BY s.lga, LOWER(s.name)',
    sc.params
  ))
    .map(function (r) {
      return {
        name: r.name, lga: r.lga, address: r.address, principal: r.principal, phone: r.phone,
        email: r.email, type: r.type, category: r.category, boarding: r.boarding,
        year_established: r.year_established === null ? '' : r.year_established
      };
    });
  await db.logAudit(req.user, 'school.export', 'school', '', { count: rows.length }, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="schools-export.csv"');
  res.send(csv.toCsv(CSV_HEADERS, rows));
}));

router.post('/import', requireAuth, scope.requireSchoolCreate, writeLimiter, csvMemory.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file) return res.status(400).json({ error: 'Upload a CSV file (use the downloadable template).' });
    const dryRun = String(req.body.dry_run || '') === '1' || String(req.body.dry_run || '') === 'true';
    const rows = csv.toObjects(req.file.buffer.toString('utf8').slice(0, 2 * 1024 * 1024));
    if (!rows.length) return res.status(422).json({ error: 'The CSV file contains no data rows.' });
    if (!(await scope.canImportSchools(req.user))) {
      return res.status(403).json({ error: 'Your role cannot import schools.' });
    }

    const report = { total: rows.length, created: 0, updated: 0, failed: 0, errors: [], dry_run: dryRun };
    /* One transaction for the whole file: a failure rolls every row back
     * instead of leaving a half-imported directory behind. */
    const UPSERT_SQL =
      `INSERT INTO schools (name, lga, lga_id, address, principal, phone, email, type, category, boarding, year_established, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name, lga) DO UPDATE SET
         address=excluded.address, principal=excluded.principal, phone=excluded.phone, email=excluded.email,
         type=excluded.type, category=excluded.category, boarding=excluded.boarding,
         lga_id=excluded.lga_id, year_established=excluded.year_established, updated_at=CURRENT_TIMESTAMP`;

    await db.withTransaction(async function (tx) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const parsed = await readSchoolBody(row);
        if (parsed.errors.length) {
          report.failed += 1;
          if (report.errors.length < 60) report.errors.push({ row: i + 2, error: parsed.errors[0] });
          continue;
        }
        const v = parsed.value;
        /* A row naming another LGA is refused outright rather than rewritten. */
        if (!(await scope.canCreateSchool(req.user, v.lga_id))) {
          report.failed += 1;
          if (report.errors.length < 60) {
            report.errors.push({ row: i + 2, error: 'Outside your scope: ' + v.lga + '.' });
          }
          continue;
        }
        const had = await tx.get('SELECT id FROM schools WHERE name = ? AND lga = ?', [v.name, v.lga]);
        if (dryRun) {
          if (had) report.updated += 1; else report.created += 1;
          continue;
        }
        await tx.run(UPSERT_SQL, [
          v.name, v.lga, v.lga_id, v.address, v.principal, v.phone, v.email,
          v.type, v.category, v.boarding, v.year_established, v.notes, v.status
        ]);
        if (had) report.updated += 1; else report.created += 1;
      }
    });

    if (!dryRun) await db.logAudit(req.user, 'school.import', 'school', '', report, req);
    return res.json({ ok: true, report: report });
  }), handleErrors);

module.exports = router;