/**
 * routes/mail.js — INTERNAL portal mail.
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAuth, isAdminish, isOwner } = require('../middleware/auth');
const scope = require('../middleware/scope');
const { mailAttachments, relPath } = require('../middleware/upload');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { mailLimiter, writeLimiter } = require('../middleware/rateLimit');
const realtime = require('../lib/realtime');

const router = express.Router();

/* Everything in this router requires a signed-in user. */
router.use(requireAuth);

/* ------------------------- recipient resolution ------------------------ */
async function resolveRecipientIds(opts, senderId) {
  const type = String(opts.type || 'users');
  const ids = new Set();

  if (type === 'users') {
    (opts.ids || []).map(function (v) { return toIntOrNull(v); })
      .filter(Boolean)
      .forEach(function (id) { ids.add(id); });
  } else if (type === 'school' || type === 'lga' || type === 'role' || type === 'all') {
    const where = ["u.status = 'ACTIVE'"];
    const params = [];
    if (type === 'school') { where.push('s.school_id = ?'); params.push(toIntOrNull(opts.school_id)); }
    if (type === 'lga') { where.push('s.lga = ?'); params.push(clean(opts.lga).slice(0, 60)); }
    if (type === 'role') {
      const role = clean(opts.role).toUpperCase();
      if (db.ROLES.indexOf(role) === -1) return [];
      where.push('u.role = ?');
      params.push(role);
    }
    const rows = await db.query(
      'SELECT DISTINCT u.id FROM users u LEFT JOIN staff s ON s.user_id = u.id WHERE ' + where.join(' AND '),
      params
    );
    rows.forEach(function (r) { ids.add(r.id); });
  }

  ids.delete(senderId); /* never mail yourself */
  return Array.from(ids);
}

async function recipientCountFor(opts) {
  const ids = await resolveRecipientIds(opts, -1);
  return ids.length;
}

/* ------------------------------ folders ------------------------------- */
router.get('/folders', asyncHandler(async function (req, res) {
  const uid = req.user.id;
  const inbox = await db.get(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
     WHERE mr.user_id = ? AND mr.is_deleted = 0 AND mr.is_trashed = 0 AND m.status = 'sent'`,
    [uid]
  );
  const sentRow = await db.get("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND status = 'sent'", [uid]);
  const draftsRow = await db.get("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND status = 'draft'", [uid]);
  const trash = await db.get(
    `SELECT COUNT(*) AS n FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
     WHERE mr.user_id = ? AND mr.is_deleted = 0 AND mr.is_trashed = 1 AND m.status = 'sent'`,
    [uid]
  );
  
  res.json({
    inbox: inbox ? inbox.n : 0, 
    unread: inbox ? (inbox.unread || 0) : 0,
    sent: sentRow ? sentRow.n : 0, 
    drafts: draftsRow ? draftsRow.n : 0, 
    trash: trash ? trash.n : 0,
    mail_domain: await db.getSetting('mail_domain'),
    my_address: req.user.mail_address || '',
    external: require('../lib/mailer').mailStatus()
  });
}));

/* ----------------------- address book / pickers ------------------------ */
router.get('/recipients', asyncHandler(async function (req, res) {
  const type = String(req.query.type || 'users');
  const q = clean(req.query.q || '').toLowerCase().slice(0, 80);

  if (type === 'schools') {
    const sc = scope.schoolWhere(req.user, 's');
    const where = sc.sql ? (' WHERE ' + sc.sql) : '';
    const schools = await db.query(
      'SELECT s.id, s.name, s.lga FROM schools s' + where + ' ORDER BY s.name LIMIT 2000',
      sc.params
    );
    return res.json({ schools: schools });
  }
  if (type === 'lgas') {
    const lgas = await db.query('SELECT name FROM lgas ORDER BY sort_order');
    return res.json({ lgas: lgas.map(function (r) { return r.name; }) });
  }
  if (type === 'roles') {
    return res.json({ roles: require('../lib/roles').ROLES });
  }

  const where = ["u.status = 'ACTIVE'", 'u.id != ?'];
  const params = [req.user.id];
  if (!isOwner(req.user)) where.push("u.role <> 'OWNER'");
  if (q) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.mail_address LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  if (req.query.lga) { where.push('s.lga = ?'); params.push(clean(req.query.lga)); }
  if (req.query.school_id) { where.push('s.school_id = ?'); params.push(toIntOrNull(req.query.school_id)); }

  const rows = await db.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.mail_address, s.school_name, s.lga, s.rank
     FROM users u LEFT JOIN staff s ON s.user_id = u.id
     WHERE ` + where.join(' AND ') + ' ORDER BY u.full_name LIMIT 200',
    params
  );

  return res.json({ people: rows, total: rows.length });
}));

