/**
 * lib/sms.js — pluggable bulk-SMS provider adapters.
 *
 * Default adapter: Termii.  The interface is deliberately tiny so
 * Africa's Talking or BulkSMSNigeria can be added later by writing one
 * more object with a `send()` method and registering it below.
 *
 * Default adapter: Termii.  The interface is deliberately tiny so another
 * provider can be added later by writing one more object with a `send()`
 * method and registering it below.
 *
 * When no API key is configured the portal runs in DRY-RUN mode: every
 * message is logged as if sent, but no provider API is ever called.
 *
 * Termii's /sms/send accepts up to 100 numbers per request, passed as an
 * array in `to`, so we send in batches of BATCH_SIZE rather than one HTTP
 * request per recipient.
 */
'use strict';

require('dotenv').config();

const db = require('../db');

const DRY_RUN_ENV = String(process.env.SMS_DRY_RUN || '').trim() === '1';
const TERMII_KEY = String(process.env.TERMII_API_KEY || '').trim();
const TERMII_BASE = (process.env.TERMII_BASE_URL || 'https://api.ng.termii.com/api').replace(/\/+$/, '');

/** Termii's documented per-request recipient limit. */
const BATCH_SIZE = 100;
/** Every provider request is abandoned after this long. */
const REQUEST_TIMEOUT_MS = 10000;
/** How many times a TRANSIENT failure (network, timeout, 5xx, 429) is retried. */
const MAX_RETRIES = 2;
const MAX_LENGTH = 480;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/** A 401/403 stops the whole send at once rather than failing every recipient. */
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

/** Worth trying again: network error, timeout, 5xx or 429 (slow down). */
function isTransient(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/* ------------------------------------------------------------------ *
 * Sender ID resolution
 *
 * The sender ID is a SERVER-LEVEL fact: it has to match exactly what Termii
 * approved for this account.  If a value typed in Admin, Site settings could
 * silently override the approved one, every send would be rejected and the
 * administrator would have no idea why.  So the environment always wins:
 *
 *   1. TERMII_SENDER_ID   (the approved one — set this on the server)
 *   2. SMS_SENDER_ID      (older deployments still use this name)
 *   3. sms_sender_id      (the site setting, used only as a fallback)
 * ------------------------------------------------------------------ */
function senderIdSource() {
  if (String(process.env.TERMII_SENDER_ID || '').trim()) return 'env';
  if (String(process.env.SMS_SENDER_ID || '').trim()) return 'env';
  return 'setting';
}

function resolveSenderId() {
  return String(process.env.TERMII_SENDER_ID || '').trim() ||
    String(process.env.SMS_SENDER_ID || '').trim() ||
    db.getSetting('sms_sender_id', '') ||
    'TSMSVTE';
}

/** The message channel, so support can be asked to move us to 'dnd'. */
function resolveChannel() {
  return String(process.env.TERMII_CHANNEL || '').trim() || 'generic';
}

function normalisePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.indexOf('+') === 0) return p;
  if (p.indexOf('234') === 0 && p.length >= 13) return '+' + p;
  if (p.indexOf('0') === 0 && p.length === 11) return '+234' + p.slice(1);
  if (p.length === 10) return '+234' + p;
  return p;
}

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */
const providers = {};

providers.termii = {
  name: 'termii',
  requiresKey: true,
  configured: function () { return Boolean(TERMII_KEY); },

  /* One batch of up to BATCH_SIZE recipients.  `opts.to` is an ARRAY. */
  send: async function (opts) {
    if (!TERMII_KEY) throw fatalError('TERMII_API_KEY is not set on the server.');

    const to = Array.isArray(opts.to) ? opts.to : [opts.to];
    if (!to.length) return { ok: true, status: 'sent', id: '', detail: 'nothing to send' };

    const body = {
      to: to,
      from: opts.senderId,
      sms: opts.message,
      type: 'plain',
      channel: resolveChannel(),
      api_key: TERMII_KEY
    };

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(TERMII_BASE + '/sms/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (err) {
        /* Network failure or our own timeout: always worth retrying. */
        lastError = new Error(err && err.name === 'AbortError'
          ? 'The SMS provider did not respond within ' + (REQUEST_TIMEOUT_MS / 1000) + ' seconds.'
          : 'Could not reach the SMS provider: ' + err.message);
        lastError.transient = true;
        if (attempt < MAX_RETRIES) { await sleep(backoffMs(attempt, null)); continue; }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }

      if (res.ok) {
        /* Termii returns one message_id per batch; ids are returned per
         * recipient as `batchId#index` so nothing is silently lost. */
        const batchId = (json && (json.message_id || json.messageId)) || '';
        const errs = json && Array.isArray(json.errors) ? json.errors : null;
        return {
          ok: true,
          status: 'sent',
          id: batchId,
          perRecipient: to.map(function (n, i) {
            const e = errs && errs[i];
            if (e) return { ok: false, error: typeof e === 'string' ? e : (e.message || 'rejected by provider') };
            return { ok: true, id: batchId ? batchId + '#' + (i + 1) : '' };
          }),
          detail: (json && json.message) || ('accepted by Termii (' + to.length + ' recipient(s))')
        };
      }

      /* Bad credentials: every further request would fail the same way. */
      if (res.status === 401 || res.status === 403) {
        const why = (json && (json.message || json.error)) || '';
        const base = 'Termii rejected the API key (HTTP ' + res.status +
          '). Check TERMII_API_KEY on the server.';
        throw fatalError(why ? base + ' ' + why : base);
      }

      const msg = (json && (json.message || json.error)) || ('HTTP ' + res.status);
      lastError = new Error('Termii rejected the message: ' + msg);
      lastError.providerStatus = res.status;
      lastError.transient = isTransient(res.status);

      /* 4xx (other than 401/403) is a permanent problem: do not retry. */
      if (!lastError.transient) throw lastError;

      if (attempt < MAX_RETRIES) { await sleep(backoffMs(attempt, res.headers.get('retry-after'))); continue; }
      throw lastError;
    }
    throw lastError || new Error('The SMS provider could not be reached.');
  }
};

