/**
 * routes/org-chart.js — the configurable ministry organization chart.
 *
 *   GET    /api/org-chart            public: published entries only
 *   GET    /api/org-chart/admin      OWNER/ADMIN: every entry, drafts included
 *   POST   /api/org-chart            OWNER/ADMIN: create (draft by default)
 *   PUT    /api/org-chart/:id        OWNER/ADMIN: update
 *   DELETE /api/org-chart/:id        OWNER/ADMIN: delete (children move up one level)
 *
 * Nothing is invented here.  A new entry is created as "draft" and only
 * appears on the public site once an administrator publishes it, and a
 * portrait must be an image already uploaded through the console into the
 * `files` table ("/files/<id>") — outside image links are refused, so a
 * hostile URL can never reach a visitor's browser.
 *
 * Parent links are validated for existence, self-parenting and circular
 * hierarchies; deleting a parent re-parents its children onto the deleted
 * entry's own parent (or the top level) so nothing is orphaned.
 *
 * All SQL runs through the universal async db helpers, so the same statements
 * behave identically on SQLite (local development) and PostgreSQL (production).
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { clean } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');
const fileutil = require('../lib/fileutil');

const router = express.Router();

const CATEGORIES = [
  { value: 'leadership', label: 'Leadership' },
  { value: 'directorate', label: 'Directorate' },
  { value: 'unit_board', label: 'Unit & Board' }
];
const CATEGORY_VALUES = CATEGORIES.map(function (c) { return c.value; });
const STATUS_VALUES = ['published', 'draft'];

/* Portraits live in the `files` table and are served from /files/<id>
 * (24 hex chars, generated server-side by crypto.randomBytes(12)).  Anything
 * else — an https:// link, /uploads/..., a data: URI — is refused. */
const FILE_URL_RE = /^\/files\/[a-f0-9]{24}$/;

const MAX_TITLE = 160;
const MAX_NAME = 160;
const MAX_DESCRIPTION = 2000;
const MIN_ORDER = -9999;
const MAX_ORDER = 9999;

const PUBLIC_COLUMNS = 'id, parent_id, title, name, category, description, portrait, sort_order';

/** Parse an optional parent id.  null means "top level"; anything that is not
 *  a positive integer is an error (never silently coerced). */
function parseParentId(raw) {
  if (raw === null || raw === undefined) return { value: null };
  const s = String(raw).trim();
  if (s === '' || s === 'null' || s === 'none') return { value: null };
  if (!/^\d+$/.test(s) || parseInt(s, 10) < 1) {
    return { error: 'The selected parent entry is invalid.' };
  }
  return { value: parseInt(s, 10) };
}

/** @returns {Promise<string|null>} an error message, or null when the parent
 *  link is usable.  Rejects missing parents, self-parenting and loops. */
async function checkParent(parentId, selfId) {
  if (parentId === null) return null;
  if (selfId && parentId === selfId) {
    return 'An entry cannot report to itself.';
  }
  const parent = await db.get('SELECT id FROM org_chart WHERE id = ?', [parentId]);
  if (!parent) return 'The selected parent entry does not exist.';

  /* Walk upwards from the candidate parent.  Meeting our own id would close a
   * loop (self is an ancestor of the candidate parent), so refuse it; the
   * `seen` guard also catches a pre-existing loop and keeps the walk finite. */
  const seen = {};
  let cursor = parentId;
  while (cursor) {
    if (selfId && cursor === selfId) {
      return 'That parent would create a circular hierarchy.';
    }
    if (seen[cursor]) return 'That parent already belongs to a circular hierarchy.';
    seen[cursor] = true;
    const row = await db.get('SELECT parent_id FROM org_chart WHERE id = ?', [cursor]);
    cursor = (row && row.parent_id !== null && row.parent_id !== undefined)
      ? Number(row.parent_id) : null;
  }
  return null;
}

/** Validate a full entry body.  `existing` (an UPDATE) supplies defaults for
 *  any field the client omits, exactly like routes/faq.js does. */
async function readEntry(body, existing) {
  const errors = [];
  const base = existing || {};

  const title = clean(body.title === undefined ? base.title : body.title).slice(0, MAX_TITLE);
  if (!title) errors.push('The position / title is required.');

  const name = clean(body.name === undefined ? base.name : body.name).slice(0, MAX_NAME);

  const category = clean(body.category === undefined ? base.category : body.category) || 'leadership';
  if (CATEGORY_VALUES.indexOf(category) === -1) {
    errors.push('Category must be Leadership, Directorate or Unit & Board.');
  }

  const description = String(body.description === undefined
    ? (base.description || '') : body.description)
    .replace(/\r\n/g, '\n').slice(0, MAX_DESCRIPTION).trim();

  const orderRaw = clean(body.sort_order === undefined ? base.sort_order : body.sort_order);
  let sortOrder = null;
  if (orderRaw === '') {
    sortOrder = 0;
  } else if (/^-?\d+$/.test(orderRaw)) {
    sortOrder = parseInt(orderRaw, 10);
    if (sortOrder < MIN_ORDER || sortOrder > MAX_ORDER) {
      errors.push('Display order must be between ' + MIN_ORDER + ' and ' + MAX_ORDER + '.');
      sortOrder = null;
    }
  } else {
    errors.push('Display order must be a whole number.');
  }

  const status = clean(body.status === undefined ? base.status : body.status) || 'draft';
  if (STATUS_VALUES.indexOf(status) === -1) {
    errors.push('Status must be published or draft.');
  }

  const parentParsed = parseParentId(body.parent_id === undefined ? base.parent_id : body.parent_id);
  if (parentParsed.error) errors.push(parentParsed.error);

  /* A portrait must already sit in the `files` table; nothing external. */
  const portraitRaw = clean(body.portrait === undefined ? base.portrait : body.portrait).slice(0, 300);
  let portrait = '';
  if (portraitRaw) {
    if (!FILE_URL_RE.test(portraitRaw)) {
      errors.push('The portrait must be an image uploaded through the console (an /files/... address). Outside image links are not accepted.');
    } else {
      const fileId = portraitRaw.slice('/files/'.length);
      const fileRow = await db.get('SELECT id FROM files WHERE id = ?', [fileId]);
      if (!fileRow) {
        errors.push('That portrait upload could not be found. Please upload the image again.');
      } else {
        portrait = portraitRaw;
      }
    }
  }

  /* Parent existence / cycle checks only when the rest is already usable. */
  if (!errors.length) {
    const parentError = await checkParent(parentParsed.value, base.id ? Number(base.id) : null);
    if (parentError) errors.push(parentError);
  }

  return {
    errors: errors,
    value: {
      title: title,
      name: name,
      category: category,
      description: description,
      portrait: portrait,
      sort_order: sortOrder,
      status: status,
      parent_id: parentParsed.value
    }
  };
}

