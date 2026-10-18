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
 */
'use strict';

const db = require('../db');
const { clean } = require('../middleware/validate');

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

/* Production needs an explicit opt-in: this publishes entries straight to the
 * live chart. */
const ALLOW_PROD = process.argv.indexOf('--allow-prod') !== -1;
if (process.env.DATABASE_URL && !ALLOW_PROD) {
  console.error('Refusing to seed the organization chart on a production database.');
  console.error('Run again with --allow-prod if that is really intended.');
  process.exit(1);
}

async function main() {
  await db.ready;

  const idsByTitle = {};
  (await db.query('SELECT id, title FROM org_chart')).forEach(function (row) {
    idsByTitle[String(row.title || '').trim()] = Number(row.id);
  });

  const report = { inserted: 0, updated: 0, unchanged: 0 };

  for (const entry of ENTRIES) {
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
    report.updated + ' updated, ' + report.unchanged + ' unchanged.');
  console.log('Published entries now appear on the homepage immediately. Add verified');
  console.log('names and portraits through Admin \u2192 Organization chart.');
  await db.close();
}

main().catch(async function (err) {
  console.error('\nFAILED: ' + ((err && err.stack) || err));
  try { await db.close(); } catch (e) { /* ignore */ }
  process.exitCode = 1;
});

