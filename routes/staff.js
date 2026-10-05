/**
 * routes/staff.js — staff self-service plus the administrator approval flow.
 *
 * Approval creates the staff member's portal account, generates the internal
 * firstname.lastname@<mail domain> address and issues a one-time password
 * reset token that the administrator hands over in person or by SMS.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { images, relPath } = require('../middleware/upload');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');
const csv = require('../lib/csv');
const realtime = require('../lib/realtime');

const router = express.Router();

function staffFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    full_name: row.full_name,
    phone: row.phone,
    email: row.email,
    staff_number: row.staff_number,
    rank: row.rank,
    school_id: row.school_id,
    school_name: row.school_name,
    lga: row.lga,
    photo: row.photo,
    status: row.status,
    rejection_reason: row.rejection_reason,
    approved_at: row.approved_at,
    created_at: row.created_at
  };
}

/* ------------------------- staff self-service ------------------------- */
router.get('/me', requireAuth, function (req, res) {
  const staff = db.prepare('SELECT * FROM staff WHERE user_id = ?').get(req.user.id);
  res.json({ staff: staffFrom(staff), user: require('../middleware/auth').publicUser(req.user) });
});

router.put('/me', requireAuth, writeLimiter, images.single('photo'), asyncHandler(async function (req, res) {
  const staff = db.prepare('SELECT * FROM staff WHERE user_id = ?').get(req.user.id);
  if (!staff) return res.status(404).json({ error: 'No staff record is linked to your account yet.' });

  const phone = (clean(req.body.phone) || staff.phone).slice(0, 40);
  db.prepare("UPDATE staff SET phone = ?, photo = ?, updated_at = datetime('now') WHERE id = ?")
    .run(phone, req.file ? relPath(req.file.path) : staff.photo, staff.id);
  db.prepare("UPDATE users SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(phone, req.user.id);
  db.logAudit(req.user, 'staff.self_update', 'staff', staff.id, {}, req);
  return res.json({ ok: true });
}), handleErrors);

router.get('/notifications', requireAuth, function (req, res) {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n;
  res.json({ notifications: rows, unread: unread });
});

router.post('/notifications/read', requireAuth, function (req, res) {
  const id = toIntOrNull(req.body.id);
  if (id) db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* --------------------------- admin: list ------------------------------ */
router.get('/export.csv', requireRole('ADMIN'), function (req, res) {
  const rows = db.prepare(
    `SELECT s.*, u.mail_address FROM staff s LEFT JOIN users u ON u.id = s.user_id
     ORDER BY s.lga, s.full_name COLLATE NOCASE`
  ).all().map(function (r) {
    return {
      full_name: r.full_name, phone: r.phone, email: r.email, staff_number: r.staff_number,
      rank: r.rank, school_name: r.school_name, lga: r.lga, status: r.status,
      mail_address: r.mail_address || '', registered_at: r.created_at
    };
  });
  db.logAudit(req.user, 'staff.export', 'staff', '', { count: rows.length }, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="staff-export.csv"');
  res.send(csv.toCsv(['full_name', 'phone', 'email', 'staff_number', 'rank', 'school_name',
    'lga', 'status', 'mail_address', 'registered_at'], rows));
});

router.get('/', requireRole('ADMIN'), function (req, res) {
  const status = clean(req.query.status || '').toUpperCase();
  const lga = clean(req.query.lga || '').slice(0, 60);
  const q = clean(req.query.q || '').slice(0, 80);
  const schoolId = toIntOrNull(req.query.school_id);
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));

  const where = [];
  const params = [];
  if (['PENDING', 'APPROVED', 'REJECTED'].indexOf(status) !== -1) { where.push('s.status = ?'); params.push(status); }
  if (lga) { where.push('s.lga = ?'); params.push(lga); }
  if (schoolId) { where.push('s.school_id = ?'); params.push(schoolId); }
  if (q) {
    where.push('(s.full_name LIKE ? OR s.email LIKE ? OR s.staff_number LIKE ? OR s.school_name LIKE ?)');
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const total = db.prepare('SELECT COUNT(*) AS n FROM staff s' + whereSql).get(...params).n;
  const rows = db.prepare(
    "SELECT s.*, u.mail_address, u.role, u.status AS user_status FROM staff s LEFT JOIN users u ON u.id = s.user_id" +
    whereSql +
    " ORDER BY CASE s.status WHEN 'PENDING' THEN 0 ELSE 1 END, s.created_at DESC LIMIT ? OFFSET ?"
  ).all(...params, limit, (page - 1) * limit);

  res.json({
    staff: rows.map(function (r) {
      return Object.assign(staffFrom(r), {
        mail_address: r.mail_address, role: r.role, user_status: r.user_status
      });
    }),
    total: total,
    page: page,
    pages: Math.max(1, Math.ceil(total / limit))
  });
});

/* ------------------------ admin: approval flow ------------------------ */
function findStaff(id) {
  return id ? db.prepare('SELECT * FROM staff WHERE id = ?').get(id) : null;
}

router.post('/:id([0-9]+)/approve', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const staff = findStaff(toIntOrNull(req.params.id));
  if (!staff) return res.status(404).json({ error: 'Staff registration not found' });
  if (staff.status === 'APPROVED') return res.status(409).json({ error: 'This staff member is already approved.' });

  const domain = db.getSetting('mail_domain');
  let userId = staff.user_id;
  let mailAddress = '';

  const tx = db.transaction(function () {
    const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(staff.email);
    if (userId) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      mailAddress = (u && u.mail_address) || db.makeMailAddress(staff.full_name, domain);
      db.prepare("UPDATE users SET mail_address = ?, status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?")
        .run(mailAddress, userId);
    } else if (existingUser) {
      userId = existingUser.id;
      mailAddress = existingUser.mail_address || db.makeMailAddress(staff.full_name, domain);
      db.prepare("UPDATE users SET mail_address = ?, status = 'ACTIVE', role = 'STAFF', updated_at = datetime('now') WHERE id = ?")
        .run(mailAddress, userId);
    } else {
      mailAddress = db.makeMailAddress(staff.full_name, domain);
      /* The account starts with an unguessable password nobody knows: the
       * member of staff sets their own using the one-time token below. */
      const placeholder = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
      const info = db.prepare(
        `INSERT INTO users (email, password_hash, full_name, role, status, phone, mail_address)
         VALUES (?, ?, ?, 'STAFF', 'ACTIVE', ?, ?)`
      ).run(staff.email, placeholder, staff.full_name, staff.phone, mailAddress);
      userId = info.lastInsertRowid;
    }

    db.prepare(
      `UPDATE staff SET status = 'APPROVED', user_id = ?, approved_by = ?, approved_at = datetime('now'),
        rejection_reason = '', updated_at = datetime('now') WHERE id = ?`
    ).run(userId, req.user.id, staff.id);
  });
  tx();

  const tok = db.createToken({
    userId: userId,
    email: staff.email,
    purpose: 'password_reset',
    ttlMinutes: 60 * 24 * 14,
    meta: { issued_by: req.user.id, staff_id: staff.id }
  });

  db.notify(userId, 'Your account has been approved',
    'Welcome. Your portal mail address is ' + mailAddress +
    '. Ask an administrator for your one-time password to sign in.', '/dashboard.html');
  realtime.sendToUser(userId, { type: 'account:approved' });
  db.logAudit(req.user, 'staff.approve', 'staff', staff.id, { user_id: userId, mail_address: mailAddress }, req);

  return res.json({
    ok: true,
    user_id: userId,
    mail_address: mailAddress,
    reset_token: tok.token,
    reset_expires: tok.expiresAt,
    note: 'Give this one-time password token to the staff member. It expires in 14 days and can be used once.'
  });
});

router.post('/:id([0-9]+)/reject', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const staff = findStaff(toIntOrNull(req.params.id));
  if (!staff) return res.status(404).json({ error: 'Staff registration not found' });
  const reason = clean(req.body.reason).slice(0, 500);
  db.prepare(
    "UPDATE staff SET status = 'REJECTED', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(reason, staff.id);
  if (staff.user_id) {
    db.notify(staff.user_id, 'Registration not approved', reason || 'Please contact the ministry office.', '/register.html');
  }
  db.logAudit(req.user, 'staff.reject', 'staff', staff.id, { reason: reason }, req);
  return res.json({ ok: true });
});

router.post('/:id([0-9]+)/reset-token', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const staff = findStaff(toIntOrNull(req.params.id));
  if (!staff) return res.status(404).json({ error: 'Staff registration not found' });
  if (!staff.user_id) return res.status(409).json({ error: 'This staff member has not been approved yet.' });
  const tok = db.createToken({
    userId: staff.user_id,
    email: staff.email,
    purpose: 'password_reset',
    ttlMinutes: 60 * 24 * 3,
    meta: { issued_by: req.user.id }
  });
  db.logAudit(req.user, 'staff.reset_token', 'staff', staff.id, {}, req);
  return res.json({
    ok: true,
    reset_token: tok.token,
    reset_expires: tok.expiresAt,
    note: 'One-time token. Hand it to the staff member directly — it is shown only once.'
  });
});

