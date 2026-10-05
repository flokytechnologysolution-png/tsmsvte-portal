/**
 * tools/seed.js — safe, re-runnable bulk loader and sample content.
 *
 * Run it through npm so the flags after "--" reach this script:
 *
 *   npm run seed -- --schools data/schools.csv        import schools (CSV/JSON)
 *   npm run seed -- --schools data/schools.csv --dry-run
 *   npm run seed -- --sample                          add sample news + circulars
 *   npm run seed -- --wipe-samples                    remove ONLY the samples
 *
 * Design notes
 *   • Idempotent.  Schools are matched on (name + LGA) and updated in place;
 *     news and circulars are matched on their title.  Running it twice never
 *     creates a duplicate.
 *   • One transaction per run.  Every write happens inside a single
 *     better-sqlite3 transaction, so a failure rolls the whole run back.
 *   • Real data is never destroyed.  Rows created by this tool carry
 *     is_sample = 1 (added by a migration in db.js); --wipe-samples filters on
 *     that flag alone.
 *   • No new dependencies.  CSV parsing reuses the project's own hand-written
 *     parser (lib/csv.js) and validation mirrors routes/schools.js.
 *
 * CSV/JSON school columns: name, lga, type, address, phone, email, principal
 * (only name and lga are required) plus the optional category, boarding,
 * year_established, notes, status and is_sample.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const db = require('../db');
const csv = require('../lib/csv');
const { clean, toIntOrNull } = require('../middleware/validate');

const CIRCULAR_DIR = path.join(db.UPLOAD_DIR, 'circulars');

/* School defaults — these mirror the column defaults in db.js. */
const DEFAULT_TYPE = 'junior_secondary';
const DEFAULT_CATEGORY = 'mixed';
const DEFAULT_BOARDING = 'day';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/* Case/space/hyphen-insensitive key.  Lets "Karim-Lamido", "karim lamido",
 * "KARIM_LAMIDO" and the stored official spelling all resolve to the same
 * LGA, so a CSV written before the rename still imports cleanly. */
function normKey(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Trim, drop control characters and collapse runs of whitespace, so
 * "  A   B " and "A B" are the same name for matching purposes. */
function normName(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function truthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].indexOf(
    String(value === null || value === undefined ? '' : value).trim().toLowerCase()
  ) !== -1;
}

/* These three mirror routes/schools.js exactly so imported rows obey the
 * same rules as rows typed into the admin console. */
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

function lgaMap() {
  const map = {};
  db.prepare('SELECT name, slug FROM lgas').all().forEach(function (r) {
    map[normKey(r.name)] = r.name;
    map[normKey(r.slug)] = r.name;
  });
  return map;
}

/* Who to credit as author/creator of the sample rows (never a hardcoded
 * person): the portal owner if one exists, otherwise the first user. */
function authorId() {
  const row = db.prepare("SELECT id FROM users WHERE role = 'OWNER' ORDER BY id LIMIT 1").get()
    || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  return row ? row.id : null;
}

/* ------------------------------------------------------------------ *
 * School file loading + mapping
 * ------------------------------------------------------------------ */

function loadSchoolFile(file) {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error('School file not found: ' + file);

  const text = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();
  let rows;

  if (ext === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('That JSON file could not be parsed: ' + err.message);
    }
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && Array.isArray(parsed.schools)) rows = parsed.schools;
    else throw new Error('JSON must be an array of school objects (or { "schools": [ ... ] }).');
  } else {
    rows = csv.toObjects(text);            /* lib/csv.js: quotes, commas, newlines */
  }

  if (!rows.length) throw new Error('The file contains no data rows.');

  /* A file called e.g. schools.sample.csv is treated as sample data unless a
   * row carries an explicit is_sample flag. */
  const sampleDefault = /sample/i.test(path.basename(abs));
  return { rows: rows, sampleDefault: sampleDefault };
}

