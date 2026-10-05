/**
 * routes/circulars.js — public circulars, forms and downloads (PDF).
 * Files are stored in uploads/circulars with random names.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { documents, relPath } = require('../middleware/upload');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/* Explicit columns so internal bookkeeping (is_sample) is never published. */
function circularFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    file_path: row.file_path,
    file_name: row.file_name,
    file_size: row.file_size,
    status: row.status,
    created_at: row.created_at
  };
}
const CIRCULAR_COLUMNS = 'id, title, description, category, file_path, file_name, file_size, status, created_at';

router.get('/', function (req, res) {
  const category = clean(req.query.category || '').slice(0, 60);
  const q = clean(req.query.q || '').slice(0, 80);
  const includeAll = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1
    && String(req.query.all || '') === '1';

  const where = [];
  const params = [];
  if (!includeAll) where.push("status = 'published'");
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('(title LIKE ? OR description LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare('SELECT ' + CIRCULAR_COLUMNS + ' FROM circulars' + whereSql +
    ' ORDER BY created_at DESC, id DESC').all(...params);
  const categories = db.prepare("SELECT DISTINCT category FROM circulars WHERE status='published' ORDER BY category")
    .all().map(function (r) { return r.category; });
  res.json({ circulars: rows, categories: categories, total: rows.length });
});

/* Single circular. Published ones are public; a draft is visible only to
 * staff who may already edit content. */
router.get('/:id([0-9]+)', function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT ' + CIRCULAR_COLUMNS + ' FROM circulars WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  const maySeeDrafts = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  if (row.status !== 'published' && !maySeeDrafts) {
    return res.status(404).json({ error: 'Document not found' });
  }
  return res.json({ circular: circularFrom(row) });
});

router.post('/', requireRole('ADMIN'), writeLimiter, documents.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file) return res.status(400).json({ error: 'Attach the PDF (or a scanned image) to upload.' });
    const title = clean(req.body.title).slice(0, 200);
    if (!title) return res.status(422).json({ error: 'A title is required.' });

    const info = db.prepare(
      `INSERT INTO circulars (title, description, category, file_path, file_name, file_size, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title,
      clean(req.body.description).slice(0, 1000),
      clean(req.body.category || 'Circular').slice(0, 60) || 'Circular',
      relPath(req.file.path),
      path.basename(req.file.filename),
      req.file.size,
      req.body.status === 'draft' ? 'draft' : 'published',
      req.user.id
    );
    db.logAudit(req.user, 'circular.create', 'circular', info.lastInsertRowid, { title: title }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  }), handleErrors);

router.put('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, documents.single('file'),
  asyncHandler(async function (req, res) {
    const id = toIntOrNull(req.params.id);
    const existing = id ? db.prepare('SELECT * FROM circulars WHERE id = ?').get(id) : null;
    if (!existing) return res.status(404).json({ error: 'Document not found' });

    const title = clean(req.body.title || existing.title).slice(0, 200);
    const patch = {
      id: id,
      title: title,
      description: clean(req.body.description === undefined ? existing.description : req.body.description).slice(0, 1000),
      category: clean(req.body.category || existing.category).slice(0, 60) || 'Circular',
      status: req.body.status === 'draft' ? 'draft' : (req.body.status === 'published' ? 'published' : existing.status),
      file_path: existing.file_path,
      file_name: existing.file_name,
      file_size: existing.file_size
    };
    if (req.file) {
      patch.file_path = relPath(req.file.path);
      patch.file_name = path.basename(req.file.filename);
      patch.file_size = req.file.size;
    }

    db.prepare(
      `UPDATE circulars SET title=@title, description=@description, category=@category,
        file_path=@file_path, file_name=@file_name, file_size=@file_size, status=@status WHERE id=@id`
    ).run(patch);

    if (req.file && existing.file_path && existing.file_path !== patch.file_path) {
      const oldAbs = path.resolve(__dirname, '..', existing.file_path.replace(/^\//, ''));
      fs.rm(oldAbs, { force: true }, function () { /* best effort */ });
    }
    db.logAudit(req.user, 'circular.update', 'circular', id, { title: title }, req);
    return res.json({ ok: true });
  }), handleErrors);

router.delete('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM circulars WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  db.prepare('DELETE FROM circulars WHERE id = ?').run(id);
  if (row.file_path) {
    const abs = path.resolve(__dirname, '..', row.file_path.replace(/^\//, ''));
    fs.rm(abs, { force: true }, function () { /* best effort */ });
  }
  db.logAudit(req.user, 'circular.delete', 'circular', id, { title: row.title }, req);
  return res.json({ ok: true });
});

module.exports = router;