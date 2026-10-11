/**
 * routes/files.js — permanent file storage IN the database.
 *
 * On Render's free plan there is no persistent disk: anything written to
 * /uploads is lost on every redeploy/restart.  These two endpoints keep an
 * uploaded image/document forever by storing its bytes in the `files` table:
 *
 *   POST /api/files   authenticated editor+ upload; magic-byte validated;
 *                     returns {id, url:'/files/<id>', mime, size}.
 *   GET  /files/:id   public; serves the exact bytes with nosniff, a strong
 *                     ETag and `immutable` caching (a replacement gets a new
 *                     id, so a given id's content never changes).
 *
 * SQL runs through the shared async db helpers (works on SQLite + PostgreSQL)
 * and the `files` table has a TEXT `id`, so db.run's RETURNING-id handling is
 * satisfied. Binary is a BLOB on SQLite and BYTEA on PostgreSQL; both drivers
 * hand back a Buffer, which serve() normalises defensively anyway.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const { uploadLimiter } = require('../middleware/rateLimit');
const { detectFileType, sanitizeFilename } = require('../lib/filetype');

const router = express.Router();

const MAX_IMAGE = 3 * 1024 * 1024;          /* 3 MB  */
const MAX_DOC = 10 * 1024 * 1024;           /* 10 MB */
const MULTER_LIMIT = MAX_DOC + 64 * 1024;   /* headroom so a 10 MB doc still reaches our 413 check */
const MIN_BYTES = 64;                       /* reject empty / trivially tiny uploads */
const ID_RE = /^[a-f0-9]{24}$/;

/* Multer holds the whole file in memory; we validate by magic bytes afterwards
 * and hand the Buffer straight to the DB. One file, field name "file". */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_LIMIT, files: 1, fields: 8 }
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;   /* shown verbatim by the error handler */
  return err;
}

/* ----------------------------- POST /api/files ---------------------------- */
router.post('/', requireAuth, requireRole('EDITOR'), uploadLimiter, upload.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file || !req.file.buffer) {
      throw httpError(400, 'No file was uploaded.');
    }
    const buf = req.file.buffer;
    if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) {
      throw httpError(400, 'That file is empty or too small to be valid.');
    }

    const detected = detectFileType(buf);
    if (!detected) {
      throw httpError(415, 'Unsupported file type. Allowed: JPEG, PNG or WebP images, and PDF, DOCX or XLSX documents.');
    }

    const limit = detected.kind === 'image' ? MAX_IMAGE : MAX_DOC;
    if (buf.length > limit) {
      throw httpError(413, detected.kind === 'image'
        ? 'Images must be 3 MB or smaller.'
        : 'Documents must be 10 MB or smaller.');
    }

    /* 24 random hex chars, generated server-side. Never derived from the client. */
    const id = crypto.randomBytes(12).toString('hex');
    const originalName = sanitizeFilename(req.file.originalname || detected.ext);

    await db.run(
      'INSERT INTO files (id, original_name, mime, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, originalName, detected.mime, buf.length, buf, (req.user && req.user.id) || null]
    );
    await db.logAudit(req.user, 'file.upload', 'files', id,
      { name: originalName, mime: detected.mime, size: buf.length }, req);

    res.status(201).json({ id: id, url: '/files/' + id, mime: detected.mime, size: buf.length });
  })
);

/* ----------------------------- GET /files/:id ----------------------------- */
/* Public, cacheable, immutable. Documents download; images render inline. */
async function serve(req, res, next) {
  try {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await db.get('SELECT id, original_name, mime, size, data FROM files WHERE id = ?', [id]);
    if (!row || !row.data) return res.status(404).json({ error: 'Not found' });

    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    const mime = row.mime || 'application/octet-stream';
    const etag = '"f' + id + '-' + data.length + '"';

    res.set('Content-Type', mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    if (mime.indexOf('image/') !== 0) {
      /* Force a download with a safe filename derived from the stored type. */
      const safe = sanitizeFilename(row.original_name || ('file' + (detectedExt(mime))));
      res.set('Content-Disposition', 'attachment; filename="' + safe + '"');
    }

    if (req.get('If-None-Match') === etag) return res.status(304).end();
    return res.status(200).send(data);
  } catch (err) {
    return next(err);
  }
}

function detectedExt(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (/wordprocessingml/.test(mime)) return '.docx';
  if (/spreadsheetml/.test(mime)) return '.xlsx';
  return '';
}

module.exports = router;
module.exports.serve = serve;
