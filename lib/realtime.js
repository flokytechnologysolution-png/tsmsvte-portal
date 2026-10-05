/**
 * lib/realtime.js — lightweight WebSocket hub (ws) with a polling fallback.
 *
 * The chat UI always has the polling endpoints available (routes/chat.js),
 * so if a phone or office network blocks WebSockets the portal still works.
 * The socket is therefore a speed-up, never a requirement.
 */
'use strict';

const jwt = require('jsonwebtoken');

let wss = null;
const clients = new Map();   // ws -> { userId, role, sessionId, channel }

function attach(server) {
  const { WebSocketServer } = require('ws');
  wss = new WebSocketServer({ server: server, path: '/ws' });

  wss.on('connection', function (ws, req) {
    let meta = { userId: null, role: 'PUBLIC', sessionId: null, channel: 'public' };
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const sessionId = parseInt(url.searchParams.get('session') || '0', 10);
      if (token) {
        const payload = jwt.verify(token, process.env.JWT_SECRET || '');
        meta.userId = payload.sub;
        meta.role = payload.role;
        meta.channel = 'staff';
      }
      if (sessionId) meta.sessionId = sessionId;
      if (!meta.userId && !meta.sessionId) { ws.close(1008, 'authentication required'); return; }
    } catch (err) {
      ws.close(1008, 'invalid token');
      return;
    }

    clients.set(ws, meta);
    ws.isAlive = true;
    ws.on('pong', function () { ws.isAlive = true; });
    ws.on('message', function (raw) {
      /* Clients only send keep-alives; all writes go through the REST API
       * so that validation, rate limiting and audit logging always apply. */
      try {
        const msg = JSON.parse(String(raw).slice(0, 200));
        if (msg && msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      } catch (e) { /* ignore malformed frames */ }
    });
    ws.on('close', function () { clients.delete(ws); });

    ws.send(JSON.stringify({ type: 'ready', channel: meta.channel }));
  });

  const interval = setInterval(function () {
    if (!wss) return;
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* noop */ }
    });
  }, 30000);
  interval.unref();

  return wss;
}

function safeSend(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  } catch (err) { /* noop */ }
}

function sendToUser(userId, payload) {
  if (!userId) return 0;
  let n = 0;
  clients.forEach(function (meta, ws) {
    if (meta.userId === userId) { safeSend(ws, payload); n += 1; }
  });
  return n;
}

function sendToSession(sessionId, payload) {
  if (!sessionId) return 0;
  let n = 0;
  clients.forEach(function (meta, ws) {
    if (meta.sessionId === sessionId) { safeSend(ws, payload); n += 1; }
  });
  return n;
}

function sendToRoles(roles, payload) {
  const wanted = Array.isArray(roles) ? roles : [roles];
  let n = 0;
  clients.forEach(function (meta, ws) {
    if (wanted.indexOf(meta.role) !== -1) { safeSend(ws, payload); n += 1; }
  });
  return n;
}

function sendToAdmins(payload) {
  return sendToRoles(['OWNER', 'ADMIN'], payload);
}

/** How many administrators currently have a live socket (used to decide
 *  whether a chat can be handed over immediately or must become a ticket). */
function onlineAdmins() {
  let n = 0;
  clients.forEach(function (meta) {
    if (meta.role === 'OWNER' || meta.role === 'ADMIN') n += 1;
  });
  return n;
}

function onlineUsers() {
  const seen = {};
  clients.forEach(function (meta) { if (meta.userId) seen[meta.userId] = true; });
  return Object.keys(seen).length;
}

function stats() {
  let staff = 0;
  clients.forEach(function (meta) {
    if (meta.channel === 'staff') staff += 1;
  });
  return { sockets: clients.size, staff: staff };
}

module.exports = {
  attach: attach,
  sendToUser: sendToUser,
  sendToSession: sendToSession,
  sendToRoles: sendToRoles,
  sendToAdmins: sendToAdmins,
  onlineAdmins: onlineAdmins,
  onlineUsers: onlineUsers,
  stats: stats
};