function mapSchoolRow(raw, lgas) {
  const name = normName(raw.name);
  const lgaRaw = clean(raw.lga);
  const lga = lgas[normKey(lgaRaw)] || '';
  const year = toIntOrNull(raw.year_established);
  const errors = [];

  if (!name) errors.push('missing name');
  if (!lga) errors.push(lgaRaw ? 'unknown LGA "' + lgaRaw + '"' : 'missing lga');
  if (year !== null && (year < 1800 || year > new Date().getFullYear() + 1)) {
    errors.push('year_established out of range');
  }

  return {
    errors: errors,
    value: {
      name: name,
      lga: lga,
      address: clean(raw.address).slice(0, 300),
      principal: clean(raw.principal).slice(0, 120),
      phone: clean(raw.phone).slice(0, 40),
      email: clean(raw.email).slice(0, 120),
      type: normType(raw.type) || DEFAULT_TYPE,
      category: normCategory(raw.category) || DEFAULT_CATEGORY,
      boarding: normBoarding(raw.boarding) || DEFAULT_BOARDING,
      year_established: year,
      notes: clean(raw.notes).slice(0, 1000),
      status: String(raw.status || '').toLowerCase() === 'inactive' ? 'inactive' : 'active'
    }
  };
}

/* Build the school part of the plan.  Pure computation — nothing is written
 * here, so the same code powers --dry-run. */
function planSchools(loaded, lgas, report) {
  const inserts = [];
  const updates = [];

  /* Existing rows grouped by LGA, keyed by a case/space-insensitive name. */
  const existing = {};
  db.prepare('SELECT id, name, lga FROM schools').all().forEach(function (r) {
    existing[r.lga] = existing[r.lga] || {};
    existing[r.lga][normName(r.name).toLowerCase()] = r.id;
  });

  loaded.rows.forEach(function (raw, i) {
    const parsed = mapSchoolRow(raw, lgas);
    const lineNumber = i + 2;                     /* +1 header, +1 to be 1-based */

    if (parsed.errors.length) {
      report.skipped.push({ row: lineNumber, reason: parsed.errors[0] });
      return;
    }

    const v = parsed.value;
    const explicit = raw.is_sample !== undefined ? raw.is_sample : raw.sample;
    v.is_sample = explicit !== undefined && String(explicit).trim() !== ''
      ? (truthy(explicit) ? 1 : 0)
      : (loaded.sampleDefault ? 1 : 0);

    const bucket = existing[v.lga] || {};
    const id = bucket[normName(v.name).toLowerCase()];
    if (id) {
      updates.push({ id: id, value: v });
    } else {
      inserts.push(v);
    }
  });

  return { inserts: inserts, updates: updates };
}


/* ------------------------------------------------------------------ *
 * Sample content
 *
 * Deliberately free of ministry facts: no statistics, quotations, dates of
 * real events or names of officials.  Every sentence a visitor reads is
 * either neutral or an explicit instruction to replace it.
 * ------------------------------------------------------------------ */
const SAMPLE_NEWS = [
  {
    title: 'Free education support in Taraba State',
    category: 'Programme',
    summary: 'Sample item — the free education programme. Replace with the approved text.',
    body: 'SAMPLE NEWS ITEM\n\n' +
      'This item was created by tools/seed.js so the portal has something to show. ' +
      'It is not official ministry news.\n\n' +
      'Use it as a placeholder for the free education programme: open Admin -> News, ' +
      'edit or delete this item, and enter the approved wording.\n\n' +
      'No statistics, quotations, dates or names of officials have been added here.'
  },
  {
    title: 'Support for the girl-child in our schools',
    category: 'Programme',
    summary: 'Sample item — support for the girl-child. Replace with the approved text.',
    body: 'SAMPLE NEWS ITEM\n\n' +
      'This item was created by tools/seed.js so the portal has something to show. ' +
      'It is not official ministry news.\n\n' +
      'Use it as a placeholder for the girl-child support programme: open Admin -> News, ' +
      'edit or delete this item, and enter the approved wording.\n\n' +
      'No statistics, quotations, dates or names of officials have been added here.'
  },
  {
    title: 'Staff registration on the portal',
    category: 'Notice',
    summary: 'Sample item — a reminder that staff can register. Replace with the approved text.',
    body: 'SAMPLE NEWS ITEM\n\n' +
      'This item was created by tools/seed.js so the portal has something to show. ' +
      'It is not official ministry news.\n\n' +
      'Use it as a placeholder for a staff registration reminder: open Admin -> News, ' +
      'edit or delete this item, and enter the approved wording.\n\n' +
      'No statistics, quotations, dates or names of officials have been added here.'
  }
];

