/**
 * routes/sms.js — bulk SMS (administrators only).
 *
 * Safety rails:
 *   - recipient count is previewed first;
 *   - sending REQUIRES an explicit confirmation flag;
 *   - every send is logged (who, when, how many, status, provider);
 *   - with no API key the adapter runs in DRY-RUN and no SMS leaves the box.
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

function resolveAudience(spec) {
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

  const rows = db.prepare(
    'SELECT s.full_name, s.phone, s.lga, s.school_name, s.rank FROM staff s WHERE ' + where.join(' AND ') + ' ORDER BY s.full_name'
  ).all(...params);

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
router.get('/status', function (req, res) {
  const provider = sms.providerStatus();
  res.json({
    provider: provider,
    max_length: MAX_LENGTH,
    batch_size: sms.BATCH_SIZE,
    audiences: AUDIENCES,
    /* The admin UI shows this banner whenever a send cannot be real. */
    warning: provider.implemented === false
      ? 'Provider not implemented yet; use Termii.'
      : (provider.dryRun ? 'DRY-RUN: no messages are really sent.' : ''),
    ranks: db.prepare(
      "SELECT DISTINCT rank FROM staff WHERE rank != '' AND status = 'APPROVED' ORDER BY rank"
    ).all().map(function (r) { return r.rank; }),
    last_log: db.prepare('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 1').get() || null
  });
});

router.get('/audience', function (req, res) {
  const list = resolveAudience({
    type: req.query.type || 'all',
    lga: req.query.lga,
    school_id: req.query.school_id,
    rank: req.query.rank,
    phones: req.query.phones
  });
  res.json({
    count: list.length,
    sample: list.slice(0, 15),
    without_phone: db.prepare(
      "SELECT COUNT(*) AS n FROM staff WHERE status = 'APPROVED' AND (phone IS NULL OR phone = '')"
    ).get().n
  });
});

/* ------------------------------ templates ----------------------------- */
router.get('/templates', function (req, res) {
  res.json({
    templates: db.prepare('SELECT * FROM sms_templates ORDER BY name COLLATE NOCASE').all(),
    placeholders: ['{{message}}', '{{date}}', '{{time}}', '{{venue}}', '{{school}}', '{{rank}}', '{{name}}']
  });
});

router.post('/templates', writeLimiter, function (req, res) {
  const name = clean(req.body.name).slice(0, 80);
  const body = String(req.body.body === undefined ? '' : req.body.body).slice(0, 1000).trim();
  if (!name || !body) return res.status(422).json({ error: 'A template needs both a name and a message body.' });
  try {
    const info = db.prepare('INSERT INTO sms_templates (name, body, created_by) VALUES (?, ?, ?)')
      .run(name, body, req.user.id);
    db.logAudit(req.user, 'sms.template.create', 'sms_template', info.lastInsertRowid, { name: name }, req);
    return res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).indexOf('UNIQUE') !== -1) {
      return res.status(409).json({ error: 'A template with that name already exists.' });
    }
    throw err;
  }
});

router.put('/templates/:id([0-9]+)', writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Template not found' });
  const name = clean(req.body.name || row.name).slice(0, 80);
  const body = String(req.body.body === undefined ? row.body : req.body.body).slice(0, 1000).trim();
  db.prepare("UPDATE sms_templates SET name = ?, body = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, body, id);
  db.logAudit(req.user, 'sms.template.update', 'sms_template', id, { name: name }, req);
  return res.json({ ok: true });
});

router.delete('/templates/:id([0-9]+)', writeLimiter, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Template not found' });
  db.prepare('DELETE FROM sms_templates WHERE id = ?').run(id);
  db.logAudit(req.user, 'sms.template.delete', 'sms_template', id, { name: row.name }, req);
  return res.json({ ok: true });
});

/* ------------------------------ preview ----------------------------- */
/* STEP 1 of 2.  The audience is resolved ONCE and frozen into a snapshot;
 * /send then sends exactly this list and never re-resolves anything. */
const CONFIRM_TTL_MINUTES = 10;

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length <= 4 ? '****' : ('*******' + digits.slice(-4));
}

