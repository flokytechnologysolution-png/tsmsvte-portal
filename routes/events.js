/**
 * routes/events.js — ministry events (administrators and editors).
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { images, relPath } = require('../middleware/upload');
const { handleErrors, clean, toIntOrNull } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function eventFrom(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    event_date: row.event_date,
    location: row.location,
    image: row.image,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function readEvent(body) {
  const title = clean(body.title).slice(0, 200);
  const eventDate = clean(body.event_date);
  const errors = [];
  if (!title) errors.push('An event needs a title.');
  if (!eventDate) errors.push('Choose the date of the event.');
  else if (!DATE_RE.test(eventDate)) errors.push('The date must be in YYYY-MM-DD form.');
  else if (isNaN(Date.parse(eventDate))) errors.push('That date could not be understood.');

  return {
    errors: errors,
    value: {
      title: title,
      description: String(body.description === undefined ? '' : body.description).slice(0, 4000).trim(),
      event_date: eventDate,
      location: clean(body.location).slice(0, 200),
      image: clean(body.image).slice(0, 300),
      status: body.status === 'published' ? 'published' : 'draft'
    }
  };
}

/* ------------------------------- public ------------------------------- */

router.get('/', asyncHandler(async function (req, res) {
  const showPast = String(req.query.past || '') === '1';
  const canSeeAll = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  const showAll = canSeeAll && String(req.query.all || '') === '1';

  const where = [];
  const params = [];
  if (!showAll) where.push("status = 'published'");
  if (!showAll) {
    where.push(showPast ? "event_date < CURRENT_DATE" : "event_date >= CURRENT_DATE");
  }

  const q = clean(req.query.q || '').slice(0, 80);
  if (q) {
    where.push('(title LIKE ? OR description LIKE ? OR location LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }

  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = await db.query(
    'SELECT * FROM events' + whereSql + ' ORDER BY event_date ASC, id ASC LIMIT 100',
    params
  );

  res.set('Cache-Control', 'public, max-age=60');
  res.json({ events: rows.map(function (r) { return eventFrom(r); }), total: rows.length });
}));

router.get('/:id([0-9]+)', asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM events WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Event not found' });
  const canSeeDrafts = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  if (row.status !== 'published' && !canSeeDrafts) {
    return res.status(404).json({ error: 'Event not found' });
  }
  return res.json({ event: eventFrom(row) });
}));

/* -------------------------------- write ------------------------------- */

router.post('/', requireRole('EDITOR'), writeLimiter, images.single('image'),
  asyncHandler(async function (req, res) {
    const parsed = readEvent(req.body || {});
    if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
    const v = parsed.value;
    if (req.file) v.image = relPath(req.file.path);

    const info = await db.run(
      `INSERT INTO events (title, description, event_date, location, image, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [v.title, v.description, v.event_date, v.location, v.image, v.status]
    );
    await db.logAudit(req.user, 'event.create', 'event', info.lastInsertRowid,
      { title: v.title, event_date: v.event_date }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  }));

router.put('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, images.single('image'),
  asyncHandler(async function (req, res) {
    const id = toIntOrNull(req.params.id);
    const existing = id ? await db.get('SELECT * FROM events WHERE id = ?', [id]) : null;
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const parsed = readEvent(Object.assign({}, existing, req.body || {}));
    if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
    const v = parsed.value;
    if (req.file) v.image = relPath(req.file.path);

    await db.run(
      `UPDATE events SET title=?, description=?, event_date=?,
         location=?, image=?, status=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [v.title, v.description, v.event_date, v.location, v.image, v.status, id]
    );
    await db.logAudit(req.user, 'event.update', 'event', id, { title: v.title }, req);
    return res.json({ ok: true });
  }));

router.delete('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM events WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Event not found' });
  
  await db.run('DELETE FROM events WHERE id = ?', [id]);
  
  if (row.image) {
    const abs = path.resolve(__dirname, '..', row.image.replace(/^\//, ''));
    fs.rm(abs, { force: true }, function () { /* best effort */ });
  }
  
  await db.logAudit(req.user, 'event.delete', 'event', id, { title: row.title }, req);
  return res.json({ ok: true });
}));

module.exports = router;