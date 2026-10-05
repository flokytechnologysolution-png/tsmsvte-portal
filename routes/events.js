/**
 * routes/events.js — ministry events (administrators and editors).
 *
 * Modelled on routes/news.js: a public list that only shows published events,
 * plus a full CRUD behind requireRole('EDITOR').  An "upcoming" event is one
 * whose date has not passed; past events stay reachable with ?past=1.
 */
'use strict';

const express = require('express');
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

/* ?past=1 lists events that have already happened; ?all=1 is for staff who
 * may edit content, so they can see drafts and past entries. */
router.get('/', function (req, res) {
  const showPast = String(req.query.past || '') === '1';
  const canSeeAll = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  const showAll = canSeeAll && String(req.query.all || '') === '1';

  const where = [];
  const params = [];
  if (!showAll) where.push("status = 'published'");
  /* ?all=1 is the staff view (Admin -> Events): drafts AND past AND upcoming,
   * so the date filter is skipped entirely for them. */
  if (!showAll) {
    where.push(showPast ? "event_date < date('now')" : "event_date >= date('now')");
  }

  const q = clean(req.query.q || '').slice(0, 80);
  if (q) {
    where.push('(title LIKE ? OR description LIKE ? OR location LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }

  const rows = db.prepare(
    'SELECT * FROM events' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY event_date ASC, id ASC LIMIT 100'
  ).all(...params);

  res.set('Cache-Control', 'public, max-age=60');
  res.json({ events: rows.map(function (r) { return eventFrom(r); }), total: rows.length });
});

router.get('/:id([0-9]+)', function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM events WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Event not found' });
  const canSeeDrafts = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  if (row.status !== 'published' && !canSeeDrafts) {
    return res.status(404).json({ error: 'Event not found' });
  }
  return res.json({ event: eventFrom(row) });
});

/* -------------------------------- write ------------------------------- */

router.post('/', requireRole('EDITOR'), writeLimiter, images.single('image'),
  asyncHandler(async function (req, res) {
    const parsed = readEvent(req.body || {});
    if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
    const v = parsed.value;
    if (req.file) v.image = relPath(req.file.path);

    const info = db.prepare(
      `INSERT INTO events (title, description, event_date, location, image, status)
       VALUES (@title, @description, @event_date, @location, @image, @status)`
    ).run(v);
    db.logAudit(req.user, 'event.create', 'event', info.lastInsertRowid,
      { title: v.title, event_date: v.event_date }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  }), handleErrors);

router.put('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, images.single('image'),
  asyncHandler(async function (req, res) {
    const id = toIntOrNull(req.params.id);
    const existing = id ? db.prepare('SELECT * FROM events WHERE id = ?').get(id) : null;
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const parsed = readEvent(Object.assign({}, existing, req.body || {}));
    if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });
    const v = parsed.value;
    if (req.file) v.image = relPath(req.file.path);

    db.prepare(
      `UPDATE events SET title=@title, description=@description, event_date=@event_date,
         location=@location, image=@image, status=@status, updated_at=datetime('now')
       WHERE id=@id`
    ).run(Object.assign({}, v, { id: id }));
    db.logAudit(req.user, 'event.update', 'event', id, { title: v.title }, req);
    return res.json({ ok: true });
  }), handleErrors);

router.delete('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM events WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  if (row.image) {
    const abs = require('path').resolve(__dirname, '..', row.image.replace(/^\//, ''));
    require('fs').rm(abs, { force: true }, function () { /* best effort */ });
  }
  db.logAudit(req.user, 'event.delete', 'event', id, { title: row.title }, req);
  return res.json({ ok: true });
});

module.exports = router;