/**
 * routes/circulars.js — public circulars, forms and downloads (PDF).
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
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

router.get('/', asyncHandler(async function (req, res) {
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

  const rows = await db.query('SELECT ' + CIRCULAR_COLUMNS + ' FROM circulars' + whereSql +
    ' ORDER BY created_at DESC, id DESC', params);
  const catRows = await db.query("SELECT DISTINCT category FROM circulars WHERE status='published' ORDER BY category");
  const categories = catRows.map(function (r) { return r.category; });
  res.json({ circulars: rows, categories: categories, total: rows.length });
}));

router.get('/:id([0-9]+)', asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT ' + CIRCULAR_COLUMNS + ' FROM circulars WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  const maySeeDrafts = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  if (row.status !== 'published' && !maySeeDrafts) {
    return res.status(404).json({ error: 'Document not found' });
  }
  return res.json({ circular: circularFrom(row) });
}));

router.post('/', requireRole('ADMIN'), writeLimiter, documents.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file) return res.status(400).json({ error: 'Attach the PDF (or a scanned image) to upload.' });
    const title = clean(req.body.title).slice(0, 200);
    if (!title) return res.status(422).json({ error: 'A title is required.' });

    const info = await db.run(
      `INSERT INTO circulars (title, description, category, file_path, file_name, file_size, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        clean(req.body.description).slice(0, 1000),
        clean(req.body.category || 'Circular').slice(0, 60) || 'Circular',
        relPath(req.file.path),
        path.basename(req.file.filename),
        req.file.size,
        req.body.status === 'draft' ? 'draft' : 'published',
        req.user.id
      ]
    );
    await db.logAudit(req.user, 'circular.create', 'circular', info.lastInsertRowid, { title: title }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  }));

router.put('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, documents.single('file'),
  asyncHandler(async function (req, res) {
    const id = toIntOrNull(req.params.id);
    const existing = id ? await db.get('SELECT * FROM circulars WHERE id = ?', [id]) : null;
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

    await db.run(
      `UPDATE circulars SET title=?, description=?, category=?,
        file_path=?, file_name=?, file_size=?, status=? WHERE id=?`,
      [patch.title, patch.description, patch.category, patch.file_path, patch.file_name, patch.file_size, patch.status, patch.id]
    );

    if (req.file && existing.file_path && existing.file_path !== patch.file_path) {
      const oldAbs = path.resolve(__dirname, '..', existing.file_path.replace(/^\//, ''));
      fs.rm(oldAbs, { force: true }, function () { /* best effort */ });
    }
    await db.logAudit(req.user, 'circular.update', 'circular', id, { title: title }, req);
    return res.json({ ok: true });
  }));

router.delete('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM circulars WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Document not found' });
  await db.run('DELETE FROM circulars WHERE id = ?', [id]);
  if (row.file_path) {
    const abs = path.resolve(__dirname, '..', row.file_path.replace(/^\//, ''));
    fs.rm(abs, { force: true }, function () { /* best effort */ });
  }
  await db.logAudit(req.user, 'circular.delete', 'circular', id, { title: row.title }, req);
  return res.json({ ok: true });
}));

module.exports = router;