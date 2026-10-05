/**
 * routes/auth.js — login, session, staff self-registration, password reset
 * and the ownership-transfer acceptance flow.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');
const { images } = require('../middleware/upload');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const realtime = require('../lib/realtime');

const router = express.Router();

/* --- CSRF bootstrap: guarantees the double-submit cookie exists -------- */
router.get('/csrf', function (req, res) {
  res.json({ csrfToken: res.locals.csrfToken });
});

router.get('/me', function (req, res) {
  if (!req.user) return res.json({ user: null });
  const staff = db.prepare('SELECT * FROM staff WHERE user_id = ?').get(req.user.id);
  const unread = db.prepare(
    'SELECT COUNT(*) AS n FROM message_recipients WHERE user_id = ? AND is_read = 0 AND is_deleted = 0'
  ).get(req.user.id).n;
  return res.json({
    user: auth.publicUser(req.user),
    staff: staff || null,
    unread_mail: unread,
    settings: db.getPublicSettings()
  });
});

/* --- Public quick stats for the home page ----------------------------- */
router.get('/stats', function (req, res) {
  const schools = db.prepare("SELECT COUNT(*) AS n FROM schools WHERE status = 'active'").get().n;
  const staff = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE status = 'APPROVED'").get().n;
  const news = db.prepare("SELECT COUNT(*) AS n FROM news WHERE status = 'published'").get().n;
  const circulars = db.prepare("SELECT COUNT(*) AS n FROM circulars WHERE status = 'published'").get().n;
  const byLga = db.prepare(
    `SELECT l.name, COUNT(s.id) AS total FROM lgas l
     LEFT JOIN schools s ON s.lga = l.name AND s.status = 'active'
     GROUP BY l.id ORDER BY l.sort_order`
  ).all();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    schools: schools,
    staff: staff,
    news: news,
    circulars: circulars,
    lgas: 16,
    schools_per_lga: byLga
  });
});

/* ------------------------------------------------------------------ *
 * Per-account login lockout (defence against password guessing)
 * ------------------------------------------------------------------ */

/* Account locks always expire on their own, so nobody — including the OWNER —
 * can be locked out permanently. */
const LOCK_WINDOW_MINUTES = 15;    /* failures are counted inside this window */
const LOCK_THRESHOLD = 5;          /* failures before the account is locked  */
const LOCK_BASE_MINUTES = 1;       /* first lock lasts 1 minute               */
const LOCK_MAX_MINUTES = 30;       /* ... doubling each time, capped at 30    */

/** Returns { locked: boolean, retryMinutes: number }. */
function lockState(email) {
  const live = db.prepare(
    `SELECT locked_until FROM login_attempts
     WHERE email = ? AND locked_until IS NOT NULL AND datetime(locked_until) > datetime('now')`
  ).get(email);
  if (!live) {
    /* No live lock. Clear the expiry so the next failure re-locks, but KEEP
     * failed_count: that is what makes the backoff grow (1, 2, 4, 8 ... 30
     * minutes) instead of always restarting at 1 minute. first_failed_at is
     * reset so the 15-minute counting window starts again. */
    db.prepare(
      `UPDATE login_attempts SET locked_until = NULL, first_failed_at = NULL
       WHERE email = ? AND locked_until IS NOT NULL AND datetime(locked_until) <= datetime('now')`
    ).run(email);
    return { locked: false, retryMinutes: 0 };
  }
  const mins = Math.max(1, Math.ceil(
    (new Date(String(live.locked_until).replace(' ', 'T') + 'Z') - Date.now()) / 60000));
  return { locked: true, retryMinutes: mins };
}

/* SQLite datetime('now') is UTC; format our JS dates the same way so the
 * comparisons in lockState() are always apples to apples. */
function utcStamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function recordFailure(email) {
  const now = new Date();
  const row = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(email);
  let count = 1;

  if (row) {
    if (row.first_failed_at) {
      const firstMs = Date.parse(String(row.first_failed_at).replace(' ', 'T') + 'Z');
      const withinWindow = !isNaN(firstMs) &&
        (now.getTime() - firstMs) < LOCK_WINDOW_MINUTES * 60000;
      count = withinWindow ? (row.failed_count || 0) + 1 : 1;
    } else {
      /* A previous lock has just expired and the counter was deliberately
       * kept (see lockState). Keep escalating from there so the backoff
       * really does grow instead of restarting at one minute. */
      count = (row.failed_count || 0) + 1;
    }
  }

  const minutes = count >= LOCK_THRESHOLD
    ? Math.min(LOCK_MAX_MINUTES, LOCK_BASE_MINUTES * Math.pow(2, count - LOCK_THRESHOLD))
    : 0;
  const lockedUntil = minutes ? utcStamp(new Date(now.getTime() + minutes * 60000)) : null;

  db.prepare(
    `INSERT INTO login_attempts (email, failed_count, first_failed_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (email) DO UPDATE SET
       failed_count = excluded.failed_count,
       first_failed_at = excluded.first_failed_at,
       locked_until = excluded.locked_until,
       updated_at = datetime('now')`
  ).run(email, count, utcStamp(now), lockedUntil);

  if (minutes) {
    db.logAudit(null, 'auth.login.locked', 'user', '', { email: email, minutes: minutes }, null);
  }
}