router.post('/preview', writeLimiter, function (req, res) {
  /* Reject a provider we know we cannot use, before any work is done. */
  const status = sms.providerStatus();
  if (!status.implemented) {
    return res.status(422).json({
      error: 'Provider not implemented yet; use Termii.',
      provider: status.provider
    });
  }

  const message = String(req.body.message || '').trim();
  if (!message) return res.status(422).json({ error: 'Write the message you want to send.' });

  const list = resolveAudience(req.body.audience || req.body);
  const info = sms.segmentInfo(message);

  /* Numbers that cannot be used are reported but never block the preview. */
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
  const tpl = tplId ? db.prepare('SELECT id, name FROM sms_templates WHERE id = ?').get(tplId) : null;

  /* Mint a single-use confirmation token bound to this administrator. */
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + CONFIRM_TTL_MINUTES * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');

  db.prepare(
    `INSERT INTO sms_send_tokens (token_hash, user_id, recipients, recipient_count, invalid_count,
       message, template_id, template_name, audience, segments, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    hash, req.user.id,
    JSON.stringify(usable.map(function (u) { return u.phone; })),
    usable.length, invalid.length, message,
    tpl ? tpl.id : null, tpl ? tpl.name : '',
    JSON.stringify(req.body.audience || {}).slice(0, 300),
    info.segments, expires
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
});

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
  const snap = db.prepare('SELECT * FROM sms_send_tokens WHERE token_hash = ?').get(hash);
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
    db.prepare('UPDATE sms_send_tokens SET used_at = datetime(\'now\') WHERE id = ?').run(snap.id);
    return res.status(400).json({ error: 'That confirmation token has expired. Preview again.' });
  }

  /* Burn the token BEFORE sending so it can never be replayed. */
  db.prepare("UPDATE sms_send_tokens SET used_at = datetime('now') WHERE id = ?").run(snap.id);

  const recipients = JSON.parse(snap.recipients);
  if (!recipients.length) {
    return res.status(422).json({ error: 'That preview had no usable recipients.' });
  }

  const result = await sms.sendBulk({
    recipients: recipients,
    message: snap.message
    /* No senderId here on purpose: lib/sms.js resolves it so the approved
     * value in the environment always wins over the site setting. */
  });

  /* A provider that is not implemented stops the send with a clear message. */
  if (result.fatal && !result.dryRun) {
    db.logAudit(req.user, 'sms.send.rejected', 'sms', '', {
      provider: result.provider, reason: result.fatal.message
    }, req);
    return res.status(422).json({ error: result.fatal.message, provider: result.provider });
  }

  /* Parent log row. detail keeps a summary only; every recipient gets its own
   * row in sms_recipient_log, so nothing is truncated away. */
  const info = db.prepare(
    `INSERT INTO sms_logs (sent_by, sent_by_name, audience, audience_meta, message, recipients_count,
      provider, status, dry_run, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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
  );
  const sendId = info.lastInsertRowid;

  /* One row per recipient, with only the last four digits stored. */
  const insRecipient = db.prepare(
    `INSERT INTO sms_recipient_log (send_id, phone_masked, status, provider_id, error)
     VALUES (?, ?, ?, ?, ?)`
  );
  db.transaction(function () {
    result.results.forEach(function (r) {
      insRecipient.run(sendId, maskPhone(r.to),
        r.ok ? (r.status === 'dry_run' ? 'queued' : 'sent') : 'failed',
        String(r.id || '').slice(0, 120), String(r.error || '').slice(0, 300));
    });
    result.invalid.forEach(function (v) {
      insRecipient.run(sendId, maskPhone(v.to), 'failed', '', v.error);
    });
  })();

  db.logAudit(req.user, result.dryRun ? 'sms.send.dry_run' : 'sms.send', 'sms_log', sendId, {
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
router.get('/logs', function (req, res) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10) || 25));
  const total = db.prepare('SELECT COUNT(*) AS n FROM sms_logs').get().n;
  const rows = db.prepare('SELECT * FROM sms_logs ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, (page - 1) * limit);
  res.json({
    logs: rows.map(function (r) {
      let detail = [];
      try { detail = JSON.parse(r.detail); } catch (e) { detail = []; }
      return Object.assign({}, r, { detail: detail });
    }),
    total: total, page: page, pages: Math.max(1, Math.ceil(total / limit))
  });
});

module.exports = router;