/**
 * lib/mailer.js — mail adapter interface.
 *
 * IMPORTANT: the portal's mail is INTERNAL mail between portal users only.
 * It is not internet email.  Message rows are written to the database by
 * routes/mail.js; this module exists so that a real SMTP bridge (nodemailer,
 * a transactional API, or a mail relay on the ministry server) can be
 * plugged in later WITHOUT touching the mail routes.
 *
 * An adapter is any object with:
 *   name                 : string
 *   canDeliverExternal() : boolean   -> can it reach real internet inboxes?
 *   deliver({to,cc,subject,text,attachments,headers}) : Promise<{ok,id,detail}>
 */
'use strict';

require('dotenv').config();

/* ------------------------------------------------------------------ *
 * 1. Internal adapter — always available, always the default.
 *    Delivery means "a row was inserted in message_recipients", which
 *    routes/mail.js does itself.  deliver() is therefore a no-op that
 *    reports success so callers have a uniform API.
 * ------------------------------------------------------------------ */
const internalAdapter = {
  name: 'internal',
  canDeliverExternal: function () { return false; },
  deliver: async function () {
    return { ok: true, id: '', detail: 'delivered to the internal portal mailbox' };
  }
};

/* ------------------------------------------------------------------ *
 * 2. SMTP bridge — only active when SMTP_HOST is configured.
 *    The portal does not depend on nodemailer (kept out of the lean
 *    dependency list); see HANDOVER.md for how to enable it.
 * ------------------------------------------------------------------ */
const smtpAdapter = {
  name: 'smtp',
  canDeliverExternal: function () { return Boolean(String(process.env.SMTP_HOST || '').trim()); },
  deliver: async function () {
    throw new Error(
      'SMTP bridge is enabled but no SMTP client is installed. ' +
      'Install a mailer (for example nodemailer) and implement smtpAdapter.deliver() in lib/mailer.js. ' +
      'Portal mail remains internal until then.'
    );
  }
};

function getMailAdapter() {
  if (smtpAdapter.canDeliverExternal()) return smtpAdapter;
  return internalAdapter;
}

function mailStatus() {
  const adapter = getMailAdapter();
  return {
    adapter: adapter.name,
    external: adapter.canDeliverExternal(),
    note: adapter.canDeliverExternal()
      ? 'SMTP bridge selected (see HANDOVER.md to finish wiring it).'
      : 'Internal portal mail only — messages stay inside the portal. This is NOT internet email.'
  };
}

module.exports = {
  getMailAdapter: getMailAdapter,
  mailStatus: mailStatus,
  internalAdapter: internalAdapter,
  smtpAdapter: smtpAdapter
};