/** Backoff: 1s, 2s, ... honouring Retry-After (seconds or a date) when given. */
function backoffMs(attempt, retryAfter) {
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, 30000);
    const when = Date.parse(retryAfter);
    if (!isNaN(when)) return Math.min(Math.max(when - Date.now(), 1000), 30000);
  }
  return 1000 * Math.pow(2, attempt);
}

/* ------------------------------------------------------------------ *
 * Segment maths
 *
 * GSM-7 packs 160 characters in one message, 153 once it has to be split
 * (and the UDH header eats 7 characters per part).  Anything outside GSM-7
 * forces the Unicode alphabet: 70 / 67 per part.
 * ------------------------------------------------------------------ */

/** The GSM-7 basic character set (what a normal English message uses). */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  '^{}\\[~]|€';

const GSM7_SET = new Set(GSM7_BASIC.split(''));
const GSM7_EXTENDED = new Set('^{}\\[~]|€\n\r'.split(''));

/** True when every character can travel over plain GSM-7. */
function isGsm7(text) {
  for (const ch of String(text)) {
    if (!GSM7_SET.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/**
 * How many SMS segments a message costs.
 * @returns {{segments:number, encoding:string, charsPerSegment:number, length:number}}
 */
function segmentInfo(message) {
  const text = String(message === undefined || message === null ? '' : message);
  const gsm = isGsm7(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const length = text.length;
  const segments = length === 0 ? 0 : (length <= single ? 1 : Math.ceil(length / multi));
  return {
    segments: segments,
    encoding: gsm ? 'GSM-7' : 'Unicode',
    charsPerSegment: length <= single ? single : multi,
    single: length <= single,
    length: length
  };
}

/* Placeholders — deliberately not implemented so the portal never
 * pretends to send through a provider that is not wired up yet.
 * `implemented: false` lets the admin UI reject them at SELECTION time
 * with a clear message instead of failing halfway through a send. */
function stubProvider(name, label) {
  return {
    name: name,
    label: label,
    requiresKey: true,
    implemented: false,
    configured: function () { return false; },
    send: async function () {
      throw fatalError('Provider not implemented yet; use Termii.');
    }
  };
}

providers['africastalking'] = stubProvider('africastalking', "Africa's Talking");
providers['bulksmsnigeria'] = stubProvider('bulksmsnigeria', 'BulkSMSNigeria');

providers.termii.implemented = true;
providers['dry-run'] = {
  name: 'dry-run',
  requiresKey: false,
  implemented: true,
  configured: function () { return true; },
  send: async function (opts) {
    const to = Array.isArray(opts.to) ? opts.to : [opts.to];
    return {
      ok: true,
      id: 'DRYRUN-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      status: 'dry_run',
      perRecipient: to.map(function (n, i) { return { ok: true, id: 'DRYRUN#' + (i + 1) }; }),
      detail: 'DRY-RUN: no SMS provider was contacted (' + to.length + ' recipient(s))'
    };
  }
};

function getProvider(name) {
  return providers[name] || providers.termii;
}

function providerStatus() {
  const name = process.env.SMS_PROVIDER || 'termii';
  const adapter = getProvider(name);
  const live = Boolean(adapter.configured()) && !DRY_RUN_ENV;
  return {
    provider: name,
    senderId: resolveSenderId(),
    senderIdSource: senderIdSource(),
    channel: resolveChannel(),
    dryRun: !live,
    /* A stub is never "just dry-run": it is a configuration mistake. */
    implemented: adapter.implemented !== false,
    reason: live ? 'live'
      : (DRY_RUN_ENV ? 'SMS_DRY_RUN=1' : 'no API key configured')
  };
}

/** Throws an admin-facing error if the chosen provider cannot be used. */
function assertProviderUsable(name) {
  const adapter = getProvider(name);
  if (adapter.implemented === false) {
    throw fatalError('Provider not implemented yet; use Termii.');
  }
  return adapter;
}

/**
 * Send the same message to many numbers in batched provider requests.
 *
 * Recipients are normalised and de-duplicated first, then split into groups
 * of at most BATCH_SIZE (Termii's documented per-request limit).  One failed
 * batch is recorded and the rest still go out; a fatal error (bad API key)
 * stops everything immediately.
 *
 * @returns {Promise<{sent:number,failed:number,results:Array,batches:number,invalid:Array,fatal:Error|null}>}
 */
async function sendBulk(opts) {
  const rawList = opts.recipients || [];

  /* Normalise, report anything unusable, and de-duplicate. */
  const invalid = [];
  const seen = new Set();
  const unique = [];
  rawList.forEach(function (r) {
    const phone = normalisePhone(r);
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      invalid.push({ to: String(r || ''), error: 'not a usable Nigerian mobile number' });
      return;
    }
    if (seen.has(phone)) return;          /* duplicate: send once only */
    seen.add(phone);
    unique.push(phone);
  });

  const status = providerStatus();
  /* The environment (the approved sender ID) always wins over the setting. */
  const senderId = resolveSenderId();

  let adapter;
  try {
    adapter = status.dryRun
      ? providers['dry-run']
      : assertProviderUsable(opts.provider || status.provider);
  } catch (err) {
    /* Stub provider: report every recipient as failed with one clear reason. */
    return {
      sent: 0,
      failed: unique.length,
      results: unique.map(function (to) { return { to: to, ok: false, error: err.message }; }),
      batches: 0,
      invalid: invalid,
      provider: (opts.provider || status.provider),
      senderId: senderId,
      dryRun: false,
      fatal: err
    };
  }

  const results = [];
  let batches = 0;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    batches += 1;
    try {
      /* One HTTP request for up to BATCH_SIZE recipients. */
      const r = await adapter.send({
        to: batch, message: opts.message, senderId: senderId, channel: resolveChannel()
      });
      const per = Array.isArray(r.perRecipient) ? r.perRecipient : [];
      batch.forEach(function (to, idx) {
        const one = per[idx] || { ok: true, id: r.id };
        results.push({
          to: to,
          ok: one.ok !== false,
          id: one.id || r.id || '',
          status: one.ok === false ? 'failed' : (r.status || 'sent'),
          error: one.error || '',
          detail: r.detail || '',
          batch: batches
        });
      });
    } catch (err) {
      /* A bad API key stops the whole send; anything else only fails this batch. */
      if (err && err.fatal) {
        results.push.apply(results, unique.slice(i).map(function (to) {
          return { to: to, ok: false, status: 'failed', error: err.message, batch: batches };
        }));
        const sent = results.filter(function (x) { return x.ok; }).length;
        return {
          sent: sent, failed: results.length - sent, results: results, batches: batches,
          invalid: invalid, provider: adapter.name, senderId: senderId,
          dryRun: status.dryRun, fatal: err
        };
      }
      batch.forEach(function (to) {
        results.push({ to: to, ok: false, status: 'failed', error: err.message, batch: batches });
      });
    }
    /* Be a polite API citizen between batches. */
    if (i + BATCH_SIZE < unique.length) await sleep(250);
  }

  const sent = results.filter(function (r) { return r.ok; }).length;
  return {
    sent: sent,
    failed: results.length - sent,
    results: results,
    batches: batches,
    invalid: invalid,
    provider: adapter.name,
    senderId: senderId,
    dryRun: status.dryRun,
    fatal: null
  };
}

module.exports = {
  sendBulk: sendBulk,
  providerStatus: providerStatus,
  assertProviderUsable: assertProviderUsable,
  getProvider: getProvider,
  providers: providers,
  normalisePhone: normalisePhone,
  resolveSenderId: resolveSenderId,
  senderIdSource: senderIdSource,
  resolveChannel: resolveChannel,
  segmentInfo: segmentInfo,
  isGsm7: isGsm7,
  MAX_LENGTH: MAX_LENGTH,
  BATCH_SIZE: BATCH_SIZE,
  REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  MAX_RETRIES: MAX_RETRIES
};