function clearFailures(email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
}

/* --- Login ------------------------------------------------------------ */
/* The lockout message is deliberately the SAME generic text as a bad
 * password, and the bcrypt comparison still runs for unknown accounts, so
 * nothing about which addresses exist can be inferred. */
const LOGIN_FAILED = 'Those sign-in details are not correct.';

router.post('/login', loginLimiter, asyncHandler(async function (req, res) {
  const email = clean(req.body.email).toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');

  if (!email || email.indexOf('@') === -1 || !password) {
    return res.status(422).json({ error: 'Enter your email address and password.' });
  }

  const lock = lockState(email);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  /* Always run a comparison so timing does not reveal whether the account exists. */
  const hash = user ? user.password_hash : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(password, hash);

  if (lock.locked) {
    db.logAudit(null, 'auth.login.blocked', 'user', '', { email: email }, req);
    return res.status(401).json({ error: LOGIN_FAILED });
  }
  if (!user || !ok) {
    recordFailure(email);
    db.logAudit(null, 'auth.login.failed', 'user', '', { email: email }, req);
    return res.status(401).json({ error: LOGIN_FAILED });
  }
  if (user.status !== 'ACTIVE') {
    return res.status(403).json({ error: 'This account is not active. Please contact the ministry administrator.' });
  }

  clearFailures(email);
  auth.setAuthCookie(res, auth.signToken(user));
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  db.logAudit(user, 'auth.login', 'user', user.id, { role: user.role }, req);

  return res.json({ ok: true, user: auth.publicUser(user), redirect: homeFor(user.role) });
}), handleErrors);