/* ------------------------------- public ---------------------------------- */
/* Published entries only — never drafts, even when the caller is signed in,
 * so the homepage always renders exactly what the public may see. */
router.get('/', asyncHandler(async function (req, res) {
  const rows = await db.query(
    'SELECT ' + PUBLIC_COLUMNS + " FROM org_chart WHERE status = 'published' ORDER BY sort_order, id"
  );
  /* An admin edit must be visible on the next page load. */
  res.set('Cache-Control', 'no-cache');
  res.json({ entries: rows, total: rows.length });
}));

/* -------------------------------- admin ---------------------------------- */
router.get('/admin', requireRole('ADMIN'), asyncHandler(async function (req, res) {
  const rows = await db.query('SELECT * FROM org_chart ORDER BY sort_order, id');
  res.set('Cache-Control', 'no-cache');
  res.json({ entries: rows, total: rows.length, categories: CATEGORIES });
}));

router.post('/', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const v = await readEntry(req.body || {}, null);
  if (v.errors.length) return res.status(422).json({ error: v.errors[0], errors: v.errors });

  /* db.run appends RETURNING id on PostgreSQL, so lastInsertRowid is filled
   * on both drivers (see db.js rawRun). */
  const info = await db.run(
    `INSERT INTO org_chart (parent_id, title, name, category, description, portrait, sort_order, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [v.value.parent_id, v.value.title, v.value.name, v.value.category, v.value.description,
     v.value.portrait, v.value.sort_order, v.value.status, (req.user && req.user.id) || null]
  );
  await db.logAudit(req.user, 'org_chart.create', 'org_chart', info.lastInsertRowid,
    { title: v.value.title, status: v.value.status }, req);
  return res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.put('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const id = parseInt(String(req.params.id), 10);
  const existing = id ? await db.get('SELECT * FROM org_chart WHERE id = ?', [id]) : null;
  if (!existing) return res.status(404).json({ error: 'Organization chart entry not found' });

  const v = await readEntry(req.body || {}, existing);
  if (v.errors.length) return res.status(422).json({ error: v.errors[0], errors: v.errors });

  const oldPortrait = existing.portrait || '';
  await db.run(
    `UPDATE org_chart SET parent_id = ?, title = ?, name = ?, category = ?, description = ?,
       portrait = ?, sort_order = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [v.value.parent_id, v.value.title, v.value.name, v.value.category, v.value.description,
     v.value.portrait, v.value.sort_order, v.value.status, id]
  );

  /* A replaced or cleared portrait releases its file — but only when nothing
   * else still references it (fileutil checks every table). */
  if (oldPortrait && oldPortrait !== v.value.portrait) {
    const removed = await fileutil.deleteFile(oldPortrait);
    if (removed.deleted) {
      await db.logAudit(req.user, 'org_chart.file.cleanup', 'files', removed.id, {}, req);
    }
  }

  await db.logAudit(req.user, 'org_chart.update', 'org_chart', id,
    { title: v.value.title, status: v.value.status }, req);
  return res.json({ ok: true });
}));

router.delete('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const id = parseInt(String(req.params.id), 10);
  const row = id ? await db.get('SELECT * FROM org_chart WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Organization chart entry not found' });

  /* Deleting a parent must never orphan its children: they move up to the
   * deleted entry's own parent (or the top level).  Reparenting BEFORE the
   * delete keeps every reference valid at all times; it cannot create a loop
   * because the new parent is already an ancestor-or-null of the old one. */
  const childRow = await db.get('SELECT COUNT(*) AS n FROM org_chart WHERE parent_id = ?', [id]);
  const reparented = (childRow && Number(childRow.n)) || 0;
  const newParent = (row.parent_id === null || row.parent_id === undefined)
    ? null : Number(row.parent_id);
  await db.run('UPDATE org_chart SET parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE parent_id = ?',
    [newParent, id]);
  await db.run('DELETE FROM org_chart WHERE id = ?', [id]);

  if (row.portrait) {
    const removed = await fileutil.deleteFile(row.portrait);
    if (removed.deleted) {
      await db.logAudit(req.user, 'org_chart.file.cleanup', 'files', removed.id, {}, req);
    }
  }

  await db.logAudit(req.user, 'org_chart.delete', 'org_chart', id,
    { title: row.title, reparented: reparented }, req);
  return res.json({ ok: true, reparented: reparented });
}));

module.exports = router;


