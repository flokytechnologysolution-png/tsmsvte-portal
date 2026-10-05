/**
 * routes/chat.js — the AI assistant, human hand-over and the live admin chat.
 *
 * Flow:
 *   1. the bot answers ONLY from the knowledge base / FAQ / ministry settings;
 *   2. after 3 unhelpful exchanges, or when the user asks for a human, the
 *      bot offers to escalate;
 *   3. escalating opens a live chat when an administrator is online, and
 *      otherwise raises a ticket plus an in-portal notification (and an SMS
 *      when a live SMS provider is configured).
 *
 * WebSockets (lib/realtime.js) push updates to both sides; every endpoint
 * here also works by polling, so a blocked socket never breaks the chat.
 */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireRole, isAdminish } = require('../middleware/auth');
const { clean, toIntOrNull } = require('../middleware/validate');
const { chatLimiter, writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errors');
const ai = require('../lib/ai');
const sms = require('../lib/sms');
const realtime = require('../lib/realtime');

const router = express.Router();

const GUEST_COOKIE = 'tsmsvte_chat';
const ESCALATE_AFTER = 3;
const HUMAN_WORDS = ['human', 'agent', 'person', 'someone', 'officer', 'admin', 'speak to', 'talk to', 'real person', 'call me'];

function history(sessionId, limit) {
  const rows = db.prepare(
    'SELECT role, body FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
  ).all(sessionId, limit || 8);
  return rows.reverse();
}

function sessionView(row) {
  return {
    id: row.id,
    channel: row.channel,
    mode: row.mode,
    status: row.status,
    display_name: row.display_name,
    unanswered_count: row.unanswered_count,
    escalation_offered: row.escalation_offered,
    assigned_admin_id: row.assigned_admin_id,
    created_at: row.created_at,
    last_message_at: row.last_message_at
  };
}

function createSession(fields) {
  const info = db.prepare(
    `INSERT INTO chat_sessions (user_id, display_name, channel, mode, status)
     VALUES (?, ?, ?, 'bot', 'open')`
  ).run(fields.user_id || null, fields.display_name || 'Guest', fields.channel || 'public');
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(info.lastInsertRowid);
}

/* --- Staff sessions are tied to the signed-in user --------------------- */
function staffSession(user) {
  let row = db.prepare(
    "SELECT * FROM chat_sessions WHERE user_id = ? AND channel = 'staff' AND status != 'closed' ORDER BY id DESC LIMIT 1"
  ).get(user.id);
  if (!row) row = createSession({ user_id: user.id, display_name: user.full_name, channel: 'staff' });
  return row;
}

/* --- Public sessions live behind a signed cookie ----------------------- */
/* Resolves an existing guest session from the signed cookie. Returns null
 * when there is none — creating a database row is deferred to the first real
 * message so that opening the chat (or polling it) cannot be used to fill the
 * database with empty sessions. */
function findGuestSession(req) {
  const token = req.cookies && req.cookies[GUEST_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || '');
    return db.prepare(
      "SELECT * FROM chat_sessions WHERE id = ? AND channel = 'public' AND status != 'closed'"
    ).get(payload.sid) || null;
  } catch (err) {
    return null;   /* expired or tampered cookie: treat as a new visitor */
  }
}

function guestSession(req, res, create) {
  const existing = findGuestSession(req);
  if (existing) return existing;
  if (!create) return null;
  const row = createSession({ display_name: 'Visitor', channel: 'public' });
  const signed = jwt.sign({ sid: row.id }, process.env.JWT_SECRET || '', { expiresIn: '2d' });
  res.cookie(GUEST_COOKIE, signed, {
    httpOnly: true, sameSite: 'lax',
    secure: String(process.env.COOKIE_SECURE || '0') === '1',
    maxAge: 2 * 24 * 60 * 60 * 1000, path: '/'
  });
  return row;
}

/* create = true  -> always return a session, minting one if needed (first
 *                   real message / escalation).
 * create = false -> return null rather than minting (read-only endpoints). */
function pickSession(req, res, create) {
  if (req.user) return staffSession(req.user);
  return guestSession(req, res, create !== false);
}

/* ------------------------------- session ------------------------------- */
/* Rate limited and read-only: this endpoint no longer creates a database row,
 * so repeatedly opening the chat cannot inflate the sessions table. */
