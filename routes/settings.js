/**
 * routes/settings.js — branding, content and configuration.
 * NOTHING is hardcoded in the app: every label, colour, contact detail and
 * paragraph is read from the settings table and edited here.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { images, relPath } = require('../middleware/upload');
const { handleErrors, clean } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/* Keys an administrator is allowed to change */
const EDITABLE_KEYS = Object.keys(db.DEFAULT_SETTINGS).filter(function (k) {
  return k !== 'mail_domain';
});
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/* Settings the server controls: when an environment value exists it always
 * wins, so the console must not be able to change it. */
const SERVER_CONTROLLED = ['sms_sender_id'];

/* --- Public: everything the pages need to render ---------------------- */
router.get('/public', function (req, res) {
  const s = db.getPublicSettings();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ settings: s });
});

/* --- Public: the registration privacy notice ---------------------------- *
 * privacy_notice is in PRIVATE_SETTING_KEYS and is therefore never part of
 * /public, but the public registration form is required by the Nigeria Data
 * Protection Act 2023 to show it. This endpoint exists for exactly that
 * reason and returns that one string and nothing else. */
router.get('/privacy-notice', function (req, res) {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ privacy_notice: db.getPublicPrivacyNotice() });
});

/* --- Authenticated: full settings (admins/editors see placeholders) --- */
router.get('/', requireAuth, function (req, res) {
  const smsLib = require('../lib/sms');
  res.json({
    settings: db.getSettings(),
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
});

/* --- Admin: update --------------------------------------------------- */
router.put('/', requireRole('ADMIN'), writeLimiter, function (req, res, next) {
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

  db.setSettings(updates);
  db.logAudit(req.user, 'settings.update', 'settings', '', Object.keys(updates), req);
  return res.json({ ok: true, updated: Object.keys(updates), rejected: rejected });
});

/* --- Admin: branding upload (logo / governor photo / hero image) ----- */
router.post('/upload', requireRole('ADMIN'), images.single('file'), asyncHandler(async function (req, res) {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
  const url = relPath(req.file.path);
  db.logAudit(req.user, 'settings.upload', 'settings', '', req.file.filename, req);
  return res.json({ ok: true, url: url, filename: req.file.filename });
}), handleErrors);

/* --- Admin: mail/SMS/AI integration status (never returns secrets) --- */
router.get('/integrations', requireRole('ADMIN'), function (req, res) {
  const mail = require('../lib/mailer');
  const sms = require('../lib/sms');
  const ai = require('../lib/ai');
  res.json({
    mail: mail.mailStatus(),
    sms: sms.providerStatus(),
    ai: ai.status(),
    sockets: require('../lib/realtime').stats()
  });
});

module.exports = router;