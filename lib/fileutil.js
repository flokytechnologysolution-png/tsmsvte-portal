/**
 * lib/fileutil.js — the rules for "does anything still use this file?" and the
 * one-off import of legacy /uploads files into the permanent `files` table.
 *
 * Files uploaded through the console live in the `files` table and are served
 * from /files/<id> (see routes/files.js).  A setting, news item, event,
 * circular or avatar points at one by storing the exact string "/files/<id>".
 * Before any old reference is replaced or cleared we must be certain nothing
 * else still needs the blob, so deleteFile() checks every place a file id can
 * appear and only removes the row when it is genuinely orphaned.
 *
 * Everything here runs through the universal async db API, so it behaves the
 * same on SQLite (local tests) and PostgreSQL (Render).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');

/* The 24-hex id that /files/<id> uses — matches crypto.randomBytes(12). */
const FILE_ID_RE = /^[a-f0-9]{24}$/;

/**
 * Return the 24-hex file id a value points at, or null.
 * Accepts "/files/<id>", a bare "<id>", or an absolute URL ending in either
 * (so a pasted https://host/files/<id> still resolves). Static values such as
 * "/img/photos/governor.svg" are deliberately ignored and return null.
 */
function fileIdFromUrl(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/(?:^|\/)files\/([a-f0-9]{24})(?:\?.*)?$/i);
  if (m) return m[1].toLowerCase();
  if (FILE_ID_RE.test(s)) return s.toLowerCase();
  return null;
}

/* Every column that can hold a "/files/<id>" (or bare id) reference. We count
 * a reference either by the full "/files/<id>" URL or by the bare id, so an
 * imported legacy row is never deleted while something still points at it. */
const REFERENCE_COLUMNS = [
  { table: 'settings', column: 'value' },
  { table: 'news', column: 'cover_image' },
  { table: 'events', column: 'image' },
  { table: 'circulars', column: 'file_path' },
  { table: 'users', column: 'avatar' }
];

/**
 * Is a file id referenced anywhere other than an optional excluded row?
 * @param {string} id 24-hex id
 * @param {{table:string,column:string,value:string}} [exclude] a reference to
 *        ignore — used when we are about to overwrite exactly this cell.
 * @returns {Promise<boolean>}
 */
async function isReferenced(id, exclude) {
  if (!id || !FILE_ID_RE.test(id)) return true; /* be safe: treat unknown as used */
  const needle = '/files/' + id;
  for (let i = 0; i < REFERENCE_COLUMNS.length; i++) {
    const ref = REFERENCE_COLUMNS[i];
    let sql;
    let params;
    if (exclude && exclude.table === ref.table && exclude.column === ref.column) {
      sql = 'SELECT COUNT(*) AS n FROM ' + ref.table + ' WHERE ' + ref.column +
        ' IN (?, ?) AND ' + ref.column + ' <> ?';
      params = [needle, id, exclude.value];
    } else {
      sql = 'SELECT COUNT(*) AS n FROM ' + ref.table + ' WHERE ' + ref.column +
        ' IN (?, ?)';
      params = [needle, id];
    }
    const row = await db.get(sql, params);
    if (row && Number(row.n) > 0) return true;
  }
  return false;
}

/**
 * Delete a files row only when nothing references it any more.
 * Safe to call with a non-"/files/..." value (returns {deleted:false}).
 * @returns {Promise<{deleted:boolean, id:(string|null), existed:boolean}>}
 */
async function deleteFile(value) {
  const id = fileIdFromUrl(value);
  if (!id) return { deleted: false, id: null, existed: false };

  const existing = await db.get('SELECT id FROM files WHERE id = ?', [id]);
  if (!existing) return { deleted: false, id: id, existed: false };

  const stillUsed = await isReferenced(id);
  if (stillUsed) return { deleted: false, id: id, existed: true };

  await db.run('DELETE FROM files WHERE id = ?', [id]);
  return { deleted: true, id: id, existed: true };
}

function guessMime(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/jpeg';
}

/**
 * One-off, idempotent import of files that already exist on local disk under
 * uploads/.  For each image found we insert it into the `files` table (keyed by
 * a stable content hash so a second run recognises the same bytes and inserts
 * nothing) and rewrite any settings reference from "/uploads/..." to
 * "/files/<id>".  A file that is missing on disk is left alone and listed.
 *
 * @returns {Promise<{imported:number, rewritten:number, missing:string[], skipped:number}>}
 */
async function importUploads() {
  const report = { imported: 0, rewritten: 0, missing: [], skipped: 0 };

  /* Every distinct "/uploads/..." value currently stored in settings. */
  const rows = await db.query(
    "SELECT key, value FROM settings WHERE value LIKE '/uploads/%' OR value LIKE 'uploads/%'"
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const raw = String(row.value || '').trim();
    const rel = raw.replace(/^\/?uploads\//, '').replace(/^\/+/, '');
    const abs = path.join(db.UPLOAD_DIR, rel);

    if (!fs.existsSync(abs)) {
      report.missing.push(row.key + ' -> ' + raw);
      report.skipped += 1;
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      report.missing.push(row.key + ' -> ' + raw + ' (unreadable)');
      report.skipped += 1;
      continue;
    }

    /* Idempotency: identical bytes always map to the same id, so re-running the
     * migration finds the row already present and imports nothing new. */
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);

    const already = await db.get('SELECT id FROM files WHERE id = ?', [id]);
    if (!already) {
      const detected = require('./filetype').detectFileType(buf);
      const mime = (detected && detected.mime) || guessMime(rel);
      await db.run(
        'INSERT INTO files (id, original_name, mime, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [id, path.basename(rel), mime, buf.length, buf, null]
      );
      report.imported += 1;
    }

    const newUrl = '/files/' + id;
    if (newUrl !== raw) {
      await db.run('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
        [newUrl, row.key]);
      report.rewritten += 1;
    }
  }

  return report;
}

module.exports = {
  FILE_ID_RE: FILE_ID_RE,
  fileIdFromUrl: fileIdFromUrl,
  isReferenced: isReferenced,
  deleteFile: deleteFile,
  importUploads: importUploads
};

