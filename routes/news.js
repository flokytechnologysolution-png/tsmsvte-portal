/**
 * routes/news.js — ministry news: list, detail, categories and admin CRUD.
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireRole, isAdminish } = require('../middleware/auth');
const { images, relPath } = require('../middleware/upload');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

function postFrom(row, withBody) {
  const out = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    category: row.category,
    cover_image: row.cover_image,
    status: row.status,
    author_id: row.author_id,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (withBody) out.body = row.body;
  return out;
}

async function uniqueSlug(title, ignoreId) {
  const base = db.slugify(title) || 'news';
  let slug = base;
  let n = 1;
  for (;;) {
    const row = await db.get('SELECT id FROM news WHERE slug = ?', [slug]);
    if (!row || (ignoreId && row.id === ignoreId)) return slug;
    n += 1;
    slug = base + '-' + n;
  }
}

router.get('/categories', asyncHandler(async function (req, res) {
  const rows = await db.query(
    "SELECT category, COUNT(*) AS n FROM news WHERE status = 'published' GROUP BY category ORDER BY n DESC"
  );
  res.json({ categories: rows.map(function (r) { return r.category; }) });
}));

router.get('/', asyncHandler(async function (req, res) {
  const viewer = req.user;
  const showAll = isAdminish(viewer) || (viewer && viewer.role === 'EDITOR');
  const status = clean(req.query.status || '');
  const category = clean(req.query.category || '').slice(0, 60);
  const q = clean(req.query.q || '').slice(0, 80);
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10) || 10));

  const where = [];
  const params = [];
  if (showAll && (status === 'draft' || status === 'published')) {
    where.push('status = ?'); params.push(status);
  } else if (!showAll) {
    where.push("status = 'published'");
  }
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('(title LIKE ? OR summary LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const totalRow = await db.get('SELECT COUNT(*) AS n FROM news' + whereSql, params);
  const total = totalRow ? totalRow.n : 0;
  
  const rows = await db.query(
    'SELECT * FROM news' + whereSql +
    ' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ? OFFSET ?',
    [...params, limit, (page - 1) * limit]
  );

  res.json({
    news: rows.map(function (r) { return postFrom(r, false); }),
    total: total,
    page: page,
    pages: Math.max(1, Math.ceil(total / limit))
  });
}));

router.get('/:idOrSlug', asyncHandler(async function (req, res) {
  const key = String(req.params.idOrSlug).slice(0, 200);
  const id = toIntOrNull(key);
  const row = id
    ? await db.get('SELECT * FROM news WHERE id = ?', [id])
    : await db.get('SELECT * FROM news WHERE slug = ?', [key]);
  if (!row) return res.status(404).json({ error: 'News item not found' });

  const viewer = req.user;
  const canSeeDrafts = isAdminish(viewer) || (viewer && viewer.role === 'EDITOR');
  if (row.status !== 'published' && !canSeeDrafts) {
    return res.status(404).json({ error: 'News item not found' });
  }
  return res.json({ article: postFrom(row, true) });
}));

/* ------------------------------- write -------------------------------- */

function readPost(body) {
  const title = clean(body.title).slice(0, 200);
  const summary = clean(body.summary).slice(0, 400);
  const bodyText = String(body.body === undefined ? '' : body.body)
    .replace(/\r\n/g, '\n').slice(0, 40000).trim();
  const category = clean(body.category || 'General').slice(0, 60) || 'General';
  const status = body.status === 'published' ? 'published' : 'draft';
  const errors = [];
  if (!title) errors.push('A headline is required.');
  if (!bodyText) errors.push('The article body cannot be empty.');
  return {
    errors: errors,
    value: {
      title: title,
      summary: summary,
      body: bodyText,
      category: category,
      status: status,
      cover_image: clean(body.cover_image).slice(0, 300)
    }
  };
}

router.post('/', requireRole('EDITOR'), writeLimiter, images.single('cover'),
  asyncHandler(async function (req, res) {
    const parsed = readPost(req.body || {});
    if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
    const v = parsed.value;
    if (req.file) v.cover_image = relPath(req.file.path);

    const slug = await uniqueSlug(v.title, null);
    const publishedAt = v.status === 'published' ? new Date().toISOString() : null;

    const info = await db.run(
      `INSERT INTO news (title, slug, summary, body, category, cover_image, status, author_id, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.title, slug, v.summary, v.body, v.category, v.cover_image, v.status, req.user.id, publishedAt]
    );

    await db.logAudit(req.user, 'news.create', 'news', info.lastInsertRowid, { title: v.title, status: v.status }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  }));

router.put('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, images.single('cover'),
  asyncHandler(async function (req, res) {
    const id = toIntOrNull(req.params.id);
    const existing = id ? await db.get('SELECT * FROM news WHERE id = ?', [id]) : null;
    if (!existing) return res.status(404).json({ error: 'News item not found' });

    const parsed = readPost(Object.assign({}, existing, req.body || {}));
    if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
    const v = parsed.value;
    if (req.file) v.cover_image = relPath(req.file.path);

    const slug = await uniqueSlug(v.title, id);
    
    // Handle published_at logic:
    // - If publishing for the first time (status=published AND was null), set to now
    // - If reverting to draft, set to null
    // - Otherwise keep existing value
    let publishedAt = existing.published_at;
    if (v.status === 'published' && !existing.published_at) {
      publishedAt = new Date().toISOString();
    } else if (v.status === 'draft') {
      publishedAt = null;
    }

    await db.run(
      `UPDATE news SET title=?, slug=?, summary=?, body=?, category=?,
        cover_image=?, status=?, updated_at=CURRENT_TIMESTAMP, published_at=?
       WHERE id=?`,
      [v.title, slug, v.summary, v.body, v.category, v.cover_image, v.status, publishedAt, id]
    );

    await db.logAudit(req.user, 'news.update', 'news', id, { title: v.title, status: v.status }, req);
    return res.json({ ok: true });
  }));

router.delete('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM news WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'News item not found' });
  await db.run('DELETE FROM news WHERE id = ?', [id]);
  await db.logAudit(req.user, 'news.delete', 'news', id, { title: row.title }, req);
  return res.json({ ok: true });
}));

module.exports = router;