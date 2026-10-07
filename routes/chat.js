/**
 * routes/chat.js — the AI assistant, human hand-over and the live admin chat.
 * Fully migrated to async/await for Universal PostgreSQL/SQLite support.
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

async function history(sessionId, limit) {
  const rows = await db.query(
    'SELECT role, body FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    [sessionId, limit || 8]
  );
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

async function createSession(fields) {
  const info = await db.run(
    `INSERT INTO chat_sessions (user_id, display_name, channel, mode, status)
     VALUES (?, ?, ?, 'bot', 'open')`,
    [fields.user_id || null, fields.display_name || 'Guest', fields.channel || 'public']
  );
  return await db.get('SELECT * FROM chat_sessions WHERE id = ?', [info.lastInsertRowid]);
}

/* --- Staff sessions are tied to the signed-in user --------------------- */
async function staffSession(user) {
  let row = await db.get(
    "SELECT * FROM chat_sessions WHERE user_id = ? AND channel = 'staff' AND status != 'closed' ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  if (!row) row = await createSession({ user_id: user.id, display_name: user.full_name, channel: 'staff' });
  return row;
}

/* --- Public sessions live behind a signed cookie ----------------------- */
async function findGuestSession(req) {
  const token = req.cookies && req.cookies[GUEST_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || '');
    return await db.get(
      "SELECT * FROM chat_sessions WHERE id = ? AND channel = 'public' AND status != 'closed'",
      [payload.sid]
    ) || null;
  } catch (err) {
    return null;
  }
}

async function guestSession(req, res, create) {
  const existing = await findGuestSession(req);
  if (existing) return existing;
  if (!create) return null;
  const row = await createSession({ display_name: 'Visitor', channel: 'public' });
  const signed = jwt.sign({ sid: row.id }, process.env.JWT_SECRET || '', { expiresIn: '2d' });
  res.cookie(GUEST_COOKIE, signed, {
    httpOnly: true, sameSite: 'lax',
    secure: String(process.env.COOKIE_SECURE || '0') === '1',
    maxAge: 2 * 24 * 60 * 60 * 1000, path: '/'
  });
  return row;
}

/* create = true  -> always return a session, minting one if needed.
 * create = false -> return null rather than minting (read-only endpoints). */
async function pickSession(req, res, create) {
  if (req.user) return await staffSession(req.user);
  return await guestSession(req, res, create !== false);
}

/* ------------------------------- session ------------------------------- */
router.get('/session', chatLimiter, asyncHandler(async function (req, res) {
  const row = await pickSession(req, res, false);
  const adminsOnline = realtime.onlineAdmins() > 0;
  res.json({
    session: row ? sessionView(row) : null,
    bot_enabled: await db.getSetting('public_bot_enabled', '1') === '1',
    admin_online: adminsOnline,
    admin_status: await db.getSetting('admin_chat_status', 'offline'),
    working_hours: await db.getSetting('admin_working_hours'),
    notice: await db.getSetting('faq_notice'),
    ai: ai.status()
  });
}));

router.get('/messages', chatLimiter, asyncHandler(async function (req, res) {
  const row = await pickSession(req, res, false);
  if (!row) {
    return res.json({ session: null, messages: [] });
  }
  const since = toIntOrNull(req.query.since) || 0;
  const rows = await db.query(
    'SELECT id, role, body, created_at FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT 200',
    [row.id, since]
  );
  return res.json({ session: sessionView(row), messages: rows });
}));

