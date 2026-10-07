/**
 * routes/faq.js — public FAQ (searchable accordion) + the AI knowledge base.
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { clean, toIntOrNull } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errors');

const router = express.Router();

/* ------------------------------- FAQ ---------------------------------- */
router.get('/', asyncHandler(async function (req, res) {
  const q = clean(req.query.q || '').slice(0, 80);
  const category = clean(req.query.category || '').slice(0, 60);
  const canSeeDrafts = req.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(req.user.role) !== -1;
  const includeAll = canSeeDrafts && String(req.query.all || '') === '1';

  const where = [];
  const params = [];
  if (!includeAll) where.push("status = 'published'");
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) {
    where.push('(question LIKE ? OR answer LIKE ? OR keywords LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const rows = await db.query('SELECT * FROM faqs' + whereSql + ' ORDER BY sort_order, id', params);
  const catRows = await db.query("SELECT DISTINCT category FROM faqs WHERE status = 'published' ORDER BY category");
  const categories = catRows.map(function (r) { return r.category; });

  res.json({ faqs: rows, categories: categories, total: rows.length });
}));

function readFaq(body) {
  const question = clean(body.question).slice(0, 300);
  const answer = String(body.answer === undefined ? '' : body.answer).replace(/\r\n/g, '\n').slice(0, 8000).trim();
  const errors = [];
  if (!question) errors.push('The question is required.');
  if (!answer) errors.push('The answer is required.');
  return {
    errors: errors,
    value: {
      question: question,
      answer: answer,
      category: clean(body.category || 'General').slice(0, 60) || 'General',
      keywords: clean(body.keywords).slice(0, 300),
      sort_order: toIntOrNull(body.sort_order) || 0,
      status: body.status === 'draft' ? 'draft' : 'published'
    }
  };
}

router.post('/', requireRole('EDITOR'), writeLimiter, asyncHandler(async function (req, res) {
  const v = readFaq(req.body || {});
  if (v.errors.length) return res.status(422).json({ error: v.errors[0], errors: v.errors });
  const info = await db.run(
    `INSERT INTO faqs (question, answer, category, keywords, sort_order, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [v.value.question, v.value.answer, v.value.category, v.value.keywords, v.value.sort_order, v.value.status]
  );
  await db.logAudit(req.user, 'faq.create', 'faq', info.lastInsertRowid, { question: v.value.question }, req);
  return res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.put('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const existing = id ? await db.get('SELECT * FROM faqs WHERE id = ?', [id]) : null;
  if (!existing) return res.status(404).json({ error: 'FAQ entry not found' });
  const v = readFaq(Object.assign({}, existing, req.body || {}));
  if (v.errors.length) return res.status(422).json({ error: v.errors[0], errors: v.errors });
  await db.run(
    `UPDATE faqs SET question=?, answer=?, category=?, keywords=?,
      sort_order=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [v.value.question, v.value.answer, v.value.category, v.value.keywords, v.value.sort_order, v.value.status, id]
  );
  await db.logAudit(req.user, 'faq.update', 'faq', id, { question: v.value.question }, req);
  return res.json({ ok: true });
}));

router.delete('/:id([0-9]+)', requireRole('EDITOR'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM faqs WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'FAQ entry not found' });
  await db.run('DELETE FROM faqs WHERE id = ?', [id]);
  await db.logAudit(req.user, 'faq.delete', 'faq', id, { question: row.question }, req);
  return res.json({ ok: true });
}));

/* --------------------------- Knowledge base --------------------------- */
/* Stricter than the FAQ: only OWNER/ADMIN may change what the AI is
 * allowed to answer from. */
router.get('/knowledge-base', requireRole('ADMIN'), asyncHandler(async function (req, res) {
  const rows = await db.query('SELECT * FROM knowledge_base ORDER BY id DESC');
  res.json({ entries: rows, total: rows.length });
}));

function readKb(body) {
  const question = clean(body.question).slice(0, 300);
  const answer = String(body.answer === undefined ? '' : body.answer).replace(/\r\n/g, '\n').slice(0, 8000).trim();
  const errors = [];
  if (!question) errors.push('The question is required.');
  if (!answer) errors.push('The answer is required.');
  return {
    errors: errors,
    value: {
      question: question,
      answer: answer,
      keywords: clean(body.keywords).slice(0, 300),
      status: body.status === 'draft' ? 'draft' : 'published'
    }
  };
}

router.post('/knowledge-base', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const v = readKb(req.body || {});
  if (v.errors.length) return res.status(422).json({ error: v.errors[0], errors: v.errors });
  const info = await db.run(
    'INSERT INTO knowledge_base (question, answer, keywords, status) VALUES (?, ?, ?, ?)',
    [v.value.question, v.value.answer, v.value.keywords, v.value.status]
  );
  await db.logAudit(req.user, 'kb.create', 'knowledge_base', info.lastInsertRowid, { question: v.value.question }, req);
  return res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.put('/knowledge-base/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const existing = id ? await db.get('SELECT * FROM knowledge_base WHERE id = ?', [id]) : null;
  if (!existing) return res.status(404).json({ error: 'Knowledge base entry not found' });
  const v = readKb(Object.assign({}, existing, req.body || {}));
  if (v.errors.length) return res.status(422).json({ error: v.errors[0], errors: v.errors });
  await db.run(
    `UPDATE knowledge_base SET question=?, answer=?, keywords=?,
      status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [v.value.question, v.value.answer, v.value.keywords, v.value.status, id]
  );
  await db.logAudit(req.user, 'kb.update', 'knowledge_base', id, { question: v.value.question }, req);
  return res.json({ ok: true });
}));

router.delete('/knowledge-base/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM knowledge_base WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Knowledge base entry not found' });
  await db.run('DELETE FROM knowledge_base WHERE id = ?', [id]);
  await db.logAudit(req.user, 'kb.delete', 'knowledge_base', id, { question: row.question }, req);
  return res.json({ ok: true });
}));

module.exports = router;