const SAMPLE_CIRCULARS = [
  {
    file_name: 'sample-staff-registration-notice.txt',
    title: 'Staff registration notice',
    category: 'Notice',
    description: 'Sample document — staff registration on the portal. Replace with the official PDF.'
  },
  {
    file_name: 'sample-meeting-notice.txt',
    title: 'Meeting notice',
    category: 'Circular',
    description: 'Sample document — a meeting notice. Replace with the official PDF.'
  }
];

/* The document body a sample circular points at.  Clearly a placeholder. */
function sampleDocBody(title) {
  return 'PLACEHOLDER DOCUMENT\n' +
    '============================================================\n\n' +
    title + '\n\n' +
    'This file was created by tools/seed.js so the download link on the portal\n' +
    'works while the real document is being prepared.  It is NOT a ministry\n' +
    'document.\n\n' +
    'Replace it by uploading the official PDF from Admin -> Circulars.\n';
}

/* Unique news slug: slugify the title, then append -2, -3 ... on collision. */
function uniqueSlug(title, taken) {
  const base = db.slugify(title) || 'news';
  let slug = base;
  let n = 1;
  while (taken[slug] || db.prepare('SELECT 1 FROM news WHERE slug = ?').get(slug)) {
    n += 1;
    slug = base + '-' + n;
  }
  taken[slug] = true;
  return slug;
}

/* Queue the sample news + circulars.  Pure computation — no writes. */
function planSamples() {
  const author = authorId();
  const taken = {};
  const newsInserts = [];
  const newsSkipped = [];
  const circularInserts = [];
  const circularSkipped = [];
  const files = [];

  SAMPLE_NEWS.forEach(function (item) {
    const title = normName(item.title);
    const existing = db.prepare('SELECT id FROM news WHERE lower(trim(title)) = lower(trim(?))').get(title);
    if (existing) { newsSkipped.push(title); return; }
    newsInserts.push({
      title: title,
      slug: uniqueSlug(title, taken),
      summary: item.summary,
      body: item.body,
      category: item.category,
      author_id: author,
      is_sample: 1
    });
  });

  SAMPLE_CIRCULARS.forEach(function (item) {
    const title = normName(item.title);
    const existing = db.prepare('SELECT id FROM circulars WHERE lower(trim(title)) = lower(trim(?))').get(title);
    if (existing) { circularSkipped.push(title); return; }

    const body = sampleDocBody(item.title);
    files.push({ name: item.file_name, body: body });

    circularInserts.push({
      title: title,
      description: item.description,
      category: item.category,
      file_path: '/uploads/circulars/' + item.file_name,
      file_name: item.file_name,
      file_size: Buffer.byteLength(body),
      created_by: author,
      is_sample: 1
    });
  });

  return {
    newsInserts: newsInserts,
    newsSkipped: newsSkipped,
    circularInserts: circularInserts,
    circularSkipped: circularSkipped,
    files: files
  };
}


/* ------------------------------------------------------------------ *
 * Execute the plan — everything inside ONE transaction
 * ------------------------------------------------------------------ */
