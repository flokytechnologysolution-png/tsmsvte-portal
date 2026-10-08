/**
 * routes/admin.js — dashboard, audit log, backup/restore and the
 * "transfer ownership" flow.
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireRole, requireNotOwnerTarget, isOwner } = require('../middleware/auth');
const { backupZip, relPath } = require('../middleware/upload');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');
const zip = require('../lib/zip');
const ai = require('../lib/ai');
const sms = require('../lib/sms');
const mailer = require('../lib/mailer');
const realtime = require('../lib/realtime');

const router = express.Router();
router.use(requireRole('ADMIN'));

/* ------------------------------ dashboard ----------------------------- */
router.get('/dashboard', asyncHandler(async function (req, res) {
  const one = async function (sql, ...params) {
    const row = await db.get(sql, params);
    return row ? row.n : 0;
  };

  const schoolsPerLga = await db.query(
    `SELECT l.name, COUNT(s.id) AS total FROM lgas l
     LEFT JOIN schools s ON s.lga = l.name AND s.status = 'active'
     GROUP BY l.id ORDER BY l.sort_order`
  );

  const lastSms = await db.get('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 1') || null;
  const openTickets = await one("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'");

  const ownerFilter = isOwner(req.user) ? '' : " AND role <> 'OWNER'";

  res.json({
    cards: {
      schools: await one("SELECT COUNT(*) AS n FROM schools WHERE status = 'active'"),
      lgas_covered: schoolsPerLga.filter(function (r) { return r.total > 0; }).length,
      total_lgas: schoolsPerLga.length,
      staff_pending: await one("SELECT COUNT(*) AS n FROM staff WHERE status IN ('pending', 'PENDING')"),
      staff_approved: await one("SELECT COUNT(*) AS n FROM staff WHERE status = 'APPROVED'"),
      staff_total: await one('SELECT COUNT(*) AS n FROM staff'),
      news_published: await one("SELECT COUNT(*) AS n FROM news WHERE status = 'published'"),
      news_drafts: await one("SELECT COUNT(*) AS n FROM news WHERE status = 'draft'"),
      faqs: await one('SELECT COUNT(*) AS n FROM faqs'),
      kb_entries: await one('SELECT COUNT(*) AS n FROM knowledge_base'),
      circulars: await one('SELECT COUNT(*) AS n FROM circulars'),
      unread_tickets: openTickets,
      waiting_chats: await one("SELECT COUNT(*) AS n FROM chat_sessions WHERE status = 'waiting'"),
      live_chats: await one("SELECT COUNT(*) AS n FROM chat_sessions WHERE status = 'live'"),
      users: await one("SELECT COUNT(*) AS n FROM users WHERE status = 'ACTIVE'" + ownerFilter),
      last_sms: lastSms
        ? { at: lastSms.created_at, to: lastSms.recipients_count, status: lastSms.status,
            dry_run: Boolean(lastSms.dry_run), by: lastSms.sent_by_name }
        : null
    },
    schools_per_lga: schoolsPerLga,
    schools_by_type: await db.query(
      "SELECT type, COUNT(*) AS n FROM schools WHERE status = 'active' GROUP BY type"
    ),
    schools_by_category: await db.query(
      "SELECT category, COUNT(*) AS n FROM schools WHERE status = 'active' GROUP BY category"
    ),
    by_role: await db.query(
      'SELECT role, COUNT(*) AS n FROM users' + (ownerFilter ? ' WHERE ' + ownerFilter.substring(5) : '') + ' GROUP BY role'
    ),
    recent_audit: await db.query(
      'SELECT id, user_name, role, action, entity, entity_id, details, created_at FROM audit_log ORDER BY id DESC LIMIT 12'
    ),
    integrations: {
      ai: ai.status(),
      sms: sms.providerStatus(),
      mail: mailer.mailStatus(),
      sockets: realtime.stats(),
      admin_chat_status: await db.getSetting('admin_chat_status', 'offline')
    }
  });
}));