router.get('/session', chatLimiter, function (req, res) {
  const row = pickSession(req, res, false);
  const adminsOnline = realtime.onlineAdmins() > 0;
  res.json({
    session: row ? sessionView(row) : null,
    bot_enabled: db.getSetting('public_bot_enabled', '1') === '1',
    admin_online: adminsOnline,
    admin_status: db.getSetting('admin_chat_status', 'offline'),
    working_hours: db.getSetting('admin_working_hours'),
    notice: db.getSetting('faq_notice'),
    ai: ai.status()
  });
});

router.get('/messages', chatLimiter, function (req, res) {
  const row = pickSession(req, res, false);
  if (!row) {
    /* No conversation yet — an empty list, not a new row. */
    return res.json({ session: null, messages: [] });
  }
  const since = toIntOrNull(req.query.since) || 0;
  const rows = db.prepare(
    'SELECT id, role, body, created_at FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT 200'
  ).all(row.id, since);
  return res.json({ session: sessionView(row), messages: rows });
});

/* ------------------------------ messaging ------------------------------ */
function pushMessage(sessionId, role, body) {
  const info = db.prepare('INSERT INTO chat_messages (session_id, role, body) VALUES (?, ?, ?)')
    .run(sessionId, role, body);
  db.prepare("UPDATE chat_sessions SET last_message_at = datetime('now') WHERE id = ?").run(sessionId);
  return { id: info.lastInsertRowid, role: role, body: body, created_at: new Date().toISOString() };
}

router.post('/message', chatLimiter, asyncHandler(async function (req, res) {
  const session = pickSession(req, res);
  const text = clean(req.body.text).slice(0, 2000);
  if (!text) return res.status(422).json({ error: 'Type a message first.' });

  const userMsg = pushMessage(session.id, session.user_id ? 'user' : 'guest', text);
  realtime.sendToSession(session.id, { type: 'chat:message', sessionId: session.id, message: userMsg });

  /* A live conversation: hand the message straight to the administrators. */
  if (session.mode === 'live' && session.status !== 'closed') {
    realtime.sendToAdmins({
      type: 'chat:user', sessionId: session.id, name: session.display_name,
      body: text, at: userMsg.created_at, status: session.status
    });
    db.notifyRole(['OWNER', 'ADMIN'], 'Live chat message from ' + session.display_name, text, '/admin.html#chats');
    return res.json({
      ok: true, mode: 'live', status: session.status, reply: null,
      messages: [userMsg],
      note: session.status === 'waiting'
        ? 'An administrator has been notified and will join this conversation.'
        : 'Your message has been sent to the administrator you are chatting with.'
    });
  }

  if (db.getSetting('public_bot_enabled', '1') !== '1') {
    return res.json({
      ok: true, mode: 'bot', reply: null, messages: [userMsg], escalate: true,
      note: 'The assistant is switched off. Ask for a member of staff and I will connect you.'
    });
  }

  const hist = history(session.id, parseInt(process.env.AI_HISTORY_MESSAGES || '8', 10));
  const answer = await ai.ask({ question: text, history: hist.slice(0, -1) });

  const replyMsg = pushMessage(session.id, 'assistant', answer.text);
  realtime.sendToSession(session.id, { type: 'chat:message', sessionId: session.id, message: replyMsg });

  const wantsHuman = HUMAN_WORDS.some(function (w) { return text.toLowerCase().indexOf(w) !== -1; });
  const unanswered = answer.answered ? 0 : session.unanswered_count + 1;
  const escalate = wantsHuman || unanswered >= ESCALATE_AFTER;

  db.prepare('UPDATE chat_sessions SET unanswered_count = ?, escalation_offered = ? WHERE id = ?')
    .run(unanswered, escalate ? 1 : session.escalation_offered, session.id);

  return res.json({
    ok: true, mode: 'bot', reply: replyMsg, messages: [userMsg, replyMsg],
    session: sessionView(session),
    answered: answer.answered, source: answer.source, mocked: answer.mocked,
    escalate: escalate,
    admin_online: realtime.onlineAdmins() > 0,
    note: escalate ? 'Say the word and I will connect you to a member of staff.' : ''
  });
}), require('../middleware/validate').handleErrors);