/* ------------------- admin: staff record maintenance ------------------- */
router.get('/:id([0-9]+)', requireRole('ADMIN'), function (req, res) {
  const staff = findStaff(toIntOrNull(req.params.id));
  if (!staff) return res.status(404).json({ error: 'Staff registration not found' });
  const user = staff.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(staff.user_id) : null;
  res.json({
    staff: staffFrom(staff),
    account: user ? {
      id: user.id, email: user.email, role: user.role, status: user.status,
      mail_address: user.mail_address, last_login_at: user.last_login_at
    } : null
  });
});

router.put('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const staff = findStaff(toIntOrNull(req.params.id));
  if (!staff) return res.status(404).json({ error: 'Staff registration not found' });

  const patch = {
    id: staff.id,
    full_name: (clean(req.body.full_name) || staff.full_name).slice(0, 120),
    phone: (clean(req.body.phone) || staff.phone).slice(0, 40),
    staff_number: (clean(req.body.staff_number) || staff.staff_number).slice(0, 60),
    rank: (clean(req.body.rank) || staff.rank).slice(0, 80),
    lga: (clean(req.body.lga) || staff.lga).slice(0, 60),
    school_name: (clean(req.body.school_name) || staff.school_name).slice(0, 200)
  };
  db.prepare(
    `UPDATE staff SET full_name=@full_name, phone=@phone, staff_number=@staff_number, rank=@rank,
      lga=@lga, school_name=@school_name, updated_at=datetime('now') WHERE id=@id`
  ).run(patch);
  if (staff.user_id) {
    db.prepare("UPDATE users SET full_name = ?, phone = ?, updated_at = datetime('now') WHERE id = ?")
      .run(patch.full_name, patch.phone, staff.user_id);
  }
  db.logAudit(req.user, 'staff.update', 'staff', staff.id, {}, req);
  return res.json({ ok: true });
});