function execute(schoolPlan, samplePlan, dryRun) {
  if (dryRun) return;

  const insertSchool = db.prepare(
    `INSERT INTO schools (name, lga, address, principal, phone, email, type, category, boarding,
                          year_established, notes, status, is_sample)
     VALUES (@name, @lga, @address, @principal, @phone, @email, @type, @category, @boarding,
             @year_established, @notes, @status, @is_sample)`
  );
  const updateSchool = db.prepare(
    `UPDATE schools SET address=@address, principal=@principal, phone=@phone, email=@email,
       type=@type, category=@category, boarding=@boarding, year_established=@year_established,
       notes=@notes, status=@status, updated_at=datetime('now')
     WHERE id=@id`
  );
  const insertNews = db.prepare(
    `INSERT INTO news (title, slug, summary, body, category, cover_image, status, author_id, published_at, is_sample)
     VALUES (@title, @slug, @summary, @body, @category, '', 'published', @author_id, datetime('now'), @is_sample)`
  );
  const insertCircular = db.prepare(
    `INSERT INTO circulars (title, description, category, file_path, file_name, file_size, status, created_by, is_sample)
     VALUES (@title, @description, @category, @file_path, @file_name, @file_size, 'published', @created_by, @is_sample)`
  );

  const tx = db.transaction(function () {
    /* Placeholder documents first (idempotent: fixed file names). */
    if (samplePlan) {
      fs.mkdirSync(CIRCULAR_DIR, { recursive: true });
      samplePlan.files.forEach(function (f) {
        fs.writeFileSync(path.join(CIRCULAR_DIR, f.name), f.body, 'utf8');
      });
    }
    schoolPlan.inserts.forEach(function (r) { insertSchool.run(r); });
    schoolPlan.updates.forEach(function (r) {
      const v = r.value;
      updateSchool.run({
        id: r.id, address: v.address, principal: v.principal, phone: v.phone, email: v.email,
        type: v.type, category: v.category, boarding: v.boarding,
        year_established: v.year_established, notes: v.notes, status: v.status
      });
    });
    if (samplePlan) {
      samplePlan.newsInserts.forEach(function (r) { insertNews.run(r); });
      samplePlan.circularInserts.forEach(function (r) { insertCircular.run(r); });
    }
  });
  tx();
}

/* ------------------------------------------------------------------ *
 * --wipe-samples : delete only the rows this tool created
 * ------------------------------------------------------------------ */