function homeFor(role) {
  if (role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR') return '/admin.html';
  return '/dashboard.html';
}

router.post('/logout', function (req, res) {
  if (req.user) db.logAudit(req.user, 'auth.logout', 'user', req.user.id, '', req);
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});



/* --- Staff self-registration ------------------------------------------ */
router.post('/register', registerLimiter, images.single('photo'), asyncHandler(async function (req, res) {
  if (db.getSetting('registration_open', '1') !== '1') {
    return res.status(403).json({ error: 'Staff registration is currently closed. Please contact the ministry office.' });
  }

  const fullName = clean(req.body.full_name).slice(0, 120);
  const phone = clean(req.body.phone).slice(0, 40);
  const email = clean(req.body.email).toLowerCase().slice(0, 160);
  const staffNumber = clean(req.body.staff_number).slice(0, 60);
  const rank = clean(req.body.rank).slice(0, 80);
  const lga = clean(req.body.lga).slice(0, 60);
  const schoolId = toIntOrNull(req.body.school_id);
  const consented = String(req.body.consent || '') === '1' || String(req.body.consent || '') === 'true';

  const errors = [];
  if (fullName.length < 3) errors.push('Enter your full name as it appears on your records.');
  if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) errors.push('Enter a valid phone number.');
  if (email.indexOf('@') === -1 || email.length < 5) errors.push('Enter a valid email address.');
  if (!staffNumber) errors.push('Your file/staff number is required.');
  if (!rank) errors.push('Tell us your rank or designation.');
  if (!lga && !schoolId) errors.push('Select your school or at least your LGA.');
  if (!consented) errors.push('Please accept the privacy notice to continue.');
  if (errors.length) return res.status(422).json({ error: errors[0], errors: errors });

  const dupe = db.prepare("SELECT id, status FROM staff WHERE lower(email) = ? AND status != 'REJECTED'").get(email);
  if (dupe) {
    return res.status(409).json({
      error: dupe.status === 'APPROVED'
        ? 'A staff record already exists for this email address. Please sign in instead.'
        : 'You already have a registration awaiting approval. Please be patient.'
    });
  }

  const school = schoolId ? db.prepare('SELECT * FROM schools WHERE id = ?').get(schoolId) : null;
  const lgaValue = school ? school.lga : lga;

  const info = db.prepare(
    `INSERT INTO staff (full_name, phone, email, staff_number, rank, school_id, school_name, lga, photo, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
  ).run(
    fullName, phone, email, staffNumber, rank,
    school ? school.id : null,
    school ? school.name : clean(req.body.school_name).slice(0, 200),
    lgaValue,
    req.file ? require('../middleware/upload').relPath(req.file.path) : ''
  );

  db.logAudit(null, 'staff.register', 'staff', info.lastInsertRowid, { email: email, lga: lgaValue }, req);

  /* Tell the administrators there is something to review. */
  db.notifyRole(['OWNER', 'ADMIN'], 'New staff registration',
    fullName + ' (' + rank + ') has registered and is awaiting approval.', '/admin.html#staff');
  realtime.sendToAdmins({ type: 'staff:pending', id: Number(info.lastInsertRowid), name: fullName });

  return res.status(201).json({
    ok: true,
    id: info.lastInsertRowid,
    status: 'PENDING',
    message: 'Your registration has been received. A ministry administrator will review it and you will be notified when your account is approved.'
  });
}), handleErrors);

/* --- Password reset (token is generated by an administrator) ---------- */
router.post('/reset-password', loginLimiter, asyncHandler(async function (req, res) {
  const token = clean(req.body.token).slice(0, 200);
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');

  if (!token) return res.status(422).json({ error: 'Paste the reset token you were given.' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(422).json({ error: 'Choose a password of at least 8 characters containing letters and numbers.' });
  }
  if (password !== confirm) return res.status(422).json({ error: 'The two passwords do not match.' });

  const row = db.consumeToken(token, 'password_reset');
  if (!row || !row.user_id) {
    return res.status(400).json({ error: 'That reset token is not valid, has expired, or has already been used.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return res.status(400).json({ error: 'That reset token is not valid any more.' });

  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(password, 10), user.id);
  db.logAudit(user, 'auth.password_reset', 'user', user.id, '', req);
  return res.json({ ok: true, message: 'Your password has been changed. You can now sign in.' });
}), handleErrors);

/* --- Ownership transfer: inspect and accept the invitation ------------ */
router.get('/transfer', function (req, res) {
  const token = clean(req.query.token || '').slice(0, 200);
  if (!token) return res.status(400).json({ error: 'Missing invitation token.' });
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(
    `SELECT * FROM tokens WHERE token_hash = ? AND purpose = 'ownership_transfer'
     AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
  ).get(hash);
  if (!row) return res.status(400).json({ error: 'This transfer invitation is not valid or has expired.' });
  const current = db.prepare("SELECT full_name FROM users WHERE role = 'OWNER' LIMIT 1").get();
  return res.json({
    ok: true,
    email: row.email,
    invited_by: current ? current.full_name : '',
    expires_at: row.expires_at
  });
});

router.post('/transfer/accept', loginLimiter, asyncHandler(async function (req, res) {
  const token = clean(req.body.token).slice(0, 200);
  const fullName = clean(req.body.full_name).slice(0, 120);
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');

  if (!token) return res.status(422).json({ error: 'Missing invitation token.' });
  if (fullName.length < 3) return res.status(422).json({ error: 'Enter your full name.' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(422).json({ error: 'Choose a password of at least 8 characters with letters and numbers.' });
  }
  if (password !== confirm) return res.status(422).json({ error: 'The two passwords do not match.' });

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const invitation = db.prepare(
    `SELECT * FROM tokens WHERE token_hash = ? AND purpose = 'ownership_transfer'
     AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
  ).get(hash);
  if (!invitation) return res.status(400).json({ error: 'This transfer invitation is not valid or has expired.' });

  const email = invitation.email;
  const hashPw = bcrypt.hashSync(password, 10);
  let newOwner = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let newOwnerId = newOwner ? newOwner.id : null;

  const tx = db.transaction(function () {
    if (newOwner) {
      db.prepare("UPDATE users SET password_hash = ?, full_name = ?, role = 'OWNER', status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?")
        .run(hashPw, fullName, newOwner.id);
    } else {
      const mail = db.makeMailAddress(fullName, db.getSetting('mail_domain'));
      const info = db.prepare(
        `INSERT INTO users (email, password_hash, full_name, role, status, mail_address)
         VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?)`
      ).run(email, hashPw, fullName, mail);
      newOwnerId = info.lastInsertRowid;
    }
    db.prepare("UPDATE users SET role = 'ADMIN', updated_at = datetime('now') WHERE id = ?")
      .run(invitation.user_id);
    db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE id = ?").run(invitation.id);
  });
  tx();

  db.logAudit({ id: newOwnerId, full_name: fullName, role: 'OWNER' },
    'ownership.transfer.accepted', 'user', newOwnerId, { previous_owner: invitation.user_id }, req);
  realtime.sendToAdmins({ type: 'ownership:changed' });
  return res.json({ ok: true, message: 'You are now the owner of this portal. Please sign in.' });
}), handleErrors);

module.exports = router;