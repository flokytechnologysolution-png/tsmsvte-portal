/**
 * public/js/chat.js — the floating assistant widget.
 *
 * Talks to /api/chat/* ; opens a WebSocket for instant replies and always
 * keeps a polling fallback running, because office networks here regularly
 * block WebSockets.  Nothing breaks if the socket never connects.
 */
(function () {
  'use strict';

  let panel = null, msgs = null, input = null, escBar = null;
  let session = null, since = 0, ws = null, pollTimer = null;
  let opened = false, sending = false, escalated = false, sessionKey = '';

  function ensureFab() {
    if (document.getElementById('chat-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'chat-fab';
    fab.className = 'chat-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Open help chat');
    fab.title = 'Help chat';
    fab.textContent = '\u{1F4AC}';
    fab.addEventListener('click', toggle);
    document.body.appendChild(fab);
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.className = 'chat-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ministry help chat');
    panel.innerHTML =
      '<header>' +
        '<div><div class="title">Ministry assistant</div><div class="status" id="chat-status">Connecting…</div></div>' +
        '<button type="button" id="chat-close" aria-label="Close chat">&times;</button>' +
      '</header>' +
      '<div class="chat-notice hidden" id="chat-notice"></div>' +
      '<div class="chat-msgs" id="chat-msgs" aria-live="polite"></div>' +
      '<div class="chat-escalate hidden" id="chat-escalate">' +
        '<span>Not finding what you need?</span>' +
        '<button class="btn btn-sm btn-warn" type="button" id="chat-human">Talk to staff</button>' +
      '</div>' +
      '<form class="chat-input" id="chat-form">' +
        '<input type="text" id="chat-text" placeholder="Type your question…" autocomplete="off" maxlength="2000" aria-label="Message">' +
        '<button type="submit" aria-label="Send">&#10148;</button>' +
      '</form>';
    document.body.appendChild(panel);

    msgs = document.getElementById('chat-msgs');
    input = document.getElementById('chat-text');
    document.getElementById('chat-close').addEventListener('click', close);
    document.getElementById('chat-form').addEventListener('submit', onSend);
    document.getElementById('chat-human').addEventListener('click', onEscalate);
    return panel;
  }

  function toggle() { opened ? close() : open(); }

  function open() {
    ensurePanel();
    opened = true;
    panel.classList.remove('hidden');
    input.focus();
    if (!session) {
      /* A brand-new visitor gets session: null — no database row is created
       * until they actually send a message. */
      App.api('/api/chat/session').then(function (data) {
        session = data.session;
        sessionKey = session ? String(session.id) : '';
        renderMeta(data);
        if (session) {
          loadMessages(true).then(connectSocket);
        } else {
          msgs.innerHTML = '';
          addMsg('assistant', 'Hello! Ask me anything about the ministry, the portal or Taraba State schools. ' +
            'I answer only from the published knowledge base — for anything else I will connect you to staff.');
          startPolling();
        }
      }).catch(function () {
        document.getElementById('chat-status').textContent = 'Chat unavailable';
        addMsg('system', 'The chat service is temporarily unavailable. Please try again shortly.');
      });
    } else {
      startPolling();
    }
  }

  function close() {
    opened = false;
    if (panel) panel.classList.add('hidden');
    stopPolling();
    if (ws) { try { ws.close(); } catch (e) { /* noop */ } ws = null; }
  }

  function renderMeta(data) {
    const status = document.getElementById('chat-status');
    const notice = document.getElementById('chat-notice');
    if (status) {
      status.textContent = data.admin_online
        ? 'Staff online now'
        : 'Assistant online' + (data.working_hours ? ' · ' + data.working_hours : '');
    }
    if (notice) {
      if (data.notice) { notice.textContent = data.notice; notice.classList.remove('hidden'); }
      else notice.classList.add('hidden');
    }
    if (data.session && (data.session.status === 'live' || data.session.status === 'waiting')) {
      escalated = true;
      showEscalateBar(data.session.status === 'waiting'
        ? 'Waiting for staff to join…'
        : 'Live conversation');
    }
  }

  function showEscalateBar(text) {
    escBar = document.getElementById('chat-escalate');
    if (!escBar) return;
    const span = escBar.querySelector('span');
    const btn = document.getElementById('chat-human');
    if (text) {
      span.textContent = text;
      if (btn) btn.classList.add('hidden');
    } else if (btn) {
      btn.classList.remove('hidden');
    }
    escBar.classList.remove('hidden');
  }

  function addMsg(role, body, id) {
    if (!msgs) return null;
    if (id && msgs.querySelector('[data-id="' + id + '"]')) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg ' + role;
    el.textContent = String(body || '');
    if (id) el.setAttribute('data-id', id);
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  function loadMessages(initial) {
    return App.api('/api/chat/messages?since=' + since).then(function (data) {
      if (initial) {
        session = data.session;
        msgs.innerHTML = '';
      }
      if (data.session) session = data.session;
      (data.messages || []).forEach(function (m) {
        since = Math.max(since, m.id);
        addMsg(m.role, m.body, m.id);
      });
      if (initial && !(data.messages || []).length) {
        addMsg('assistant', 'Hello! Ask me anything about the ministry, the portal or Taraba State schools. ' +
          'I answer only from the published knowledge base — for anything else I will connect you to staff.');
      }
      if (session && (session.status === 'waiting' || session.status === 'live')) {
        showEscalateBar(session.status === 'waiting' ? 'Waiting for staff to join…' : 'Live conversation');
      }
    }).catch(function () { /* transient */ });
  }

  function connectSocket() {
    if (!session || !window.WebSocket) { startPolling(); return; }
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + window.location.host + '/ws?session=' + session.id);
      ws.onmessage = function (ev) {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data.type === 'chat:message' && data.message) {
          since = Math.max(since, data.message.id);
          addMsg(data.message.role, data.message.body, data.message.id);
        } else if (data.type === 'chat:assigned') {
          addMsg('system', data.admin + ' has joined the conversation.');
        } else if (data.type === 'chat:closed') {
          addMsg('system', 'This conversation has been closed.');
        } else if (data.type === 'ping') {
          /* noop */
        }
      };
      ws.onclose = function () { ws = null; startPolling(); };
      ws.onerror = function () { /* onclose will follow and start polling */ };
    } catch (e) {
      ws = null;
      startPolling();
    }
    /* Polling stays armed as a belt-and-braces fallback even with a socket. */
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (opened) loadMessages(false);
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function onSend(e) {
    e.preventDefault();
    if (sending || !input) return;
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    input.value = '';
    addMsg(App.state.user ? 'user' : 'guest', text);
    const typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    App.api('/api/chat/message', { method: 'POST', body: { text: text } }).then(function (data) {
      typing.remove();
      /* The server creates the session on this first message; adopt it so
       * polling and the socket work from here on. */
      if (data.session) {
        session = data.session;
        sessionKey = String(session.id);
        connectSocket();
      }
      (data.messages || []).forEach(function (m) {
        if (m.role === 'user' || m.role === 'guest') {
          /* Tag our optimistic bubble so polling never duplicates it. */
          const mine = msgs.querySelector('.chat-msg.user:last-of-type, .chat-msg.guest:last-of-type');
          if (mine && m.id) mine.setAttribute('data-id', m.id);
          if (m.id) since = Math.max(since, m.id);
          return;
        }
        if (m.id) since = Math.max(since, m.id);
        addMsg(m.role, m.body, m.id);
      });
      if (data.note) addMsg('system', data.note);
      if (data.escalate && !escalated) showEscalateBar('');
      if (data.mode === 'live') {
        escalated = true;
        showEscalateBar(data.status === 'waiting' ? 'Waiting for staff to join…' : 'Live conversation');
      }
    }).catch(function (err) {
      typing.remove();
      addMsg('system', err.message || 'Could not send. Please try again.');
    }).then(function () { sending = false; });
  }

  function onEscalate() {
    const btn = document.getElementById('chat-human');
    App.busy(btn, function () {
      return App.api('/api/chat/escalate', { method: 'POST', body: { note: '' } });
    }).then(function (data) {
      escalated = true;
      addMsg('system', data.message || 'Connecting you to staff…');
      showEscalateBar(data.status === 'waiting' ? 'Waiting for staff to join…' : 'Live conversation');
    }).catch(function (err) {
      App.toast(err.message || 'Could not connect you right now.', 'err');
    });
  }

  /* Register once the DOM is ready (no inline handlers — CSP). */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureFab);
  } else {
    ensureFab();
  }
})();
