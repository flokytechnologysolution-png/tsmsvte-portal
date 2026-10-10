/**
 * public/js/app.js — shared frontend kernel.
 *
 * Everything the pages have in common: safe DOM helpers, a CSRF-aware API
 * client, session boot, the header/footer chrome, toasts and modals.
 * CSP forbids inline scripts, so every page loads this file externally and
 * wires behaviour with App.ready(...).
 */
(function () {
  'use strict';

  /* ------------------------------ utilities ------------------------------ */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function param(name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  }
  function fmtDate(value, withTime) {
    if (!value) return '';
    const d = new Date(String(value).indexOf('T') === -1 ? String(value).replace(' ', 'T') + 'Z' : value);
    if (isNaN(d.getTime())) return String(value);
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (!withTime) return date;
    return date + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 250);
    };
  }

  /* ------------------------------- toasts -------------------------------- */
  function ensureToastZone() {
    let zone = document.getElementById('toast-zone');
    if (!zone) {
      zone = document.createElement('div');
      zone.id = 'toast-zone';
      document.body.appendChild(zone);
    }
    return zone;
  }
  function toast(message, kind) {
    const zone = ensureToastZone();
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = String(message || '');
    zone.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () { el.remove(); }, 320);
    }, kind === 'err' ? 5200 : 3400);
  }
    /* -------------------------------- modal -------------------------------- */
  let openBackdrop = null;
  function openModal(html, opts) {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal' + ((opts && opts.wide) ? ' wide' : '');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = '<button class="modal-close" type="button" aria-label="Close">&times;</button>' + html;
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';
    openBackdrop = backdrop;
    on(qs('.modal-close', box), 'click', closeModal);
    on(backdrop, 'mousedown', function (e) { if (e.target === backdrop) closeModal(); });
    on(document, 'keydown', escClose);
    const focusable = qs('input, textarea, select, button:not(.modal-close)', box);
    if (focusable) focusable.focus();
    return box;
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    if (!openBackdrop) return;
    openBackdrop.remove();
    openBackdrop = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escClose);
  }

  /* ------------------------------ API client ----------------------------- */
  function readCookie(name) {
    const hit = document.cookie.split('; ').find(function (c) { return c.indexOf(name + '=') === 0; });
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
  }
  const SAFE = { GET: 1, HEAD: 1 };

  function api(path, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.assign({}, opts.headers);
    let body = opts.body;

    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    if (!SAFE[method]) {
      const token = readCookie('tsmsvte_csrf');
      if (token) headers['X-CSRF-Token'] = token;
    }
    return fetch(path, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin'
    }).then(function (res) {
      if (res.status === 204) return null;
      const type = res.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) {
        if (!res.ok) throw new Error('Request failed (' + res.status + ')');
        return res;
      }
      return res.json().then(function (data) {
        if (!res.ok) {
          const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /** Submit a multipart form; CSRF rides along as the `_csrf` field. */
  function apiForm(path, formData, method) {
    if (!SAFE[(method || 'POST').toUpperCase()]) {
      const token = readCookie('tsmsvte_csrf');
      if (token && !formData.has('_csrf')) formData.append('_csrf', token);
    }
    return fetch(path, {
      method: method || 'POST',
      body: formData,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /** Disable a button and show a spinner while `fn` runs. */
  function busy(btn, fn) {
    if (!btn) return Promise.resolve().then(fn);
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    return Promise.resolve().then(fn).then(function (result) {
      btn.disabled = false;
      btn.innerHTML = html;
      return result;
    }, function (err) {
      btn.disabled = false;
      btn.innerHTML = html;
      throw err;
    });
  }
    /* ------------------------------ app state ------------------------------ */
  const state = {
    user: null,          /* publicUser or null */
    staff: null,         /* linked staff record or null */
    settings: {},        /* public settings */
    unreadMail: 0,
    unreadNotifs: 0
  };

  function isAdminish() {
    return state.user && (state.user.role === 'OWNER' || state.user.role === 'ADMIN');
  }
  function canEdit() {
    return state.user && ['OWNER', 'ADMIN', 'EDITOR'].indexOf(state.user.role) !== -1;
  }

  /* The admin console beyond content editing: OWNER/ADMIN/EDITOR keep their
   * sections, and the scoped school roles get exactly the Schools + Teachers
   * sections (their APIs enforce the same scope server-side). */
  function canConsole() {
    return state.user && ['OWNER', 'ADMIN', 'EDITOR', 'LGA_OFFICER', 'SCHOOL_ADMIN']
      .indexOf(state.user.role) !== -1;
  }
  function setting(key, fallback) {
    const s = state.settings || {};
    const v = s[key];
    /* An absent or empty setting must fall back to the caller's default —
     * the old expression handed back the missing value instead. */
    if (v === undefined || v === null || v === '') {
      return fallback === undefined ? '' : fallback;
    }
    return v;
  }

  /* Apply ministry branding colours from settings onto :root. */
  function applyTheme() {
    const root = document.documentElement;
    const map = {
      primary_color: '--primary',
      secondary_color: '--secondary',
      accent_color: '--accent'
    };
    Object.keys(map).forEach(function (key) {
      const val = state.settings[key];
      if (val && /^#[0-9a-fA-F]{3,8}$/.test(val)) root.style.setProperty(map[key], val);
    });
    const primary = state.settings.primary_color || '#0b6b3a';
    if (/^#[0-9a-fA-F]{6}$/.test(primary)) {
      const r = parseInt(primary.slice(1, 3), 16), g = parseInt(primary.slice(3, 5), 16), b = parseInt(primary.slice(5, 7), 16);
      root.style.setProperty('--primary-dark', shade(r, g, b, -0.22));
      root.style.setProperty('--primary-tint', shade(r, g, b, 0.88));
    }
  }
  function shade(r, g, b, amt) {
    const f = function (c) {
      const v = amt < 0 ? Math.round(c * (1 + amt)) : Math.round(c + (255 - c) * amt);
      return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    };
    return '#' + f(r) + f(g) + f(b);
  }

  /* -------------------------------- chrome -------------------------------- */
  const NAV_PUBLIC = [
    { href: '/', label: 'Home' },
    { href: '/news.html', label: 'News' },
    { href: '/events.html', label: 'Events' },
    { href: '/schools.html', label: 'Schools' },
    { href: '/register-school.html', label: 'Register a school' },
    { href: '/circulars.html', label: 'Circulars' },
    { href: '/faq.html', label: 'FAQ' }
  ];

  function navLink(href, label, active) {
    return '<a class="nav-link' + (active ? ' active' : '') + '" href="' + href + '">' + esc(label) + '</a>';
  }

  function renderHeader(active) {
    /* Guarantee: a missing or odd setting can never break the page shell —
     * log it and leave the header alone instead of throwing. */
    try {
      renderHeaderInner(active);
    } catch (err) {
      console.warn('[app] header could not render:', err && err.message);
    }
  }

  function renderHeaderInner(active) {
    const host = document.getElementById('site-header');
    if (!host) return;
    const short = String(setting('ministry_short_name', 'TSMSVTE') || 'TSMSVTE');
    const full = String(setting('ministry_name', 'Portal') || 'Portal');
    const logo = String(setting('logo', '/icons/logo-192.png') || '/icons/logo-192.png');

    let links = NAV_PUBLIC.map(function (item) {
      return navLink(item.href, item.label, active === item.href);
    }).join('');

    if (state.user) {
      const home = canEdit() ? '/admin.html' : '/dashboard.html';
      links += '<span class="nav-sep" aria-hidden="true"></span>';
      links += navLink('/dashboard.html', 'My dashboard', active === '/dashboard.html');
      links += navLink('/mail.html', 'Portal mail' + (state.unreadMail ? ' (' + state.unreadMail + ')' : ''), active === '/mail.html');
      if (canConsole()) links += navLink('/admin.html', 'Admin', active === '/admin.html');
    }

    let account = '';
    if (state.user) {
      const avatar = state.user.avatar
        ? '<img src="' + esc(state.user.avatar) + '" alt="">'
        : esc(initials(state.user.full_name));
      account =
        '<div class="notif-wrap">' +
          '<button class="icon-btn" id="notif-btn" type="button" aria-label="Notifications" title="Notifications">' +
            '&#128276;' + (state.unreadNotifs ? '<span class="dot">' + state.unreadNotifs + '</span>' : '') +
          '</button>' +
          '<div class="notif-panel hidden" id="notif-panel">' +
            '<header>Notifications</header>' +
            '<div id="notif-list"><div class="notif-empty">Loading…</div></div>' +
          '</div>' +
        '</div>' +
        '<a class="user-chip" href="' + (canEdit() ? '/admin.html#settings' : '/dashboard.html') + '">' +
          '<span class="avatar">' + avatar + '</span>' +
          '<span class="who">' + esc(state.user.full_name) + '</span>' +
        '</a>' +
        '<button class="btn btn-ghost btn-sm" id="logout-btn" type="button">Sign out</button>';
    } else {
      account = '<a class="btn btn-sm" href="/login.html">Staff sign in</a>';
    }

    host.innerHTML =
      '<div class="container header-inner">' +
        '<button class="nav-toggle" id="nav-toggle" type="button" aria-label="Menu" aria-expanded="false">&#9776;</button>' +
        '<a class="brand" href="/">' +
          '<img src="' + esc(logo) + '" alt="">' +
          '<span class="brand-name">' + esc(short) +
            '<span class="brand-sub">' + esc(full.length > 62 ? full.slice(0, 60) + '…' : full) + '</span>' +
          '</span>' +
        '</a>' +
        '<nav class="nav" id="main-nav">' + links + '</nav>' +
        '<div class="row" style="gap:8px">' + account + '</div>' +
      '</div>';

    /* NOTE: onerror attribute is inline — CSP script-src blocks it, so wire it in JS too. */
    const img = qs('.brand img', host);
    if (img) on(img, 'error', function () { img.style.visibility = 'hidden'; });

    on(qs('#nav-toggle', host), 'click', function () {
      const nav = qs('#main-nav', host);
      const open = nav.classList.toggle('open');
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    on(qs('#logout-btn', host), 'click', function () {
      const btn = this;
      busy(btn, function () { return api('/api/auth/logout', { method: 'POST' }); })
        .then(function () { window.location.href = '/'; })
        .catch(function () { window.location.href = '/'; });
    });
    wireNotifications(host);
  }
    /* --------------------------- notifications ----------------------------- */
  function wireNotifications(host) {
    const btn = qs('#notif-btn', host);
    const panel = qs('#notif-panel', host);
    const list = qs('#notif-list', host);
    if (!btn || !panel) return;

    function load() {
      api('/api/staff/notifications').then(function (data) {
        state.unreadNotifs = data.unread || 0;
        if (!data.notifications.length) {
          list.innerHTML = '<div class="notif-empty">You have no notifications yet.</div>';
          return;
        }
        list.innerHTML = data.notifications.map(function (n) {
          return '<a class="notif-item' + (n.is_read ? '' : ' unread') + '" href="#" data-id="' + n.id +
            '" data-link="' + esc(n.link || '') + '">' +
            '<span>' + esc(n.title) + '</span>' +
            (n.body ? '<span class="when">' + esc(n.body) + '</span>' : '') +
            '<span class="when">' + esc(fmtDate(n.created_at, true)) + '</span>' +
          '</a>';
        }).join('');
        qsa('.notif-item', list).forEach(function (item) {
          on(item, 'click', function (e) {
            e.preventDefault();
            const id = item.getAttribute('data-id');
            const link = item.getAttribute('data-link');
            api('/api/staff/notifications/read', { method: 'POST', body: { id: Number(id) } })
              .catch(function () { /* best effort */ });
            if (link) window.location.href = link;
          });
        });
      }).catch(function () {
        list.innerHTML = '<div class="notif-empty">Could not load notifications.</div>';
      });
      api('/api/staff/notifications/read', { method: 'POST', body: {} })
        .then(function () {
          state.unreadNotifs = 0;
          const dot = qs('.dot', btn);
          if (dot) dot.remove();
        }).catch(function () { /* best effort */ });
    }

    on(btn, 'click', function (e) {
      e.stopPropagation();
      const hidden = panel.classList.toggle('hidden');
      if (!hidden) load();
    });
    on(document, 'click', function (e) {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target)) {
        panel.classList.add('hidden');
      }
    });
  }

  /* -------------------------------- footer -------------------------------- */
  function renderFooter() {
    /* Same guarantee as the header: a missing setting never breaks the shell. */
    try {
      renderFooterInner();
    } catch (err) {
      console.warn('[app] footer could not render:', err && err.message);
    }
  }

  function renderFooterInner() {
    const host = document.getElementById('site-footer');
    if (!host) return;
    const credit = setting('footer_credit_text', '');
    const creditLink = setting('footer_credit_link', '#');
    const orgName = setting('ministry_name', '');
    const address = setting('contact_address', '');
    /* Contact lines are hidden when their setting is empty — the footer never
     * prints blank <li>s or the text "undefined". */
    const contactItems = [
      setting('contact_phone', ''), setting('contact_email', ''), setting('office_hours', '')
    ].filter(function (v) { var t = String(v).trim(); return t !== '' && !/\[PLACEHOLDER/i.test(t); })
      .map(function (v) { return '<li>' + esc(v) + '</li>'; });
    if (String(setting('contact_map_link', '')).trim() !== '') {
      contactItems.push('<li><a href="' + esc(setting('contact_map_link')) +
        '" rel="noopener" target="_blank">Open in maps</a></li>');
    }
    contactItems.push('<li><a href="/register.html">Staff registration</a></li>');
    contactItems.push('<li><a href="/register-school.html">Register a school</a></li>');
    /* Social buttons: each is shown only when the ministry has entered that
     * URL in Admin -> Site settings, so an empty handle never renders a dead
     * link. Icons are inline SVG (CSP-safe, no outside image links). */
    const social = [
      ['social_facebook', 'Facebook', 'Facebook',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M13.5 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.4-1.4h1.5V5.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2H8.2V14h2.3v7h3z"/></svg>'],
      ['social_x', 'X (Twitter)', 'X',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M17.5 3h3l-6.6 7.6L21.5 21h-5.3l-4.2-5.5L7 21H4l7-8L3 3h5.4l3.9 5.1L17.5 3zm-1 16h1.6L7.6 4.7H5.9L16.5 19z"/></svg>'],
      ['social_instagram', 'Instagram', 'Instagram',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 2.2c-2.7 0-3 0-4.1.1-1 0-1.7.2-2.3.4-.6.3-1.1.6-1.6 1.1S3.2 4.9 3 5.5c-.2.6-.4 1.3-.4 2.3C2.5 9 2.5 9.3 2.5 12s0 3 .1 4.1c0 1 .2 1.7.4 2.3.3.6.6 1.1 1.1 1.6s1 .8 1.6 1.1c.6.2 1.3.4 2.3.4 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c1 0 1.7-.2 2.3-.4.6-.3 1.1-.6 1.6-1.1s.8-1 1.1-1.6c.2-.6.4-1.3.4-2.3.1-1.1.1-1.4.1-4.1s0-3-.1-4.1c0-1-.2-1.7-.4-2.3-.3-.6-.6-1.1-1.1-1.6s-1-.8-1.6-1.1c-.6-.2-1.3-.4-2.3-.4-1.1-.1-1.4-.1-4.1-.1zm0 1.8c2.7 0 2.9 0 4 .1.8 0 1.2.2 1.5.3.4.1.6.3.9.6.3.3.5.5.6.9.1.3.3.7.3 1.5.1 1 .1 1.3.1 4s0 2.9-.1 4c0 .8-.2 1.2-.3 1.5-.1.4-.3.6-.6.9-.3.3-.5.5-.9.6-.3.1-.7.3-1.5.3-1 .1-1.3.1-4 .1s-2.9 0-4-.1c-.8 0-1.2-.2-1.5-.3-.4-.1-.6-.3-.9-.6-.3-.3-.5-.5-.6-.9-.1-.3-.3-.7-.3-1.5-.1-1-.1-1.3-.1-4s0-2.9.1-4c0-.8.2-1.2.3-1.5.1-.4.3-.6.6-.9.3-.3.5-.5.9-.6.3-.1.7-.3 1.5-.3 1-.1 1.3-.1 4-.1zm0 3.1a4.9 4.9 0 100 9.8 4.9 4.9 0 000-9.8zm0 8.1a3.2 3.2 0 110-6.4 3.2 3.2 0 010 6.4zm6.3-8.3a1.1 1.1 0 11-2.3 0 1.1 1.1 0 012.3 0z"/></svg>'],
      ['social_linkedin', 'LinkedIn', 'LinkedIn',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M6.9 8.7H4.1V20h2.8V8.7zM5.5 4a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4zM20 13.4c0-3-1.6-4.4-3.7-4.4-1.7 0-2.5.9-2.9 1.6V8.7H10.6c0 .8 0 11.3 0 11.3h2.8v-6.3c0-.3 0-.7.1-.9.3-.6.8-1.3 1.8-1.3 1.3 0 1.8 1 1.8 2.4V20H20v-6.6z"/></svg>'],
      ['social_youtube', 'YouTube', 'YouTube',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M21.6 7.2c-.2-1-1-1.8-2-2C17.7 4.8 12 4.8 12 4.8s-5.7 0-7.6.4c-1 .2-1.8 1-2 2C2 9.1 2 12 2 12s0 2.9.4 4.8c.2 1 1 1.8 2 2 1.9.4 7.6.4 7.6.4s5.7 0 7.6-.4c1-.2 1.8-1 2-2 .4-1.9.4-4.8.4-4.8s0-2.9-.4-4.8zM10 15.2V8.8l5.5 3.2-5.5 3.2z"/></svg>'],
      ['social_whatsapp', 'WhatsApp', 'WhatsApp',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 2a9.9 9.9 0 00-8.5 15L2 22l5.2-1.4A9.9 9.9 0 1012 2zm0 1.8a8.1 8.1 0 013.6 15.3l-.4.2-3 .8.8-2.9-.2-.4A8.1 8.1 0 0112 3.8zm-2.3 4c-.2 0-.5.1-.7.3-.3.3-.9 1-.9 2s.7 2.2 1 2.6c.4.5 1.6 2.3 4 3.2 1.9.7 2.3.6 2.8.5.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.1-.1-.1-.3-.2-.6-.3l-1.7-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.5.1-.5-.2-1.5-.6-2.2-1.6-.5-.7-.6-1-.4-1.2.1-.1.5-.6.6-.8.1-.2 0-.4 0-.5l-.7-1.7c-.1-.3-.3-.4-.5-.4h-.3z"/></svg>'],
      ['social_tiktok', 'TikTok', 'TikTok',
        '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M16.5 3c.3 2 1.5 3.4 3.5 3.7v2.6c-1.3.1-2.6-.3-3.7-1v5.6c0 3.2-2.4 5.4-5.4 5.2-2.4-.1-4.4-2.1-4.5-4.5-.1-2.7 2.1-5 4.8-4.8v2.7c-.4-.1-.9-.1-1.3.1-1 .3-1.6 1.3-1.4 2.3.2.8.9 1.4 1.7 1.5 1 .1 1.9-.6 1.9-1.6V3h2.6z"/></svg>']
    ];
    const socialItems = social.map(function (row) {
      const url = String(setting(row[0], '')).trim();
      if (!url) return '';
      return '<a href="' + esc(url) + '" rel="noopener" target="_blank" title="' + esc(row[1]) + '">' +
        row[3] + '<span class="visually-hidden">' + esc(row[2]) + '</span></a>';
    }).join('');
    const socialBlock = socialItems
      ? '<div>' +
          '<h4>Follow us</h4>' +
          '<div class="footer-social">' + socialItems + '</div>' +
        '</div>'
      : '';
    host.innerHTML =
      '<div class="container">' +
        '<div class="footer-grid">' +
          '<div>' +
            '<h4>' + esc(setting('ministry_short_name', 'Portal')) + '</h4>' +
            (orgName ? '<p>' + esc(orgName) + '</p>' : '') +
            (address ? '<p class="mb-0">' + esc(address) + '</p>' : '') +
          '</div>' +
          '<div>' +
            '<h4>Explore</h4>' +
            '<ul>' +
              '<li><a href="/news.html">News</a></li>' +
              '<li><a href="/events.html">Events</a></li>' +
              '<li><a href="/contact.html">Contact us</a></li>' +
              '<li><a href="/schools.html">Schools directory</a></li>' +
              '<li><a href="/circulars.html">Circulars &amp; downloads</a></li>' +
              '<li><a href="/faq.html">Frequently asked questions</a></li>' +
            '</ul>' +
          '</div>' +
          '<div>' +
            '<h4>Contact</h4>' +
            '<ul>' + contactItems.join('') + '</ul>' +
          '</div>' +
          socialBlock +
        '</div>' +
        '<div class="footer-bottom">' +
          '<span>&copy; ' + new Date().getFullYear() + ' ' + esc(setting('ministry_short_name', '')) + '. All rights reserved.</span>' +
          (credit
            ? '<span><a href="' + esc(creditLink || '#') + '" rel="noopener" target="_blank">' + esc(credit) + '</a></span>'
            : '') +
        '</div>' +
      '</div>';
  }
    /* --------------------------------- boot --------------------------------- */
  function pageMeta() {
    const body = document.body;
    return {
      active: body.getAttribute('data-active') || '',
      requiresAuth: body.getAttribute('data-auth') === 'true',
      requiresAdmin: body.getAttribute('data-admin') === 'true',
      minimal: body.getAttribute('data-minimal') === 'true'
    };
  }

  function fetchSession() {
    /* /api/auth/me returns the user, the linked staff record, unread mail and
     * the public settings in one shot — even for anonymous visitors. */
    return api('/api/auth/me').then(function (data) {
      state.user = data.user || null;
      state.staff = data.staff || null;
      state.unreadMail = data.unread_mail || 0;
      state.settings = data.settings || {};
      applyTheme();
    }).catch(function () {
      /* Offline / API down: fall back to public settings so the shell still renders. */
      return api('/api/settings/public').then(function (data) {
        state.settings = (data && data.settings) || {};
        applyTheme();
      }).catch(function () { /* keep defaults */ });
    });
  }

  /* --------------------------- PWA install ------------------------------- */
  /* Chrome/Edge/Android fire beforeinstallprompt; we hold on to it and reveal
   * the "Install app" button only when the browser really can install us.
   * iOS Safari has no such event, so it gets a short manual hint instead. */
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }
  function isApple() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function alreadyInstalled() {
    try { return localStorage.getItem('tsmsvte_installed') === '1'; } catch (e) { return false; }
  }
  function markInstalled() {
    try { localStorage.setItem('tsmsvte_installed', '1'); } catch (e) { /* private mode */ }
  }
  function hideInstallUi() {
    const btn = document.getElementById('pwa-install-btn');
    const hint = document.getElementById('pwa-install-hint');
    if (btn) btn.classList.add('hidden');
    if (hint) hint.classList.add('hidden');
  }
  function showIosHint() {
    const btn = document.getElementById('pwa-install-btn');
    const hint = document.getElementById('pwa-install-hint');
    if (btn) btn.classList.add('hidden');   /* no prompt() exists on iOS */
    if (hint && !alreadyInstalled()) hint.classList.remove('hidden');
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    /* Keep the default mini-infobar away: we render our own button. */
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('pwa-install-btn');
    if (btn && !alreadyInstalled() && !isStandalone()) btn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', function () {
    markInstalled();
    deferredPrompt = null;
    hideInstallUi();
  });

  function wireInstallButton() {
    const btn = document.getElementById('pwa-install-btn');
    if (!btn) return false;
    if (isStandalone() || alreadyInstalled()) { hideInstallUi(); return true; }
    on(btn, 'click', function () {
      if (!deferredPrompt) return;
      const ev = deferredPrompt;
      deferredPrompt = null;
      ev.prompt();
      ev.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') markInstalled();
        hideInstallUi();
      });
    });
    if (deferredPrompt) btn.classList.remove('hidden');
    else if (isApple()) showIosHint();
    return true;
  }

  /* ------------------- global image error handling (CSP) --------------- *
   * CSP blocks inline onerror=, so every <img> that fails to load is hidden
   * here instead.  A single delegated capture listener covers images already
   * on the page and any a page script adds later (news/events/home cards). */
  function wireImageErrors() {
    document.addEventListener('error', function (ev) {
      const el = ev.target;
      if (el && el.tagName === 'IMG') el.style.visibility = 'hidden';
    }, true);
  }

  function boot() {
    const meta = pageMeta();
    wireImageErrors();
    return fetchSession().then(function () {
      if (meta.requiresAuth && !state.user) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace('/login.html?next=' + next);
        return null;
      }
      if (meta.requiresAdmin && state.user && !canConsole()) {
        window.location.replace('/dashboard.html');
        return null;
      }
      if (!meta.minimal) {
        renderHeader(meta.active);
        renderFooter();
      }
      wireInstallButton();
      return { user: state.user, staff: state.staff, settings: state.settings, meta: meta };
    });
  }

  const readyQueue = [];
  let bootPromise = null;
  let bootedCtx = null;
  function ready(fn) {
    if (bootedCtx) {
      try { fn(bootedCtx); } catch (err) { console.error('[page] init failed:', err); }
      return;
    }
    readyQueue.push(fn);
  }
  function start() {
    bootPromise = boot().then(function (ctx) {
      if (!ctx) return null;
      bootedCtx = ctx;
      readyQueue.splice(0).forEach(function (fn) {
        try { fn(ctx); } catch (err) { console.error('[page] init failed:', err); }
      });
      return ctx;
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* ------------------------------- exports -------------------------------- */
  window.App = {
    esc: esc, qs: qs, qsa: qsa, on: on, param: param,
    fmtDate: fmtDate, fmtSize: fmtSize, initials: initials, debounce: debounce,
    toast: toast, openModal: openModal, closeModal: closeModal,
    api: api, apiForm: apiForm, busy: busy,
    ready: ready,
    state: state,
    setting: setting,
    isAdminish: isAdminish,
    canEdit: canEdit,
    canConsole: canConsole,
    whenReady: function () { return bootPromise || Promise.resolve(null); },
    /* Small page helpers reused across several screens: */
    emptyState: function (title, note) {
      return '<div class="empty-state"><strong>' + esc(title) + '</strong>' + esc(note || '') + '</div>';
    },
    pager: function (page, pages, attr) {
      attr = attr || 'data-page';
      if (pages <= 1) return '';
      let out = '<div class="pager">';
      out += '<button type="button" ' + attr + '="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>&#8592;</button>';
      const from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
      if (from > 1) out += '<button type="button" ' + attr + '="1">1</button><span class="info">…</span>';
      for (let p = from; p <= to; p++) {
        out += '<button type="button" class="' + (p === page ? 'current' : '') + '" ' + attr + '=' + '"' + p + '">' + p + '</button>';
      }
      if (to < pages) out += '<span class="info">…</span><button type="button" ' + attr + '="' + pages + '">' + pages + '</button>';
      out += '<button type="button" ' + attr + '="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>&#8594;</button>';
      out += '</div>';
      return out;
    },
    labelise: function (key) {
      return String(key || '').replace(/_/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    }
  };
})();
