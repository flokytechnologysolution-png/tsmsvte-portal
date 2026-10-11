/**
 * scripts/migrate-uploads.js — one-off, idempotent import of legacy /uploads
 * images into the permanent `files` table, rewriting settings references.
 *
 * Background: the Admin -> Site settings screen used to store brand images by
 * path under uploads/ and serve them from /uploads/<file>. Those blobs are now
 * held in the `files` table and served from /files/<id>. This tool moves any
 * settings value that still points at /uploads/... across to /files/<id>:
 *
 *   • It only touches settings values that begin with "/uploads/" (or
 *     "uploads/"). Existing static values such as /img/photos/governor.svg are
 *     left completely untouched and keep working.
 *   • A file that is missing on disk is left alone and listed, never guessed.
 *   • It is idempotent: each file is keyed by a hash of its bytes, so the
 *     second run recognises the row it already created and changes 0 rows.
 *
 * Run it (safe to run repeatedly):
 *   node scripts/migrate-uploads.js
 *   node scripts/migrate-uploads.js --dry-run   show the plan, write nothing
 *
 * It uses whatever database DB_FILE points at; point it at a copy for a test.
 */
'use strict';

const db = require('../db');
const fileutil = require('../lib/fileutil');

async function countFiles() {
  const row = await db.get('SELECT COUNT(*) AS n FROM files');
  return Number(row ? row.n : 0);
}

async function countUploadRefs() {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM settings WHERE value LIKE '/uploads/%' OR value LIKE 'uploads/%'"
  );
  return Number(row ? row.n : 0);
}

async function main() {
  const dryRun = process.argv.slice(2).indexOf('--dry-run') !== -1;
  await db.ready;

  console.log('\nImport legacy uploads into the files table');
  console.log('Database : ' + db.DB_FILE);
  console.log('Uploads  : ' + db.UPLOAD_DIR);
  console.log('Mode     : ' + (dryRun ? 'DRY RUN (no changes will be written)' : 'LIVE'));

  const filesBefore = await countFiles();
  const refsBefore = await countUploadRefs();
  console.log('\nBefore');
  console.log('  files rows            : ' + filesBefore);
  console.log('  settings /uploads refs: ' + refsBefore);

  if (dryRun) {
    /* Show what would happen without importing anything. */
    const rows = await db.query(
      "SELECT key, value FROM settings WHERE value LIKE '/uploads/%' OR value LIKE 'uploads/%' ORDER BY key"
    );
    const fsx = require('fs');
    const path = require('path');
    console.log('\nPlan');
    rows.forEach(function (r) {
      const raw = String(r.value).trim();
      const rel = raw.replace(/^\/?uploads\//, '').replace(/^\/+/, '');
      const abs = path.join(db.UPLOAD_DIR, rel);
      console.log('  ' + r.key + ': ' + raw + (fsx.existsSync(abs) ? '  -> would import' : '  -> MISSING (left alone)'));
    });
    console.log('\nDry run complete — nothing was written.');
    return;
  }

  const report = await fileutil.importUploads();

  const filesAfter = await countFiles();
  const refsAfter = await countUploadRefs();

  console.log('\nImported  : ' + report.imported + ' new file(s) into the files table');
  console.log('Rewritten : ' + report.rewritten + ' settings value(s) now point at /files/<id>');
  console.log('Skipped   : ' + report.skipped + ' (file missing on disk, left alone)');
  if (report.missing.length) {
    console.log('\nMissing files (left as-is, listed here):');
    report.missing.forEach(function (m) { console.log('  • ' + m); });
  }

  console.log('\nAfter');
  console.log('  files rows            : ' + filesAfter + ' (+' + (filesAfter - filesBefore) + ')');
  console.log('  settings /uploads refs: ' + refsAfter + ' (-' + (refsBefore - refsAfter) + ')');
  console.log('\nDone. Running this again is safe and will change 0 rows.\n');
}

if (require.main === module) {
  main().then(function () { db.close(); process.exit(0); })
    .catch(function (err) {
      console.error('\nMigration failed: ' + (err && err.message ? err.message : err));
      process.exitCode = 1;
      try { db.close(); } catch (e) { /* ignore */ }
      process.exit(1);
    });
}

module.exports = { main: main };