router.delete('/:id([0-9]+)', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const staff = findStaff(toIntOrNull(req.params.id));
  if (!staff) return res.status(404).json({ error: 'Staff registration not found' });
  db.prepare('DELETE FROM staff WHERE id = ?').run(staff.id);
  db.logAudit(req.user, 'staff.delete', 'staff', staff.id,
    { full_name: staff.full_name, account_kept: Boolean(staff.user_id) }, req);
  return res.json({ ok: true, note: 'The staff record was removed. Any linked user account was kept.' });
});

/* ------------------------- admin: user accounts ------------------------ */
router.get('/users/list', requireRole('ADMIN'), function (req, res) {
  const role = clean(req.query.role || '').toUpperCase();
  const q = clean(req.query.q || '').slice(0, 80);
  const where = [];
  const params = [];
  if (db.ROLES.indexOf(role) !== -1) { where.push('role = ?'); params.push(role); }
  if (q) { where.push('(full_name LIKE ? OR email LIKE ? OR mail_address LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    'SELECT id, email, full_name, role, status, phone, mail_address, last_login_at, created_at FROM users' +
    whereSql + ' ORDER BY CASE role WHEN \'OWNER\' THEN 0 WHEN \'ADMIN\' THEN 1 WHEN \'EDITOR\' THEN 2 ELSE 3 END, full_name COLLATE NOCASE'
  ).all(...params);
  res.json({ users: rows, roles: db.ROLES });
});

router.put('/users/:id([0-9]+)', requireRole('OWNER'), writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const user = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(409).json({ error: 'You cannot change your own role or status here.' });
  if (user.role === 'OWNER') return res.status(409).json({ error: 'The owner account can only be changed with the transfer-ownership flow.' });

  const role = clean(req.body.role || user.role).toUpperCase();
  if (['ADMIN', 'EDITOR', 'STAFF'].indexOf(role) === -1) return res.status(422).json({ error: 'Role must be ADMIN, EDITOR or STAFF.' });
  const status = req.body.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';

  db.prepare("UPDATE users SET role = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(role, status, id);
  db.logAudit(req.user, 'user.update', 'user', id, { role: role, status: status }, req);
  return res.json({ ok: true });
});

router.post('/users/:id([0-9]+)/reset-token', requireRole('ADMIN'), writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const user = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'OWNER' && req.user.role !== 'OWNER') {
    return res.status(403).json({ error: 'Only the owner can reset the owner password.' });
  }
  const tok = db.createToken({
    userId: user.id, email: user.email, purpose: 'password_reset',
    ttlMinutes: 60 * 24 * 3, meta: { issued_by: req.user.id }
  });
  db.logAudit(req.user, 'user.reset_token', 'user', user.id, {}, req);
  return res.json({ ok: true, reset_token: tok.token, reset_expires: tok.expiresAt,
    note: 'One-time token, shown only once.' });
});

module.exports = router;