function wipeSamples(dryRun) {
  const counts = {
    schools: db.prepare('SELECT COUNT(*) AS n FROM schools WHERE is_sample = 1').get().n,
    news: db.prepare('SELECT COUNT(*) AS n FROM news WHERE is_sample = 1').get().n,
    circulars: db.prepare('SELECT COUNT(*) AS n FROM circulars WHERE is_sample = 1').get().n
  };
  if (dryRun) return counts;

  const files = db.prepare('SELECT file_path FROM circulars WHERE is_sample = 1').all();
  const tx = db.transaction(function () {
    db.prepare('DELETE FROM circulars WHERE is_sample = 1').run();
    db.prepare('DELETE FROM news WHERE is_sample = 1').run();
    db.prepare('DELETE FROM schools WHERE is_sample = 1').run();
  });
  tx();

  /* Remove the placeholder documents the sample circulars pointed at.
   * file_path is stored relative to the project root (e.g.
   * "/uploads/circulars/x.txt"), exactly as routes/circulars.js expects. */
  files.forEach(function (f) {
    if (!f.file_path) return;
    const abs = path.resolve(db.ROOT, String(f.file_path).replace(/^\//, ''));
    try { fs.rmSync(abs, { force: true }); } catch (err) { /* best effort */ }
  });
  return counts;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */
function lgaCounts() {
  return db.prepare(
    "SELECT l.name AS name, COUNT(s.id) AS n FROM lgas l " +
    "LEFT JOIN schools s ON s.lga = l.name AND s.status = 'active' " +
    'GROUP BY l.id ORDER BY l.sort_order'
  ).all();
}

function printLgaCounts(title) {
  console.log('\n' + title + ':');
  lgaCounts().forEach(function (r) {
    console.log('  ' + String(r.name).padEnd(16) + String(r.n).padStart(3));
  });
}

function printSummary(schoolResult, sampleResult, dryRun) {
  const tag = dryRun ? '[dry-run] ' : '';
  console.log('\n' + tag + 'Seed summary');
  console.log('-'.repeat(46));

  if (schoolResult) {
    console.log('Schools   : ' + schoolResult.inserted + ' inserted, ' +
      schoolResult.updated + ' updated, ' + schoolResult.skipped.length + ' skipped');
  }
  if (sampleResult) {
    console.log('News      : ' + sampleResult.newsInserts.length + ' inserted' +
      (sampleResult.newsSkipped.length ? ', ' + sampleResult.newsSkipped.length + ' already present' : ''));
    console.log('Circulars : ' + sampleResult.circularInserts.length + ' inserted' +
      (sampleResult.circularSkipped.length ? ', ' + sampleResult.circularSkipped.length + ' already present' : ''));
  }

  if (schoolResult && schoolResult.skipped.length) {
    console.log('\nSkipped school rows (nothing else was affected):');
    schoolResult.skipped.forEach(function (s) {
      console.log('  row ' + s.row + ': ' + s.reason);
    });
  }

  printLgaCounts(dryRun ? 'Schools per LGA (unchanged — dry run)' : 'Schools per LGA (active)');
}

function usage() {
  console.log('\nTaraba State Ministry of Education — data seeding tool\n');
  console.log('Usage:');
  console.log('  npm run seed -- --schools <file> [--dry-run]   import schools (CSV or JSON)');
  console.log('  npm run seed -- --sample                       add sample news + circulars');
  console.log('  npm run seed -- --wipe-samples [--dry-run]     delete ONLY the sample rows\n');
  console.log('Flags:');
  console.log('  --schools <file>   CSV/JSON of schools (name and lga are required)');
  console.log('  --sample           insert the sample news items and circulars');
  console.log('  --dry-run          show what would happen, write nothing');
  console.log('  --wipe-samples     remove rows tagged is_sample (never real data)');
  console.log('  --help             show this message\n');
  console.log('CSV columns: name, lga, type, address, phone, email, principal');
  console.log('             (optional: category, boarding, year_established, notes, status, is_sample)\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const opts = { schools: null, sample: false, dryRun: false, wipe: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--schools') {
      opts.schools = argv[i + 1];
      i += 1;
      if (!opts.schools || opts.schools.indexOf('--') === 0) throw new Error('--schools needs a file path.');
    } else if (a === '--sample') {
      opts.sample = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--wipe-samples') {
      opts.wipe = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error('Unknown option: ' + a);
    }
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('\n' + err.message);
    usage();
    process.exitCode = 1;
    return;
  }

  if (opts.help) { usage(); return; }

  const dbFile = db.DB_FILE;
  console.log('\nTaraba State Ministry of Education — seed tool');
  console.log('Database: ' + dbFile);
  if (opts.dryRun) console.log('Mode    : DRY RUN (no changes will be written)');

  /* Nothing to do — show usage plus the current state. */
  if (!opts.schools && !opts.sample && !opts.wipe) {
    usage();
    printLgaCounts('Schools per LGA (active, current)');
    return;
  }

  if (opts.wipe) {
    if (opts.schools || opts.sample) {
      console.log('\nNote: --wipe-samples runs on its own; --schools/--sample were ignored.');
    }
    const removed = wipeSamples(opts.dryRun);
    console.log('\n' + (opts.dryRun ? '[dry-run] ' : '') + 'Sample rows ' +
      (opts.dryRun ? 'that would be removed' : 'removed') + ':');
    console.log('  schools   : ' + removed.schools);
    console.log('  news      : ' + removed.news);
    console.log('  circulars : ' + removed.circulars);
    printLgaCounts(opts.dryRun ? 'Schools per LGA (unchanged — dry run)' : 'Schools per LGA (active)');
    return;
  }

  const lgas = lgaMap();

  try {
    /* Build the whole plan first, then apply it in one transaction. */
    let schoolResult = null;
    let schoolPlan = { inserts: [], updates: [] };

    if (opts.schools) {
      const loaded = loadSchoolFile(opts.schools);
      const report = { skipped: [] };
      schoolPlan = planSchools(loaded, lgas, report);
      schoolResult = {
        inserted: schoolPlan.inserts.length,
        updated: schoolPlan.updates.length,
        skipped: report.skipped
      };
    }

    let sampleResult = null;
    let samplePlan = null;
    if (opts.sample) {
      samplePlan = planSamples();
      sampleResult = samplePlan;
    }

    execute(schoolPlan, samplePlan, opts.dryRun);
    printSummary(schoolResult, sampleResult, opts.dryRun);

    if (!opts.dryRun) console.log('\nDone.');
    else console.log('\nDry run complete — nothing was written.');
  } catch (err) {
    console.error('\nSeed failed: ' + err.message);
    console.error('Nothing was written (the transaction was rolled back).');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

