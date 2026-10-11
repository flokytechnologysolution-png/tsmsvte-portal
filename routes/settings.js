/**
 * routes/settings.js — branding, content and configuration.
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { handleErrors, clean } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter, uploadLimiter } = require('../middleware/rateLimit');
const { detectFileType, sanitizeFilename } = require('../lib/filetype');
const fileutil = require('../lib/fileutil');

const router = express.Router();

/* Keys an administrator is allowed to change */
const EDITABLE_KEYS = Object.keys(db.DEFAULT_SETTINGS).filter(function (k) {
  return k !== 'mail_domain';
});
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/* Settings the server controls: when an environment value exists it always
 * wins, so the console must not be able to change it. */
const SERVER_CONTROLLED = ['sms_sender_id'];

/* Console image uploads are held in memory and stored straight into the
 * `files` table (the same place POST /api/files uses), never on the ephemeral
 * disk. One file, field name "file". */
const MAX_IMAGE = 3 * 1024 * 1024;          /* 3 MB  */
const MULTER_LIMIT = MAX_IMAGE + 64 * 1024; /* headroom for the 413 check */
const MIN_BYTES = 64;                       /* reject empty / tiny uploads  */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_LIMIT, files: 1, fields: 8 }
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;   /* shown verbatim by the error handler */
  return err;
}
/* --- Public: everything the pages need to render ---------------------- */
router.get('/public', asyncHandler(async function (req, res) {
  const s = await db.getPublicSettings();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ settings: s });
}));

/* --- Public: the registration privacy notice ---------------------------- *
 * privacy_notice is in PRIVATE_SETTING_KEYS and is therefore never part of
 * /public, but the public registration form is required by the Nigeria Data
 * Protection Act 2023 to show it. This endpoint exists for exactly that
 * reason and returns that one string and nothing else. */
router.get('/privacy-notice', asyncHandler(async function (req, res) {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ privacy_notice: await db.getPublicPrivacyNotice() });
}));

/* --- Authenticated: full settings (admins/editors see placeholders) --- */
router.get('/', requireAuth, asyncHandler(async function (req, res) {
  const smsLib = require('../lib/sms');
  res.json({
    settings: await db.getSettings(),
    editable_keys: EDITABLE_KEYS,
    mail: require('../lib/mailer').mailStatus(),
    sms: smsLib.providerStatus(),
    /* Lets the console show the SMS sender ID as read-only when the server
     * supplies it, so nobody can type a value Termii has not approved. */
    sms_sender_id: {
      value: smsLib.resolveSenderId(),
      source: smsLib.senderIdSource(),       /* 'env' or 'setting' */
      editable: smsLib.senderIdSource() !== 'env',
      note: smsLib.senderIdSource() === 'env'
        ? 'Set by the server (TERMII_SENDER_ID). It must match the sender ID approved by Termii.'
        : 'No server value set — this field is used for outgoing SMS.'
    },
    ai: require('../lib/ai').status()
  });
}));

/* --- Admin: update --------------------------------------------------- */
router.put('/', requireRole('ADMIN'), writeLimiter, asyncHandler(async function (req, res, next) {
  const body = req.body || {};
  const updates = {};
  const rejected = [];

  Object.keys(body).forEach(function (key) {
    if (EDITABLE_KEYS.indexOf(key) === -1) { rejected.push(key); return; }
    let value = body[key];
    /* Reject changes to anything the environment controls, so the console
     * can never override a server-level value such as the approved sender ID. */
    if (SERVER_CONTROLLED.indexOf(key) !== -1 &&
      require('../lib/sms').senderIdSource() === 'env') { rejected.push(key); return; }
    if (Array.isArray(value)) value = value.join('\n');
    value = clean(value).slice(0, 20000);
    if (key.indexOf('color') !== -1 && value && !COLOR_RE.test(value)) { rejected.push(key); return; }
    if (key === 'primary_color' && !value) { rejected.push(key); return; }
    updates[key] = value;
  });

  if (!Object.keys(updates).length) {
    return res.status(422).json({ error: 'No valid settings were sent.' });
  }

  /* Capture the current value of every setting we are about to change so that,
   * when a stored "/files/<id>" image is replaced or cleared, we can delete the
   * now-orphaned files row — but only when nothing else still references it. */
  const keys = Object.keys(updates);
  const previous = {};
  for (let i = 0; i < keys.length; i++) {
    previous[keys[i]] = (await db.getSetting(keys[i])) || '';
  }

  await db.setSettings(updates);

  /* Release any old file that this update displaced. Ignore non-"/files/..."
   * values so static images such as /img/photos/governor.svg keep working. */
  const cleaned = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const oldValue = previous[key];
    if (oldValue === updates[key]) continue;            /* nothing changed   */
    if (!fileutil.fileIdFromUrl(oldValue)) continue;    /* not a stored file */
    const result = await fileutil.deleteFile(oldValue);
    if (result.deleted) cleaned.push(result.id);
  }

  await db.logAudit(req.user, 'settings.update', 'settings', '', keys, req);
  return res.json({ ok: true, updated: keys, rejected: rejected, cleaned: cleaned });
}));


/* --- Admin: store a site picture in the permanent files table --------- *
 * The Admin -> Site settings Upload buttons call this. The multipart field is
 * "file"; we confirm it is a real image by its MAGIC BYTES (never by name or
 * extension), store the bytes in the `files` table and answer with the stable
 * "/files/<id>" URL the setting must be saved with — exactly the shape
 * POST /api/files returns, so the console reuses one storage format.
 * ---------------------------------------------------------------------- */
router.post('/upload', requireRole('ADMIN'), uploadLimiter, upload.single('file'),
  asyncHandler(async function (req, res) {
    if (!req.file || !req.file.buffer) {
      throw httpError(400, 'No image was uploaded.');
    }
    const buf = req.file.buffer;
    if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) {
      throw httpError(400, 'That file is empty or too small to be valid.');
    }

    const detected = detectFileType(buf);
    if (!detected || detected.kind !== 'image') {
      throw httpError(415, 'Only JPEG, PNG and WebP images are allowed.');
    }
    if (buf.length > MAX_IMAGE) {
      throw httpError(413, 'Images must be 3 MB or smaller.');
    }

    /* 24 random hex chars, generated server-side. Never derived from the client. */
    const id = crypto.randomBytes(12).toString('hex');
    const originalName = sanitizeFilename(req.file.originalname || detected.ext);

    await db.run(
      'INSERT INTO files (id, original_name, mime, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, originalName, detected.mime, buf.length, buf, (req.user && req.user.id) || null]
    );
    await db.logAudit(req.user, 'settings.upload', 'files', id,
      { name: originalName, mime: detected.mime, size: buf.length }, req);

    res.status(201).json({
      ok: true, url: '/files/' + id, id: id,
      mime: detected.mime, size: buf.length, filename: originalName
    });
  })
);

/* --- Admin: mail/SMS/AI integration status (never returns secrets) --- */
router.get('/integrations', requireRole('ADMIN'), asyncHandler(async function (req, res) {
  const mail = require('../lib/mailer');
  const sms = require('../lib/sms');
  const ai = require('../lib/ai');
  res.json({
    mail: mail.mailStatus(),
    sms: sms.providerStatus(),
    ai: ai.status(),
    sockets: require('../lib/realtime').stats()
  });
}));

module.exports = router;

