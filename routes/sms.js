/**
 * routes/sms.js — bulk SMS (administrators only).
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { clean, toIntOrNull, handleErrors } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errors');
const { writeLimiter, smsLimiter } = require('../middleware/rateLimit');
const sms = require('../lib/sms');
const realtime = require('../lib/realtime');

const router = express.Router();

router.use(requireRole('ADMIN'));

const MAX_LENGTH = sms.MAX_LENGTH;

/** True when a stored UTC timestamp is in the past. */
function datetimeExpired(stamp) {
  return new Date(String(stamp).replace(' ', 'T') + 'Z').getTime() <= Date.now();
}

/* --------------------------- audience logic --------------------------- */
const AUDIENCES = ['all', 'lga', 'school', 'rank', 'custom'];

async function resolveAudience(spec) {
  const type = String(spec.type || 'all');
  if (type === 'custom') {
    const raw = Array.isArray(spec.phones) ? spec.phones : String(spec.phones || '').split(/[\s,;]+/);
    const seen = new Set();
    return raw.map(function (p) { return sms.normalisePhone(p); })
      .filter(function (p) {
        if (!p || p.length < 10 || seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .map(function (p) { return { name: 'Custom number', phone: p, lga: '', school_name: '', rank: '' }; });
  }

  const where = ["s.status = 'APPROVED'", "s.phone != ''"];
  const params = [];
  if (type === 'lga') { where.push('s.lga = ?'); params.push(clean(spec.lga).slice(0, 60)); }
  if (type === 'school') { where.push('s.school_id = ?'); params.push(toIntOrNull(spec.school_id)); }
  if (type === 'rank') { where.push('s.rank LIKE ?'); params.push('%' + clean(spec.rank).slice(0, 80) + '%'); }

  const rows = await db.query(
    'SELECT s.full_name, s.phone, s.lga, s.school_name, s.rank FROM staff s WHERE ' + where.join(' AND ') + ' ORDER BY s.full_name',
    params
  );

  const seen = new Set();
  return rows.map(function (r) {
    return {
      name: r.full_name,
      phone: sms.normalisePhone(r.phone),
      lga: r.lga, school_name: r.school_name, rank: r.rank
    };
  }).filter(function (r) {
    if (!r.phone || r.phone.length < 10 || seen.has(r.phone)) return false;
    seen.add(r.phone);
    return true;
  });
}

/* ---------------------------- status / meta --------------------------- */
router.get('/status', asyncHandler(async function (req, res) {
  const provider = sms.providerStatus();
  const ranks = await db.query(
    "SELECT DISTINCT rank FROM staff WHERE rank != '' AND status = 'APPROVED' ORDER BY rank"
  );
  const lastLog = await db.get('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 1') || null;

  res.json({
    provider: provider,
    max_length: MAX_LENGTH,
    batch_size: sms.BATCH_SIZE,
    audiences: AUDIENCES,
    warning: provider.implemented === false
      ? 'Provider not implemented yet; use Termii.'
      : (provider.dryRun ? 'DRY-RUN: no messages are really sent.' : ''),
    ranks: ranks.map(function (r) { return r.rank; }),
    last_log: lastLog
  });
}));

router.get('/audience', asyncHandler(async function (req, res) {
  const list = await resolveAudience({
    type: req.query.type || 'all',
    lga: req.query.lga,
    school_id: req.query.school_id,
    rank: req.query.rank,
    phones: req.query.phones
  });
  const noPhoneRow = await db.get("SELECT COUNT(*) AS n FROM staff WHERE status = 'APPROVED' AND (phone IS NULL OR phone = '')");
  
  res.json({
    count: list.length,
    sample: list.slice(0, 15),
    without_phone: noPhoneRow ? noPhoneRow.n : 0
  });
}));

/* ------------------------------ templates ----------------------------- */
router.get('/templates', asyncHandler(async function (req, res) {
  const templates = await db.query('SELECT * FROM sms_templates ORDER BY name COLLATE NOCASE');
  res.json({
    templates: templates,
    placeholders: ['{{message}}', '{{date}}', '{{time}}', '{{venue}}', '{{school}}', '{{rank}}', '{{name}}']
  });
}));

router.post('/templates', writeLimiter, asyncHandler(async function (req, res) {
  const name = clean(req.body.name).slice(0, 80);
  const body = String(req.body.body === undefined ? '' : req.body.body).slice(0, 1000).trim();
  if (!name || !body) return res.status(422).json({ error: 'A template needs both a name and a message body.' });
  
  try {
    const info = await db.run('INSERT INTO sms_templates (name, body, created_by) VALUES (?, ?, ?)', [name, body, req.user.id]);
    await db.logAudit(req.user, 'sms.template.create', 'sms_template', info.lastInsertRowid, { name: name }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).indexOf('UNIQUE') !== -1 || String(err.message).indexOf('unique') !== -1) {
      return res.status(409).json({ error: 'A template with that name already exists.' });
    }
    throw err;
  }
}));

router.put('/templates/:id([0-9]+)', writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM sms_templates WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Template not found' });
  const name = clean(req.body.name || row.name).slice(0, 80);
  const body = String(req.body.body === undefined ? row.body : req.body.body).slice(0, 1000).trim();
  
  await db.run("UPDATE sms_templates SET name = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [name, body, id]);
  await db.logAudit(req.user, 'sms.template.update', 'sms_template', id, { name: name }, req);
  return res.json({ ok: true });
}));

router.delete('/templates/:id([0-9]+)', writeLimiter, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM sms_templates WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Template not found' });
  
  await db.run('DELETE FROM sms_templates WHERE id = ?', [id]);
  await db.logAudit(req.user, 'sms.template.delete', 'sms_template', id, { name: row.name }, req);
  return res.json({ ok: true });
}));

