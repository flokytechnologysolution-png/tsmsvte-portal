/* scripts/_countdb.js — print the two counts the Phase 2 report needs, for the
 * DB named by DB_FILE (defaults to the real data/portal.db). Read-only: it only
 * SELECTs, never writes. Used to show before/after counts on the real DB. */
'use strict';

if (!process.env.DB_FILE) process.env.DB_FILE = './data/portal.db';

const db = require('../db');

db.ready.then(async function () {
  const files = await db.get('SELECT COUNT(*) AS n FROM files');
  const uploads = await db.get(
    "SELECT COUNT(*) AS n FROM settings WHERE value LIKE '/uploads/%' OR value LIKE 'uploads/%'"
  );
  const filesRef = await db.get(
    "SELECT COUNT(*) AS n FROM settings WHERE value LIKE '/files/%'"
  );
  console.log('DB_FILE=' + process.env.DB_FILE);
  console.log('  files rows                 = ' + files.n);
  console.log('  settings -> /uploads/...   = ' + uploads.n);
  console.log('  settings -> /files/<id>    = ' + filesRef.n);
  process.exit(0);
}).catch(function (e) {
  console.error('[countdb] ERROR', e && e.message ? e.message : e);
  process.exit(1);
});
