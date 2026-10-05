/**
 * tools/backup.js — consistent, dependency-free backups of portal.db + uploads.
 *
 *   npm run backup              make a backup now
 *   npm run backup -- --keep 30 keep 30 instead of the default 14
 *   npm run backup -- --list    show existing backups
 *
 * The database copy uses SQLite's own VACUUM INTO, so the result is a
 * consistent snapshot even while the portal is serving requests (a plain file
 * copy of a live WAL database can capture a torn file).
 *
 * Layout:  <project>/backups/backup-YYYYMMDD-HHMMSS/
 *            portal.db
 *            uploads/...
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.resolve(ROOT, process.env.DB_FILE || './data/portal.db');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads');
const BACKUP_DIR = path.join(ROOT, 'backups');
const DEFAULT_KEEP = 14;

function stamp(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(function (n) { return /^backup-\d{8}-\d{6}$/.test(n); })
    .sort()
    .reverse();
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return 0;
  let files = 0;
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach(function (entry) {
    /* Skip the placeholders and any editor droppings. */
    if (entry.name === '.gitkeep' || entry.name.startsWith('.')) return;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) { files += copyTree(src, dest); return; }
    fs.copyFileSync(src, dest);
    files += 1;
  });
  return files;
}

function dirSize(dir) {
  let total = 0;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  });
  return total;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function backup() {
  if (!fs.existsSync(DB_FILE)) {
    console.error('[backup] No database found at ' + DB_FILE);
    process.exitCode = 1;
    return;
  }
  const name = 'backup-' + stamp(new Date());
  const dest = path.join(BACKUP_DIR, name);
  if (fs.existsSync(dest)) {
    console.error('[backup] "' + name + '" already exists — wait a minute and try again.');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(dest, { recursive: true });

  /* VACUUM INTO writes a fully consistent copy without stopping the portal. */
  const src = new Database(DB_FILE, { readonly: true });
  try {
    src.exec("VACUUM INTO '" + path.join(dest, 'portal.db').replace(/'/g, "''") + "'");
  } finally {
    src.close();
  }
  const files = copyTree(UPLOAD_DIR, path.join(dest, 'uploads'));

  console.log('\n[backup] written: ' + path.relative(ROOT, dest));
  console.log('  database : ' + fmtBytes(fs.statSync(path.join(dest, 'portal.db')).size) +
    '  (consistent snapshot via VACUUM INTO)');
  console.log('  uploads  : ' + files + ' files, ' + fmtBytes(dirSize(path.join(dest, 'uploads'))));
  console.log('  total    : ' + fmtBytes(dirSize(dest)));
  prune();
}

function prune(keep) {
  const n = Number(keep) || DEFAULT_KEEP;
  const all = listBackups();
  const extra = all.slice(n);
  if (!extra.length) {
    console.log('  keeping  : ' + all.length + ' backups (limit ' + n + ')');
    return;
  }
  extra.forEach(function (old) {
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  });
  console.log('  pruned   : removed ' + extra.length + ' old backup(s), keeping the newest ' + n);
}

/* ------------------------------------------------------------------ cli */
const args = process.argv.slice(2);
if (args.indexOf('--list') !== -1) {
  const all = listBackups();
  console.log('\nBackups in ' + BACKUP_DIR + ':\n');
  if (!all.length) { console.log('  (none yet — run: npm run backup)\n'); }
  all.forEach(function (n) {
    const p = path.join(BACKUP_DIR, n);
    console.log('  ' + n + '   ' + fmtBytes(dirSize(p)));
  });
  console.log('');
  process.exit(0);
}

const keepIndex = args.indexOf('--keep');
const keep = keepIndex !== -1 ? args[keepIndex + 1] : null;

console.log('\nTSMSVTE portal — backup');
console.log('Source   : ' + DB_FILE);
console.log('Uploads  : ' + UPLOAD_DIR);
console.log('Destination: ' + BACKUP_DIR);
try {
  backup();
  console.log('\nRestore with: copy <backup>/portal.db over ' + DB_FILE +
    ' and <backup>/uploads over ' + UPLOAD_DIR + ', then restart.\n');
} catch (err) {
  console.error('\n[backup] FAILED: ' + err.message);
  process.exitCode = 1;
}