/* ------------------------------ preview ----------------------------- */
/* STEP 1 of 2.  The audience is resolved ONCE and frozen into a snapshot;
 * /send then sends exactly this list and never re-resolves anything. */
const CONFIRM_TTL_MINUTES = 10;

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length <= 4 ? '****' : ('*******' + digits.slice(-4));
}

router.post('/preview', writeLimiter, asyncHandler(async function (req, res) {
  const status = sms.providerStatus();
  if (!status.implemented) {
    return res.status(422).json({
      error: 'Provider not implemented yet; use Termii.',
      provider: status.provider
    });
  }

  const message = String(req.body.message || '').trim();
  if (!message) return res.status(422).json({ error: 'Write the message you want to send.' });

  const list = await resolveAudience(req.body.audience || req.body);
  const info = sms.segmentInfo(message);

  const invalid = [];
  const usable = [];
  const seen = new Set();
  list.forEach(function (r) {
    const phone = sms.normalisePhone(r.phone);
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      invalid.push({ to: maskPhone(r.phone || ''), error: 'not a usable Nigerian mobile number' });
      return;
    }
    if (seen.has(phone)) return;
    seen.add(phone);
    usable.push({ name: r.name, phone: phone, lga: r.lga, school_name: r.school_name, rank: r.rank });
  });

  const tplId = toIntOrNull(req.body.template_id);
  const tpl = tplId ? await db.get('SELECT id, name FROM sms_templates WHERE id = ?', [tplId]) : null;

  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + CONFIRM_TTL_MINUTES * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');

  await db.run(
    `INSERT INTO sms_send_tokens (token_hash, user_id, recipients, recipient_count, invalid_count,
       message, template_id, template_name, audience, segments, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hash, req.user.id,
      JSON.stringify(usable.map(function (u) { return u.phone; })),
      usable.length, invalid.length, message,
      tpl ? tpl.id : null, tpl ? tpl.name : '',
      JSON.stringify(req.body.audience || {}).slice(0, 300),
      info.segments, expires
    ]
  );

  return res.json({
    recipient_count: usable.length,
    invalid_count: invalid.length,
    invalid: invalid.slice(0, 20),
    characters: message.length,
    segments: info.segments,
    encoding: info.encoding,
    chars_per_segment: info.charsPerSegment,
    too_long: message.length > MAX_LENGTH,
    preview_text: message.slice(0, 400),
    sample: usable.slice(0, 20).map(function (u) {
      return { name: u.name, phone: maskPhone(u.phone), rank: u.rank, school_name: u.school_name };
    }),
    template: tpl ? { id: tpl.id, name: tpl.name } : null,
    provider: status,
    confirm_token: raw,
    expires_in_minutes: CONFIRM_TTL_MINUTES,
    requires_confirmation: true
  });
}));

/* --------------------------------- send ------------------------------- */
/* STEP 2 of 2.  Only the confirmation token is accepted: the recipient list
 * and message come from the stored snapshot, never from the request body. */
router.post('/send', smsLimiter, asyncHandler(async function (req, res) {
  const raw = String(req.body.confirm_token || '').trim();
  if (!raw) {
    return res.status(428).json({
      error: 'Confirmation required. Preview the recipients first, then confirm.'
    });
  }

  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const snap = await db.get('SELECT * FROM sms_send_tokens WHERE token_hash = ?', [hash]);
  if (!snap) {
    return res.status(400).json({ error: 'That confirmation token is not valid. Preview again.' });
  }
  if (snap.used_at) {
    return res.status(400).json({ error: 'That confirmation token has already been used. Preview again.' });
  }
  if (snap.user_id !== req.user.id) {
    return res.status(403).json({ error: 'That confirmation token belongs to a different administrator.' });
  }
  if (datetimeExpired(snap.expires_at)) {
    await db.run('UPDATE sms_send_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [snap.id]);
    return res.status(400).json({ error: 'That confirmation token has expired. Preview again.' });
  }

  /* Burn the token BEFORE sending so it can never be replayed. */
  await db.run("UPDATE sms_send_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?", [snap.id]);

  const recipients = JSON.parse(snap.recipients);
  if (!recipients.length) {
    return res.status(422).json({ error: 'That preview had no usable recipients.' });
  }

  const result = await sms.sendBulk({
    recipients: recipients,
    message: snap.message
  });

  if (result.fatal && !result.dryRun) {
    await db.logAudit(req.user, 'sms.send.rejected', 'sms', '', {
      provider: result.provider, reason: result.fatal.message
    }, req);
    return res.status(422).json({ error: result.fatal.message, provider: result.provider });
  }

  const info = await db.run(
    `INSERT INTO sms_logs (sent_by, sent_by_name, audience, audience_meta, message, recipients_count,
      provider, status, dry_run, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id, req.user.full_name, snap.audience || 'all', snap.audience,
      snap.message, recipients.length, result.provider,
      result.failed === 0 ? 'success' : (result.sent > 0 ? 'partial' : 'failed'),
      result.dryRun ? 1 : 0,
      JSON.stringify({
        batches: result.batches,
        segments: snap.segments,
        invalid_count: snap.invalid_count,
        template: snap.template_name || null
      })
    ]
  );
  const sendId = info.lastInsertRowid;

  /* One row per recipient, with only the last four digits stored. */
  for (const r of result.results) {
    await db.run(
      `INSERT INTO sms_recipient_log (send_id, phone_masked, status, provider_id, error)
       VALUES (?, ?, ?, ?, ?)`,
      [sendId, maskPhone(r.to), r.ok ? (r.status === 'dry_run' ? 'queued' : 'sent') : 'failed', String(r.id || '').slice(0, 120), String(r.error || '').slice(0, 300)]
    );
  }
  for (const v of result.invalid) {
    await db.run(
      `INSERT INTO sms_recipient_log (send_id, phone_masked, status, provider_id, error)
       VALUES (?, ?, ?, ?, ?)`,
      [sendId, maskPhone(v.to), 'failed', '', v.error]
    );
  }

  await db.logAudit(req.user, result.dryRun ? 'sms.send.dry_run' : 'sms.send', 'sms_log', sendId, {
    recipients: recipients.length,
    sent: result.sent,
    failed: result.failed,
    batches: result.batches,
    segments: snap.segments,
    template_id: snap.template_id,
    template_name: snap.template_name,
    audience: snap.audience
  }, req);
  realtime.sendToAdmins({ type: 'sms:sent', count: recipients.length, dry_run: result.dryRun });

  return res.status(201).json({
    ok: true,
    log_id: sendId,
    dry_run: result.dryRun,
    provider: result.provider,
    batches: result.batches,
    recipients: recipients.length,
    sent: result.sent,
    failed: result.failed,
    invalid_count: result.invalid.length,
    segments: snap.segments,
    note: result.dryRun
      ? 'DRY-RUN: nothing was sent. Set TERMII_API_KEY and SMS_DRY_RUN=0 to send for real.'
      : ('Accepted by ' + result.provider + ' in ' + result.batches + ' batch(es).')
  });
}));

/* --------------------------------- logs ------------------------------- */
router.get('/logs', asyncHandler(async function (req, res) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10) || 25));
  const totalRow = await db.get('SELECT COUNT(*) AS n FROM sms_logs');
  const total = totalRow ? totalRow.n : 0;
  const rows = await db.query('SELECT * FROM sms_logs ORDER BY id DESC LIMIT ? OFFSET ?', [limit, (page - 1) * limit]);
  
  res.json({
    logs: rows.map(function (r) {
      let detail = [];
      try { detail = JSON.parse(r.detail); } catch (e) { detail = []; }
      return Object.assign({}, r, { detail: detail });
    }),
    total: total, page: page, pages: Math.max(1, Math.ceil(total / limit))
  });
}));

module.exports = router;