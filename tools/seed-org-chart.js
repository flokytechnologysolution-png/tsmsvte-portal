/**
 * tools/seed-org-chart.js â€” inject the ministry's organization chart into the
 * database so the homepage section renders the real structure.
 *
 * Run:  npm run seed:org
 *
 * Only the POSITIONS (offices) are written, never people: official names stay
 * blank and portraits stay empty until an administrator verifies and adds them
 * through Admin â†’ Organization chart.  This follows the portal's rule that the
 * chart never invents a person or a photograph.
 *
 * The shape mirrors the layout the public renderer was built and tested for
 * (tools/test-org-chart.js case 15):
 *
 *   Commissioner â†’ Permanent Secretary â†’ Director of Vocational â†’ heads â†’ desks
 *   (Administration and Planning hang beside the Permanent Secretary)
 *
 * Idempotent: an entry is matched by its exact title.  Existing rows are never
 * clobbered â€” only the parent link, category, description and display order are
 * refreshed, and a name/portrait/status an administrator has set is left
 * untouched.  Runs through the universal async db helpers, so it works on
 * SQLite (local) and PostgreSQL (production, requires --allow-prod).
 *
 * Flags (after "--"):
 *   --allow-prod        required when DATABASE_URL is set (live database).
 *   --lower-layers      skip the two leadership rows (Commissioner, Permanent
 *                       Secretary) and insert ONLY the directorates, heads and
 *                       desks.  Use this on a database where the ministry has
 *                       already entered its own verified leadership through the
 *                       admin console: the three lower layers are attached
 *                       under the existing published entry whose title matches
 *                       /permanent secretary/i instead of the seed's own
 *                       "Permanent Secretary" placeholder.
 *   --anchor-id=<n>     with --lower-layers: attach to this org_chart id
 *                       instead of auto-detecting the Permanent Secretary.
 */
'use strict';

const db = require('../db');
const { clean } = require('../middleware/validate');

const FLAGS = process.argv.slice(2);
const ALLOW_PROD = FLAGS.indexOf('--allow-prod') !== -1;
const LOWER_LAYERS = FLAGS.indexOf('--lower-layers') !== -1;
const ANCHOR_FLAG = FLAGS.find(function (f) { return f.indexOf('--anchor-id=') === 0; });
const ANCHOR_ID = ANCHOR_FLAG ? Number(ANCHOR_FLAG.slice('--anchor-id='.length)) : null;
if (ANCHOR_FLAG && !Number.isInteger(ANCHOR_ID)) {
  console.error('--anchor-id must be an integer.');
  process.exit(1);
}

/* Production needs an explicit opt-in: this publishes entries straight to the
 * live chart. */
if (process.env.DATABASE_URL && !ALLOW_PROD) {
  console.error('Refusing to seed the organization chart on a production database.');
  console.error('Run again with --allow-prod if that is really intended.');
  process.exit(1);
}

/* The hierarchy, parents always before children. */
const ENTRIES = [
  {
    title: 'Honourable Commissioner',
    category: 'leadership',
    parent: null,
    order: 0,
    description: 'Heads the ministry and provides political and policy direction for secondary, vocational and technical education in Taraba State.'
  },
  {
    title: 'Permanent Secretary',
    category: 'leadership',
    parent: 'Honourable Commissioner',
    order: 0,
    description: 'Chief accounting officer of the ministry; coordinates administration and the implementation of government policy.'
  },
  {
    title: 'Director of Administration',
    category: 'directorate',
    parent: 'Permanent Secretary',
    order: 0,
    description: 'Oversees personnel, general administration and internal services of the ministry.'
  },
  {
    title: 'Director of Vocational and Technical Education',
    category: 'directorate',
    parent: 'Permanent Secretary',
    order: 1,
    description: 'Leads the supervision of technical colleges, vocational centres and skills programmes across the state.'
  },
  {
    title: 'Director of Planning, Research and Statistics',
    category: 'directorate',
    parent: 'Permanent Secretary',
    order: 2,
    description: 'Coordinates planning, data collection, research and statistical reporting for the ministry.'
  },
  {
    title: 'Head of Vocational Studies',
    category: 'unit_board',
    parent: 'Director of Vocational and Technical Education',
    order: 0,
    description: 'Coordinates vocational curricula, instructor standards and skills acquisition programmes.'
  },
  {
    title: 'Head of Skills Acquisition',
    category: 'unit_board',
    parent: 'Director of Vocational and Technical Education',
    order: 1,
    description: 'Coordinates skills acquisition initiatives and partnerships with training providers.'
  },
  {
    title: 'Trade Test and Certification Desk',
    category: 'unit_board',
    parent: 'Head of Vocational Studies',
    order: 0,
    description: 'Administers trade tests and issues skill certifications for vocational trades.'
  },
  {
    title: 'Skills Acquisition Desk',
    category: 'unit_board',
    parent: 'Head of Skills Acquisition',
    order: 0,
    description: 'Runs day-to-day skills acquisition activities and community training sessions.'
  }
];