/* ------------------------------ messaging ------------------------------ */
async function pushMessage(sessionId, role, body) {
  const info = await db.run('INSERT INTO chat_messages (session_id, role, body) VALUES (?, ?, ?)',
    [sessionId, role, body]);
  await db.run("UPDATE chat_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
  return { id: info.lastInsertRowid, role: role, body: body, created_at: new Date().toISOString() };
}

router.post('/message', chatLimiter, asyncHandler(async function (req, res) {
  const session = await pickSession(req, res);
  const text = clean(req.body.text).slice(0, 2000);
  if (!text) return res.status(422).json({ error: 'Type a message first.' });

  const userMsg = await pushMessage(session.id, session.user_id ? 'user' : 'guest', text);
  realtime.sendToSession(session.id, { type: 'chat:message', sessionId: session.id, message: userMsg });

  /* A live conversation: hand the message straight to the administrators. */
  if (session.mode === 'live' && session.status !== 'closed') {
    realtime.sendToAdmins({
      type: 'chat:user', sessionId: session.id, name: session.display_name,
      body: text, at: userMsg.created_at, status: session.status
    });
    await db.notifyRole(['OWNER', 'ADMIN'], 'Live chat message from ' + session.display_name, text, '/admin.html#chats');
    return res.json({
      ok: true, mode: 'live', status: session.status, reply: null,
      messages: [userMsg],
      note: session.status === 'waiting'
        ? 'An administrator has been notified and will join this conversation.'
        : 'Your message has been sent to the administrator you are chatting with.'
    });
  }

  if (await db.getSetting('public_bot_enabled', '1') !== '1') {
    return res.json({
      ok: true, mode: 'bot', reply: null, messages: [userMsg], escalate: true,
      note: 'The assistant is switched off. Ask for a member of staff and I will connect you.'
    });
  }

  const hist = await history(session.id, parseInt(process.env.AI_HISTORY_MESSAGES || '8', 10));
  const answer = await ai.ask({ question: text, history: hist.slice(0, -1) });

  const replyMsg = await pushMessage(session.id, 'assistant', answer.text);
  realtime.sendToSession(session.id, { type: 'chat:message', sessionId: session.id, message: replyMsg });

  const wantsHuman = HUMAN_WORDS.some(function (w) { return text.toLowerCase().indexOf(w) !== -1; });
  const unanswered = answer.answered ? 0 : session.unanswered_count + 1;
  const escalate = wantsHuman || unanswered >= ESCALATE_AFTER;

  await db.run('UPDATE chat_sessions SET unanswered_count = ?, escalation_offered = ? WHERE id = ?',
    [unanswered, escalate ? 1 : session.escalation_offered, session.id]);

  return res.json({
    ok: true, mode: 'bot', reply: replyMsg, messages: [userMsg, replyMsg],
    session: sessionView(session),
    answered: answer.answered, source: answer.source, mocked: answer.mocked,
    escalate: escalate,
    admin_online: realtime.onlineAdmins() > 0,
    note: escalate ? 'Say the word and I will connect you to a member of staff.' : ''
  });
}));

/* ----------------------------- escalation ------------------------------ */
router.post('/escalate', chatLimiter, asyncHandler(async function (req, res) {
  const session = await pickSession(req, res);
  const adminStatus = await db.getSetting('admin_chat_status', 'offline');
  const adminsOnline = realtime.onlineAdmins() > 0 || adminStatus === 'online';
  const note = clean(req.body.note).slice(0, 500);
  const who = session.display_name;

  if (adminsOnline) {
    await db.run("UPDATE chat_sessions SET mode = 'live', status = 'waiting', escalation_offered = 1 WHERE id = ?",
      [session.id]);
    await pushMessage(session.id, 'system', 'Connecting you to a member of staff. Please hold on.');
    realtime.sendToAdmins({
      type: 'chat:waiting', sessionId: session.id, name: who,
      body: note || 'A visitor is waiting to speak with staff.', at: new Date().toISOString()
    });
    await db.notifyRole(['OWNER', 'ADMIN'], 'Chat waiting: ' + who, note || 'Waiting for an administrator.', '/admin.html#chats');
    return res.json({
      ok: true, mode: 'live', status: 'waiting',
      message: 'You are in the queue. A member of staff will join this chat shortly.'
    });
  }

  const info = await db.run(
    'INSERT INTO tickets (user_id, session_id, subject, body) VALUES (?, ?, ?, ?)',
    [session.user_id || null, session.id, 'Chat escalation from ' + who, note || 'No administrator was online.']
  );
  await db.run("UPDATE chat_sessions SET mode = 'live', status = 'waiting', ticket_id = ?, escalation_offered = 1 WHERE id = ?",
    [info.lastInsertRowid, session.id]);
  await pushMessage(session.id, 'system',
    'No member of staff is online right now, so a ticket has been created. You will be contacted inside the portal.');

  const admins = await db.query(
    `SELECT u.id, u.full_name, s.phone FROM users u LEFT JOIN staff s ON s.user_id = u.id
     WHERE u.role IN ('OWNER', 'ADMIN') AND u.status = 'ACTIVE'`
  );
  
  for (const a of admins) {
    await db.notify(a.id, 'New chat ticket #' + info.lastInsertRowid, who + ' asked for help.', '/admin.html#chats');
  }

  /* An SMS alert is only attempted with a real, configured provider. */
  let smsAlerts = 0;
  if (!sms.providerStatus().dryRun) {
    const numbers = admins.map(function (a) { return a.phone; }).filter(Boolean);
    if (numbers.length) {
      const result = await sms.sendBulk({
        recipients: numbers,
        message: 'TSMSVTE portal: ' + who + ' is waiting in the chat and no admin is online. Ticket #' + info.lastInsertRowid + '.'
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
}));

/* ------------------------- admin: chat console ------------------------- */
const adminOnly = requireRole('ADMIN');

router.get('/admin/queue', adminOnly, asyncHandler(async function (req, res) {
  const rows = await db.query(
    `SELECT c.*, u.email, u.mail_address,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = c.id) AS message_count,
      (SELECT body FROM chat_messages m WHERE m.session_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
     FROM chat_sessions c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.status IN ('waiting', 'live') ORDER BY
       CASE c.status WHEN 'waiting' THEN 0 ELSE 1 END, c.last_message_at ASC`
  );
  const openTicketsRow = await db.get("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'");
  const openTickets = openTicketsRow ? openTicketsRow.n : 0;
  
  res.json({
    sessions: rows.map(function (r) {
      return Object.assign(sessionView(r), {
        email: r.email, mail_address: r.mail_address,
        message_count: r.message_count, last_message: r.last_message
      });
    }),
    open_tickets: openTickets,
    admin_status: await db.getSetting('admin_chat_status', 'offline'),
    online_admins: realtime.onlineAdmins()
  });
}));

router.get('/admin/session/:id([0-9]+)', adminOnly, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM chat_sessions WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  
  const messages = await db.query(
    'SELECT id, role, body, created_at FROM chat_messages WHERE session_id = ? ORDER BY id LIMIT 300',
    [id]
  );
  
  const user = row.user_id
    ? await db.get('SELECT id, full_name, email, mail_address, role FROM users WHERE id = ?', [row.user_id])
    : null;
  const staff = row.user_id
    ? await db.get('SELECT rank, school_name, lga, phone FROM staff WHERE user_id = ?', [row.user_id])
    : null;
  
  res.json({ session: sessionView(row), messages: messages, user: user, staff: staff });
}));

router.post('/admin/session/:id([0-9]+)/reply', writeLimiter, adminOnly, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM chat_sessions WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  const text = clean(req.body.text).slice(0, 2000);
  if (!text) return res.status(422).json({ error: 'Type your reply first.' });

  await db.run("UPDATE chat_sessions SET mode = 'live', status = 'live', assigned_admin_id = COALESCE(assigned_admin_id, ?) WHERE id = ?",
    [req.user.id, id]);
  const msg = await pushMessage(id, 'admin', text);
  realtime.sendToSession(id, { type: 'chat:message', sessionId: id, message: msg });
  realtime.sendToAdmins({ type: 'chat:update', sessionId: id, status: 'live' });
  await db.logAudit(req.user, 'chat.reply', 'chat_session', id, {}, req);
  return res.json({ ok: true, message: msg });
}));

router.post('/admin/session/:id([0-9]+)/assign', writeLimiter, adminOnly, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM chat_sessions WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  
  await db.run("UPDATE chat_sessions SET assigned_admin_id = ?, mode = 'live', status = 'live' WHERE id = ?",
    [req.user.id, id]);
  await pushMessage(id, 'system', req.user.full_name + ' has joined the conversation.');
  realtime.sendToSession(id, { type: 'chat:assigned', sessionId: id, admin: req.user.full_name });
  await db.logAudit(req.user, 'chat.assign', 'chat_session', id, {}, req);
  return res.json({ ok: true });
}));