/* ----------------------------- escalation ------------------------------ */
router.post('/escalate', chatLimiter, asyncHandler(async function (req, res) {
  const session = pickSession(req, res);
  const adminsOnline = realtime.onlineAdmins() > 0 || db.getSetting('admin_chat_status', 'offline') === 'online';
  const note = clean(req.body.note).slice(0, 500);
  const who = session.display_name;

  if (adminsOnline) {
    db.prepare("UPDATE chat_sessions SET mode = 'live', status = 'waiting', escalation_offered = 1 WHERE id = ?")
      .run(session.id);
    pushMessage(session.id, 'system', 'Connecting you to a member of staff. Please hold on.');
    realtime.sendToAdmins({
      type: 'chat:waiting', sessionId: session.id, name: who,
      body: note || 'A visitor is waiting to speak with staff.', at: new Date().toISOString()
    });
    db.notifyRole(['OWNER', 'ADMIN'], 'Chat waiting: ' + who, note || 'Waiting for an administrator.', '/admin.html#chats');
    return res.json({
      ok: true, mode: 'live', status: 'waiting',
      message: 'You are in the queue. A member of staff will join this chat shortly.'
    });
  }

  const info = db.prepare(
    'INSERT INTO tickets (user_id, session_id, subject, body) VALUES (?, ?, ?, ?)'
  ).run(session.user_id || null, session.id, 'Chat escalation from ' + who, note || 'No administrator was online.');
  db.prepare("UPDATE chat_sessions SET mode = 'live', status = 'waiting', ticket_id = ?, escalation_offered = 1 WHERE id = ?")
    .run(info.lastInsertRowid, session.id);
  pushMessage(session.id, 'system',
    'No member of staff is online right now, so a ticket has been created. You will be contacted inside the portal.');

  const admins = db.prepare(
    `SELECT u.id, u.full_name, s.phone FROM users u LEFT JOIN staff s ON s.user_id = u.id
     WHERE u.role IN ('OWNER', 'ADMIN') AND u.status = 'ACTIVE'`
  ).all();
  admins.forEach(function (a) {
    db.notify(a.id, 'New chat ticket #' + info.lastInsertRowid, who + ' asked for help.', '/admin.html#chats');
  });

  /* An SMS alert is only attempted with a real, configured provider. */
  let smsAlerts = 0;
  if (!sms.providerStatus().dryRun) {
    const numbers = admins.map(function (a) { return a.phone; }).filter(Boolean);
    if (numbers.length) {
      const result = await sms.sendBulk({
        recipients: numbers,
        message: 'TSMSVTE portal: ' + who + ' is waiting in the chat and no admin is online. Ticket #' + info.lastInsertRowid + '.'
        /* The sender ID is resolved inside lib/sms.js so the value approved on
         * the server (TERMII_SENDER_ID) is always the one used. */
      });
      smsAlerts = result.sent;
    }
  }

  realtime.sendToAdmins({ type: 'ticket:new', id: Number(info.lastInsertRowid), name: who });
  return res.json({
    ok: true, mode: 'live', status: 'waiting',
    ticket_id: Number(info.lastInsertRowid), sms_alerts: smsAlerts,
    message: 'A ticket has been created and the administrators have been notified. They will contact you inside the portal.'
  });
}), require('../middleware/validate').handleErrors);

/* ------------------------- admin: chat console ------------------------- */
const adminOnly = requireRole('ADMIN');

router.get('/admin/queue', adminOnly, function (req, res) {
  const rows = db.prepare(
    `SELECT c.*, u.email, u.mail_address,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = c.id) AS message_count,
      (SELECT body FROM chat_messages m WHERE m.session_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
     FROM chat_sessions c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.status IN ('waiting', 'live') ORDER BY
       CASE c.status WHEN 'waiting' THEN 0 ELSE 1 END, c.last_message_at ASC`
  ).all();
  const openTickets = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'").get().n;
  res.json({
    sessions: rows.map(function (r) {
      return Object.assign(sessionView(r), {
        email: r.email, mail_address: r.mail_address,
        message_count: r.message_count, last_message: r.last_message
      });
    }),
    open_tickets: openTickets,
    admin_status: db.getSetting('admin_chat_status', 'offline'),
    online_admins: realtime.onlineAdmins()
  });
});