async function main() {
  await db.ready;

  const idsByTitle = {};
  (await db.query('SELECT id, title FROM org_chart')).forEach(function (row) {
    idsByTitle[String(row.title || '').trim()] = Number(row.id);
  });

  /* --lower-layers: the ministry already entered its own verified leadership
   * (SGS, Commissioner, Permanent Secretary) through the admin console.  Do
   * not insert the seed's placeholder leadership; attach the lower layers
   * under the existing Permanent Secretary instead. */
  if (LOWER_LAYERS) {
    let anchor = null;
    if (ANCHOR_ID !== null) {
      anchor = await db.get('SELECT id, title FROM org_chart WHERE id = ?', [ANCHOR_ID]);
      if (!anchor) throw new Error('No org_chart entry with id ' + ANCHOR_ID + '.');
    } else {
      const rows = await db.query(
        "SELECT id, title FROM org_chart WHERE status = 'published' AND category = 'leadership' ORDER BY id"
      );
      const matches = rows.filter(function (r) {
        return /permanent\s+secretary/i.test(String(r.title || ''));
      });
      if (matches.length > 1) {
        throw new Error(
          'Several entries look like the Permanent Secretary (' +
          matches.map(function (m) { return '#' + m.id + ' ' + m.title; }).join('; ') +
          '). Re-run with --anchor-id=<n> to pick one.'
        );
      }
      anchor = matches[0] || null;
      if (!anchor) {
        throw new Error(
          'No published "Permanent Secretary" entry found to attach to. ' +
          'Enter it through the admin console first, or re-run with --anchor-id=<n>.'
        );
      }
    }
    idsByTitle['Permanent Secretary'] = Number(anchor.id);
    console.log('Lower layers will hang under existing entry #' + anchor.id + ': ' + anchor.title);
  }

  const report = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const entry of ENTRIES) {
    if (LOWER_LAYERS && entry.category === 'leadership') {
      report.skipped += 1;
      console.log('  skipped  ' + entry.title + ' (already entered by the ministry)');
      continue;
    }
    const title = clean(entry.title).slice(0, 160);
    const parentId = entry.parent ? idsByTitle[entry.parent] : null;
    if (entry.parent && !parentId) {
      throw new Error('Parent not found for "' + title + '": ' + entry.parent);
    }

    const existing = await db.get('SELECT * FROM org_chart WHERE id = ?', [idsByTitle[title]]);
    if (existing) {
      /* Refresh structure only; name, portrait and status stay as the
       * administrator left them. */
      const changed =
        Number(existing.parent_id || 0) !== Number(parentId || 0) ||
        existing.category !== entry.category ||
        Number(existing.sort_order) !== Number(entry.order) ||
        String(existing.description || '') !== entry.description;
      if (changed) {
        await db.run(
          `UPDATE org_chart SET parent_id = ?, category = ?, description = ?, sort_order = ?,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [parentId, entry.category, entry.description, entry.order, existing.id]
        );
        report.updated += 1;
        console.log('  updated  ' + title);
      } else {
        report.unchanged += 1;
      }
      idsByTitle[title] = Number(existing.id);
      continue;
    }

    const info = await db.run(
      `INSERT INTO org_chart (parent_id, title, name, category, description, portrait, sort_order, status, created_by)
       VALUES (?, ?, '', ?, ?, '', ?, 'published', NULL)`,
      [parentId, title, entry.category, entry.description, entry.order]
    );
    idsByTitle[title] = info.lastInsertRowid;
    report.inserted += 1;
    await db.logAudit(null, 'org_chart.seed', 'org_chart', info.lastInsertRowid,
      { title: title, status: 'published' }, null);
    console.log('  inserted ' + title);
  }

  console.log('\nOrganization chart: ' + report.inserted + ' inserted, ' +
    report.updated + ' updated, ' + report.unchanged + ' unchanged' +
    (report.skipped ? ', ' + report.skipped + ' skipped' : '') + '.');
  console.log('Published entries now appear on the homepage immediately. Add verified');
  console.log('names and portraits through Admin \u2192 Organization chart.');
  await db.close();
}

main().catch(async function (err) {
  console.error('\nFAILED: ' + ((err && err.stack) || err));
  try { await db.close(); } catch (e) { /* ignore */ }
  process.exitCode = 1;
});