/* ------------------------------- audit log ---------------------------- */
router.get('/audit', requireRole('OWNER'), asyncHandler(async function (req, res) {
  const action = clean(req.query.action || '').slice(0, 80);
  const q = clean(req.query.q || '').slice(0, 80);
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || '50', 10) || 50));

  const where = [];
  const params = [];
  if (action) { where.push('action LIKE ?'); params.push('%' + action + '%'); }
  if (q) { where.push('(user_name LIKE ? OR details LIKE ? OR entity LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const totalRow = await db.get('SELECT COUNT(*) AS n FROM audit_log' + whereSql, params);
  const total = totalRow ? totalRow.n : 0;
  
  const rows = await db.query(
    'SELECT * FROM audit_log' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    [...params, limit, (page - 1) * limit]
  );

  res.json({ entries: rows, total: total, page: page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

/* --------------------------- backup / restore -------------------------- */
function walkFiles(dir, base, out) {
  const list = fs.readdirSync(dir, { withFileTypes: true });
  list.forEach(function (entry) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(abs, base, out);
    if (!entry.isFile()) return;
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    const stat = fs.statSync(abs);
    out.push({ name: rel, abs: abs, size: stat.size });
  });
  return out;
}

router.get('/backup', asyncHandler(async function (req, res) {
  /* The file-level backup only exists on the SQLite engine; on PostgreSQL the
   * data lives in a managed service, so answer 501 instead of failing mid-way
   * on a database file that does not exist. */
  if (typeof db.backup !== 'function') {
    return res.status(501).json({ error: 'Database file backup is only available when the portal runs on SQLite, not on PostgreSQL.' });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpDb = path.join(path.dirname(db.DB_FILE), 'backup-' + Date.now() + '.db');

  /* better-sqlite3's backup() produces a consistent copy of a live DB.
   * Note: In production (PostgreSQL), this local backup only saves the SQLite fallback file, 
   * not the Neon database. For true cloud backups, use Neon's built-in branching/backup features. */
  if (typeof db.backup === 'function') {
    db.backup(tmpDb);
  }

  const entries = [{ name: 'portal.db', data: fs.readFileSync(tmpDb), compress: false }];
  const uploadFiles = walkFiles(db.UPLOAD_DIR, db.UPLOAD_DIR, []);
  uploadFiles.forEach(function (f) {
    entries.push({ name: 'uploads/' + f.name, data: fs.readFileSync(f.abs), compress: true });
  });

  const settingsCountRow = await db.get('SELECT COUNT(*) AS n FROM settings');
  const schoolsCountRow = await db.get('SELECT COUNT(*) AS n FROM schools');
  const usersCountRow = await db.get('SELECT COUNT(*) AS n FROM users');
  const staffCountRow = await db.get('SELECT COUNT(*) AS n FROM staff');

  const meta = {
    created_at: new Date().toISOString(),
    app: 'taraba-edu-portal',
    ministry: await db.getSetting('ministry_name'),
    settings_rows: settingsCountRow ? settingsCountRow.n : 0,
    schools: schoolsCountRow ? schoolsCountRow.n : 0,
    users: usersCountRow ? usersCountRow.n : 0,
    staff: staffCountRow ? staffCountRow.n : 0,
    uploads: uploadFiles.length
  };
  entries.push({ name: 'backup-info.json', data: JSON.stringify(meta, null, 2) });

  const archive = zip.createZip(entries);
  fs.rm(tmpDb, { force: true }, function () { /* best effort */ });

  await db.logAudit(req.user, 'backup.download', 'backup', '', { files: entries.length, bytes: archive.length }, req);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="taraba-portal-backup-' + stamp + '.zip"');
  res.send(archive);
}));

router.post('/restore', requireRole('OWNER'), writeLimiter, backupZip.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file) return res.status(400).json({ error: 'Choose a backup .zip file to restore.' });
    if (typeof db.backup !== 'function') {
      return res.status(501).json({ error: 'Database file restore is only available when the portal runs on SQLite, not on PostgreSQL.' });
    }
    const password = String(req.body.password || '');
    if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
      return res.status(403).json({ error: 'Your password is required to restore a backup.' });
    }

    const files = zip.readZip(req.file.buffer);
    const dbEntry = files.filter(function (f) { return f.name === 'portal.db' || f.name.endsWith('/portal.db'); })[0];
    if (!dbEntry || !dbEntry.data) {
      return res.status(422).json({ error: 'That archive does not contain a portal.db file.' });
    }
    if (dbEntry.data.slice(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
      return res.status(422).json({ error: 'portal.db in that archive is not a valid SQLite database.' });
    }

    /* Safety net: keep a copy of the current database before replacing it. */
    const safety = path.join(path.dirname(db.DB_FILE), 'pre-restore-' + Date.now() + '.db');
    try {
      if (typeof db.backup === 'function') {
        db.backup(safety);
      }
    } catch (err) {
      return res.status(500).json({ error: 'Could not snapshot the current database: ' + err.message });
    }

    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(db.DB_FILE + suffix, { force: true });
    }
    fs.writeFileSync(db.DB_FILE, dbEntry.data);
    
    if (typeof db.close === 'function') db.close();
    if (typeof db.reload === 'function') db.reload();

    /* Restore uploads (skipping anything that tries to escape the folder). */
    const restored = [];
    files.filter(function (f) { return f.name.indexOf('uploads/') === 0 && f.data; })
      .forEach(function (f) {
        const rel = f.name.replace(/^uploads\//, '').replace(/\.\./g, '');
        const abs = path.join(db.UPLOAD_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.data);
        restored.push(rel);
      });

    if (typeof db.seed === 'function') await db.seed(); /* re-apply defaults in case the archive is from an older version */
    await db.logAudit(req.user, 'backup.restore', 'backup', '',
      { files: restored.length, safety_copy: path.basename(safety) }, req);

    return res.json({
      ok: true,
      restored_uploads: restored.length,
      safety_copy: path.basename(safety),
      message: 'The database has been replaced and reloaded. You may need to sign in again.'
    });
  }));

/* ------------------------- transfer of ownership ----------------------- */
router.post('/transfer/start', requireRole('OWNER'), writeLimiter, asyncHandler(async function (req, res) {
  const email = clean(req.body.email).toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');

  if (!email || email.indexOf('@') === -1) {
    return res.status(422).json({ error: 'Enter the email address of the new owner.' });
  }
  if (email === req.user.email.toLowerCase()) {
    return res.status(422).json({ error: 'That is already the owner address.' });
  }
  if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
    return res.status(403).json({ error: 'Re-enter your own password to start the transfer.' });
  }

  const existing = await db.get('SELECT id, role, full_name FROM users WHERE email = ?', [email]);
  if (existing && existing.role === 'OWNER') {
    return res.status(409).json({ error: 'That account is already the owner.' });
  }

  const tok = await db.createToken({
    userId: req.user.id,
    email: email,
    purpose: 'ownership_transfer',
    ttlMinutes: 60 * 48,
    meta: { from_user: req.user.id, to_email: email }
  });

  const base = (process.env.PORTAL_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const link = base + '/accept-ownership.html?token=' + tok.token;

  await db.logAudit(req.user, 'ownership.transfer.started', 'user', req.user.id, { to: email }, req);
  await db.notifyRole(['ADMIN'], 'Ownership transfer started',
    req.user.full_name + ' has started a transfer of ownership to ' + email + '.', '/admin.html');

  return res.json({
    ok: true,
    token: tok.token,
    link: link,
    expires_at: tok.expiresAt,
    emailed: false,
    note: 'There is no outbound email service configured, so deliver this one-time link to the new owner yourself (in person, by SMS or by any secure channel). It expires in 48 hours and works once.'
  });
}));

router.get('/transfer/pending', requireRole('OWNER'), asyncHandler(async function (req, res) {
  const rows = await db.query(
    `SELECT id, email, expires_at, created_at FROM tokens
     WHERE purpose = 'ownership_transfer' AND used_at IS NULL AND expires_at > ?
     ORDER BY id DESC LIMIT 10`,
    [new Date().toISOString()]
  );
  res.json({ pending: rows });
}));

router.post('/transfer/cancel', requireRole('OWNER'), writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.body.id);
  let info;
  if (id) {
    info = await db.run("UPDATE tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND purpose = 'ownership_transfer' AND used_at IS NULL", [id]);
  } else {
    info = await db.run("UPDATE tokens SET used_at = CURRENT_TIMESTAMP WHERE purpose = 'ownership_transfer' AND used_at IS NULL");
  }
  await db.logAudit(req.user, 'ownership.transfer.cancelled', 'user', req.user.id, { cancelled: info.changes }, req);
  return res.json({ ok: true, cancelled: info.changes });
}));

module.exports = router;