router.post('/admin/session/:id([0-9]+)/close', writeLimiter, adminOnly, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM chat_sessions WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Conversation not found' });
  
  await db.run("UPDATE chat_sessions SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  if (row.ticket_id) {
    await db.run("UPDATE tickets SET status = 'closed', handled_by = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [req.user.id, row.ticket_id]);
  }
  await pushMessage(id, 'system', 'This conversation has been closed by ' + req.user.full_name + '.');
  realtime.sendToSession(id, { type: 'chat:closed', sessionId: id });
  await db.logAudit(req.user, 'chat.close', 'chat_session', id, {}, req);
  return res.json({ ok: true });
}));

router.post('/admin/availability', writeLimiter, adminOnly, asyncHandler(async function (req, res) {
  const status = String(req.body.status || '').toLowerCase() === 'online' ? 'online' : 'offline';
  await db.setSetting('admin_chat_status', status);
  if (req.body.working_hours !== undefined) {
    await db.setSetting('admin_working_hours', clean(req.body.working_hours).slice(0, 200));
  }
  await db.logAudit(req.user, 'chat.availability', 'settings', '', { status: status }, req);
  realtime.sendToRoles(['OWNER', 'ADMIN'], { type: 'chat:availability', status: status });
  return res.json({ ok: true, status: status });
}));

router.get('/admin/tickets', adminOnly, asyncHandler(async function (req, res) {
  const status = req.query.status === 'closed' ? 'closed' : 'open';
  const rows = await db.query(
    `SELECT t.*, u.full_name AS user_name, u.email FROM tickets t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.status = ? ORDER BY t.id DESC LIMIT 100`,
    [status]
  );
  res.json({ tickets: rows });
}));

router.post('/admin/tickets/:id([0-9]+)/close', writeLimiter, adminOnly, asyncHandler(async function (req, res) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM tickets WHERE id = ?', [id]) : null;
  if (!row) return res.status(404).json({ error: 'Ticket not found' });
  
  await db.run("UPDATE tickets SET status = 'closed', handled_by = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [req.user.id, id]);
  await db.logAudit(req.user, 'ticket.close', 'ticket', id, {}, req);
  return res.json({ ok: true });
}));

module.exports = router;