/* ------------------------------ listing ------------------------------- */
router.get('/list', asyncHandler(async function (req, res) {
  const uid = req.user.id;
  const folder = String(req.query.folder || 'inbox').toLowerCase();
  const q = clean(req.query.q || '').slice(0, 80);
  const onlyUnread = String(req.query.unread || '') === '1';
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10) || 25));
  const offset = (page - 1) * limit;

  if (folder === 'sent' || folder === 'drafts') {
    const status = folder === 'sent' ? 'sent' : 'draft';
    const where = ['m.sender_id = ?', 'm.status = ?'];
    const params = [uid, status];
    if (q) { where.push('(m.subject LIKE ? OR m.body LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
    const whereSql = ' WHERE ' + where.join(' AND ');
    
    const totalRow = await db.get('SELECT COUNT(*) AS n FROM messages m' + whereSql, params);
    const total = totalRow ? totalRow.n : 0;
    
    const rows = await db.query(
      `SELECT m.id, m.subject, m.created_at, m.updated_at, m.status, m.audience,
        (SELECT COUNT(*) FROM message_recipients r WHERE r.message_id = m.id) AS recipients,
        (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments
       FROM messages m` + whereSql + ' ORDER BY m.id DESC LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );
    return res.json({
      folder: folder,
      messages: rows.map(function (r) { return Object.assign(r, { is_read: 1, sender_name: 'You' }); }),
      total: total, page: page, pages: Math.max(1, Math.ceil(total / limit))
    });
  }

  const trashed = folder === 'trash' ? 1 : 0;
  const where = ['mr.user_id = ?', 'mr.is_deleted = 0', 'mr.is_trashed = ?', "m.status = 'sent'"];
  const params = [uid, trashed];
  if (onlyUnread) where.push('mr.is_read = 0');
  if (q) {
    where.push('(m.subject LIKE ? OR m.body LIKE ? OR u.full_name LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  
  const totalRow = await db.get(
    'SELECT COUNT(*) AS n FROM message_recipients mr JOIN messages m ON m.id = mr.message_id JOIN users u ON u.id = m.sender_id' + whereSql,
    params
  );
  const total = totalRow ? totalRow.n : 0;
  
  const rows = await db.query(
    `SELECT m.id, m.subject, m.created_at, mr.is_read, mr.read_at, u.full_name AS sender_name,
      u.role AS sender_role,
      (SELECT COUNT(*) FROM message_recipients r2 WHERE r2.message_id = m.id) AS recipients,
      (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments
     FROM message_recipients mr
     JOIN messages m ON m.id = mr.message_id
     JOIN users u ON u.id = m.sender_id` + whereSql +
    ' ORDER BY m.id DESC LIMIT ? OFFSET ?',
    [...params, limit, offset]
  );

  return res.json({
    folder: folder, messages: rows, total: total, page: page,
    pages: Math.max(1, Math.ceil(total / limit))
  });
}));

router.get('/unread-count', asyncHandler(async function (req, res) {
  const nRow = await db.get(
    `SELECT COUNT(*) AS n FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
     WHERE mr.user_id = ? AND mr.is_read = 0 AND mr.is_deleted = 0 AND mr.is_trashed = 0 AND m.status = 'sent'`,
    [req.user.id]
  );
  res.json({ unread: nRow ? nRow.n : 0 });
}));

/* --------------------------- single message --------------------------- */
async function loadMessageFor(user, id) {
  const msg = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
  if (!msg) return { error: 'Message not found', status: 404 };
  const isSender = msg.sender_id === user.id;
  const recipient = await db.get('SELECT * FROM message_recipients WHERE message_id = ? AND user_id = ?', [id, user.id]);
  if (!isSender && !recipient && !isAdminish(user)) {
    return { error: 'You do not have access to this message', status: 403 };
  }
  if (msg.status === 'draft' && !isSender) return { error: 'Message not found', status: 404 };
  return { msg: msg, isSender: isSender, recipient: recipient };
}

router.get('/message/:id([0-9]+)', asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const found = await loadMessageFor(req.user, id);
  if (found.error) return res.status(found.status).json({ error: found.error });

  const msg = found.msg;
  const sender = await db.get('SELECT id, full_name, email, mail_address, role FROM users WHERE id = ?', [msg.sender_id]);
  const recipients = await db.query(
    `SELECT mr.user_id, mr.is_read, mr.read_at, u.full_name, u.mail_address, u.email
     FROM message_recipients mr JOIN users u ON u.id = mr.user_id WHERE mr.message_id = ?`,
    [id]
  );
  const messageAttachments = await db.query(
    'SELECT id, original_name, size, mime FROM attachments WHERE message_id = ? ORDER BY id',
    [id]
  );

  /* Opening an inbox message marks it read. */
  if (found.recipient && !found.recipient.is_read) {
    await db.run("UPDATE message_recipients SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ?", [found.recipient.id]);
  }

  return res.json({
    message: {
      id: msg.id, thread_id: msg.thread_id, parent_id: msg.parent_id,
      subject: msg.subject, body: msg.body, audience: msg.audience, status: msg.status,
      created_at: msg.created_at, updated_at: msg.updated_at,
      is_sender: found.isSender, sender: sender, recipients: recipients,
      attachments: messageAttachments
    }
  });
}));