router.get('/admin/session/:id([0-9]+)', adminOnly, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.prepare(
    'SELECT id, role, body, created_at FROM chat_messages WHERE session_id = ? ORDER BY id LIMIT 300'
  ).all(id);
  const user = row.user_id
    ? db.prepare('SELECT id, full_name, email, mail_address, role FROM users WHERE id = ?').get(row.user_id)
    : null;
  const staff = row.user_id
    ? db.prepare('SELECT rank, school_name, lga, phone FROM staff WHERE user_id = ?').get(row.user_id)
    : null;
  res.json({ session: sessionView(row), messages: messages, user: user, staff: staff });
});

router.post('/admin/session/:id([0-9]+)/reply', writeLimiter, adminOnly, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  const text = clean(req.body.text).slice(0, 2000);
  if (!text) return res.status(422).json({ error: 'Type your reply first.' });

  db.prepare("UPDATE chat_sessions SET mode = 'live', status = 'live', assigned_admin_id = COALESCE(assigned_admin_id, ?) WHERE id = ?")
    .run(req.user.id, id);
  const msg = pushMessage(id, 'admin', text);
  realtime.sendToSession(id, { type: 'chat:message', sessionId: id, message: msg });
  realtime.sendToAdmins({ type: 'chat:update', sessionId: id, status: 'live' });
  db.logAudit(req.user, 'chat.reply', 'chat_session', id, {}, req);
  return res.json({ ok: true, message: msg });
});

router.post('/admin/session/:id([0-9]+)/assign', writeLimiter, adminOnly, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  db.prepare("UPDATE chat_sessions SET assigned_admin_id = ?, mode = 'live', status = 'live' WHERE id = ?")
    .run(req.user.id, id);
  pushMessage(id, 'system', req.user.full_name + ' has joined the conversation.');
  realtime.sendToSession(id, { type: 'chat:assigned', sessionId: id, admin: req.user.full_name });
  db.logAudit(req.user, 'chat.assign', 'chat_session', id, {}, req);
  return res.json({ ok: true });
});

router.post('/admin/session/:id([0-9]+)/close', writeLimiter, adminOnly, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  db.prepare("UPDATE chat_sessions SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
  if (row.ticket_id) {
    db.prepare("UPDATE tickets SET status = 'closed', handled_by = ?, closed_at = datetime('now') WHERE id = ?")
      .run(req.user.id, row.ticket_id);
  }
  pushMessage(id, 'system', 'This conversation has been closed by ' + req.user.full_name + '.');
  realtime.sendToSession(id, { type: 'chat:closed', sessionId: id });
  db.logAudit(req.user, 'chat.close', 'chat_session', id, {}, req);
  return res.json({ ok: true });
});

router.post('/admin/availability', writeLimiter, adminOnly, function (req, res) {
  const status = String(req.body.status || '').toLowerCase() === 'online' ? 'online' : 'offline';
  db.setSetting('admin_chat_status', status);
  if (req.body.working_hours !== undefined) {
    db.setSetting('admin_working_hours', clean(req.body.working_hours).slice(0, 200));
  }
  db.logAudit(req.user, 'chat.availability', 'settings', '', { status: status }, req);
  realtime.sendToRoles(['OWNER', 'ADMIN'], { type: 'chat:availability', status: status });
  return res.json({ ok: true, status: status });
});

router.get('/admin/tickets', adminOnly, function (req, res) {
  const rows = db.prepare(
    `SELECT t.*, u.full_name AS user_name, u.email FROM tickets t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.status = ? ORDER BY t.id DESC LIMIT 100`
  ).all(req.query.status === 'closed' ? 'closed' : 'open');
  res.json({ tickets: rows });
});

router.post('/admin/tickets/:id([0-9]+)/close', writeLimiter, adminOnly, function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'Ticket not found' });
  db.prepare("UPDATE tickets SET status = 'closed', handled_by = ?, closed_at = datetime('now') WHERE id = ?")
    .run(req.user.id, id);
  db.logAudit(req.user, 'ticket.close', 'ticket', id, {}, req);
  return res.json({ ok: true });
});

module.exports = router;