router.post('/message/:id([0-9]+)/read', writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const isRead = (req.body.read === false || String(req.body.read) === '0') ? 0 : 1;
  const info = await db.run(
    `UPDATE message_recipients SET is_read = ?,
       read_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
     WHERE message_id = ? AND user_id = ?`,
    [isRead, isRead, id, req.user.id]
  );
  res.json({ ok: true, changed: info.changes });
}));

router.post('/message/:id([0-9]+)/trash', writeLimiter, asyncHandler(async function (req, res) {
  await db.run('UPDATE message_recipients SET is_trashed = 1 WHERE message_id = ? AND user_id = ?', [toIntOrNull(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

router.post('/message/:id([0-9]+)/restore', writeLimiter, asyncHandler(async function (req, res) {
  await db.run('UPDATE message_recipients SET is_trashed = 0 WHERE message_id = ? AND user_id = ?', [toIntOrNull(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

router.delete('/message/:id([0-9]+)', writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const found = await loadMessageFor(req.user, id);
  if (found.error) return res.status(found.status).json({ error: found.error });

  if (found.isSender && !found.recipient) {
    await db.run('DELETE FROM messages WHERE id = ?', [id]); /* drafts & sent items */
  } else {
    await db.run('UPDATE message_recipients SET is_deleted = 1 WHERE message_id = ? AND user_id = ?', [id, req.user.id]);
  }
  await db.logAudit(req.user, 'mail.delete', 'message', id, {}, req);
  return res.json({ ok: true });
}));

/* ----------------------------- attachments ---------------------------- */
router.post('/upload', mailLimiter, mailAttachments.array('files', 5), asyncHandler(async function (req, res) {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No file was uploaded.' });
  
  const saved = [];
  for (const f of files) {
    const info = await db.run(
      `INSERT INTO attachments (uploader_id, purpose, original_name, stored_name, mime, size, rel_path)
       VALUES (?, 'mail', ?, ?, ?, ?, ?)`,
      [req.user.id, path.basename(f.originalname).slice(0, 200), path.basename(f.filename), f.mimetype, f.size, relPath(f.path)]
    );
    saved.push({ id: info.lastInsertRowid, name: f.originalname, size: f.size, mime: f.mimetype });
  }
  return res.status(201).json({ ok: true, attachments: saved });
}));

router.get('/attachment/:id([0-9]+)', asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM attachments WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Attachment not found' });

  let allowed = row.uploader_id === req.user.id || isAdminish(req.user);
  if (!allowed && row.message_id) {
    const found = await loadMessageFor(req.user, row.message_id);
    allowed = !found.error;
  }
  if (!allowed) return res.status(403).json({ error: 'You do not have access to this file' });

  const abs = path.resolve(__dirname, '..', row.rel_path.replace(/^\//, ''));
  if (abs.indexOf(path.resolve(__dirname, '..', 'uploads')) !== 0) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(abs)) return res.status(410).json({ error: 'The file is no longer available' });

  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'attachment; filename="' + row.original_name.replace(/[^\w.\- ]/g, '_') + '"');
  return fs.createReadStream(abs).pipe(res);
}));

/* -------------------------------- send -------------------------------- */
function readMailBody(body) {
  const subject = clean(body.subject).slice(0, 200);
  const text = String(body.body === undefined ? '' : body.body).replace(/\r\n/g, '\n').slice(0, 20000).trim();
  const errors = [];
  if (!subject) errors.push('Add a subject line.');
  if (!text) errors.push('Write a message.');
  return { errors: errors, value: { subject: subject, body: text } };
}

function audienceSpec(body) {
  return {
    type: String(body.to_type || 'users'),
    ids: Array.isArray(body.to_ids) ? body.to_ids : (body.to_ids ? [body.to_ids] : []),
    school_id: body.to_school_id,
    lga: body.to_lga,
    role: body.to_role
  };
}

async function linkAttachments(ids, messageId, uploaderId) {
  if (!ids) return;
  for (const raw of ids) {
    const id = toIntOrNull(raw);
    if (!id) continue;
    await db.run(
      'UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL',
      [messageId, id, uploaderId]
    );
  }
}

async function deliver(message, recipientIds) {
  for (const uid of recipientIds) {
    // ON CONFLICT DO NOTHING works in both SQLite (3.24+) and PostgreSQL
    await db.run(
      'INSERT INTO message_recipients (message_id, user_id) VALUES (?, ?) ON CONFLICT (message_id, user_id) DO NOTHING',
      [message.id, uid]
    );
    await db.notify(uid, 'New portal mail', message.subject, '/mail.html#message-' + message.id);
    realtime.sendToUser(uid, {
      type: 'mail:new', messageId: message.id, subject: message.subject,
      from: message.sender_name || '', at: message.created_at
    });
  }
}

router.post('/send', mailLimiter, asyncHandler(async function (req, res) {
  const parsed = readMailBody(req.body || {});
  if (parsed.errors.length) return res.status(422).json({ error: parsed.errors[0], errors: parsed.errors });

  const spec = audienceSpec(req.body || {});
  const recipientIds = await resolveRecipientIds(spec, req.user.id);
  if (!recipientIds.length) {
    return res.status(422).json({ error: 'No recipients matched. Choose at least one person, school, LGA or role.' });
  }

  const parentId = toIntOrNull(req.body.parent_id);
  let threadId = null;
  if (parentId) {
    const parent = await db.get('SELECT * FROM messages WHERE id = ?', [parentId]);
    if (parent) threadId = parent.thread_id || parent.id;
  }

  const info = await db.run(
    `INSERT INTO messages (thread_id, parent_id, sender_id, subject, body, audience, audience_meta, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`,
    [threadId, parentId || null, req.user.id, parsed.value.subject, parsed.value.body, spec.type,
     JSON.stringify({ ids: spec.ids, school_id: spec.school_id, lga: spec.lga, role: spec.role, count: recipientIds.length })]
  );

  await linkAttachments(req.body.attachment_ids, info.lastInsertRowid, req.user.id);
  await deliver({ id: info.lastInsertRowid, subject: parsed.value.subject, sender_name: req.user.full_name, created_at: new Date().toISOString() }, recipientIds);

  await db.logAudit(req.user, 'mail.send', 'message', info.lastInsertRowid,
    { recipients: recipientIds.length, audience: spec.type }, req);

  return res.status(201).json({
    ok: true, id: info.lastInsertRowid, delivered: recipientIds.length,
    note: 'Delivered to the internal portal mailboxes of the recipients.'
  });
}));

router.post('/draft', writeLimiter, asyncHandler(async function (req, res) {
  const spec = audienceSpec(req.body || {});
  const info = await db.run(
    `INSERT INTO messages (sender_id, subject, body, audience, audience_meta, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`,
    [req.user.id, clean(req.body.subject).slice(0, 200), String(req.body.body || '').slice(0, 20000), spec.type,
     JSON.stringify({ ids: spec.ids, school_id: spec.school_id, lga: spec.lga, role: spec.role })]
  );
  await linkAttachments(req.body.attachment_ids, info.lastInsertRowid, req.user.id);
  return res.status(201).json({ ok: true, id: info.lastInsertRowid, status: 'draft' });
}));

router.put('/draft/:id([0-9]+)', writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const draft = id ? await db.get("SELECT * FROM messages WHERE id = ? AND sender_id = ? AND status = 'draft'", [id, req.user.id]) : null;
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  const spec = audienceSpec(Object.assign(JSON.parse(draft.audience_meta || '{}'), req.body || {}));
  await db.run(
    "UPDATE messages SET subject = ?, body = ?, audience = ?, audience_meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [clean(req.body.subject || draft.subject).slice(0, 200), String(req.body.body === undefined ? draft.body : req.body.body).slice(0, 20000), spec.type, JSON.stringify(spec), id]
  );
  return res.json({ ok: true });
}));

router.post('/draft/:id([0-9]+)/send', mailLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const draft = id ? await db.get("SELECT * FROM messages WHERE id = ? AND sender_id = ? AND status = 'draft'", [id, req.user.id]) : null;
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const spec = audienceSpec(Object.assign(JSON.parse(draft.audience_meta || '{}'), req.body || {}));
  spec.type = spec.type || draft.audience;
  const recipientIds = await resolveRecipientIds(spec, req.user.id);
  if (!recipientIds.length) return res.status(422).json({ error: 'No recipients matched for this draft.' });

  await db.run(
    "UPDATE messages SET subject = ?, body = ?, status = 'sent', audience = ?, audience_meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [clean(req.body.subject || draft.subject).slice(0, 200), String(req.body.body === undefined ? draft.body : req.body.body).slice(0, 20000), spec.type, JSON.stringify(spec), id]
  );

  await linkAttachments(req.body.attachment_ids, id, req.user.id);
  await deliver({ id: id, subject: draft.subject, sender_name: req.user.full_name, created_at: new Date().toISOString() }, recipientIds);
  await db.logAudit(req.user, 'mail.send_draft', 'message', id, { recipients: recipientIds.length }, req);
  return res.json({ ok: true, delivered: recipientIds.length });
}));

module.exports = router;