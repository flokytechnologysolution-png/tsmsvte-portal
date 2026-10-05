/**
 * public/js/pages/dashboard.js — staff self-service home.
 */
(function () {
  'use strict';

  const STATUS_BADGE = {
    APPROVED: 'ok', PENDING: 'warn', REJECTED: 'danger'
  };

  function row(k, v) {
    if (v === null || v === undefined || v === '') v = '—';
    return '<div class="r"><span class="k">' + App.esc(k) + '</span><span class="v">' + App.esc(v) + '</span></div>';
  }

  function renderStaff(ctx) {
    const s = ctx.staff;
    const u = ctx.user;
    document.getElementById('dash-title').textContent = 'Welcome, ' + (u ? u.full_name.split(' ')[0] : 'staff member');
    document.getElementById('dash-sub').textContent = (u && u.mail_address)
      ? 'Your portal mail address is ' + u.mail_address
      : 'Everything you need in one place.';

    document.getElementById('stat-mail').textContent = ctx.unreadMail || 0;

    const statusEl = document.getElementById('stat-status');
    if (s) {
      statusEl.innerHTML = '<span class="badge ' + (STATUS_BADGE[s.status] || 'muted') + '" style="font-size:15px">' +
        App.esc(s.status) + '</span>';
    } else {
      statusEl.textContent = 'No record';
      statusEl.style.fontSize = '1.3rem';
    }

    const host = document.getElementById('staff-record');
    if (!s) {
      host.innerHTML = '<div class="r"><span class="v">No staff record is linked to your account yet. ' +
        'If you have not registered, use the <a href="/register.html">staff registration form</a>.</span></div>';
      return;
    }
    host.innerHTML =
      row('Full name', s.full_name) +
      row('Staff number', s.staff_number) +
      row('Rank', s.rank) +
      row('School', s.school_name) +
      row('LGA', s.lga) +
      row('Phone', s.phone) +
      row('Email', s.email) +
      row('Registered', App.fmtDate(s.created_at)) +
      (s.status === 'REJECTED' && s.rejection_reason
        ? '<div class="r"><span class="k">Reason</span><span class="v">' + App.esc(s.rejection_reason) + '</span></div>'
        : '');

    const phone = document.getElementById('phone');
    if (phone && !phone.value) phone.value = s.phone || '';
  }

  function loadNotifications() {
    App.api('/api/staff/notifications').then(function (data) {
      document.getElementById('stat-notifs').textContent = data.unread || 0;
      const host = document.getElementById('notif-stream');
      if (!data.notifications.length) {
        host.innerHTML = App.emptyState('Nothing yet', 'You will see updates about your account here.');
        return;
      }
      host.innerHTML = '<div class="detail-list">' + data.notifications.map(function (n) {
        const title = n.link
          ? '<a href="' + App.esc(n.link) + '">' + App.esc(n.title) + '</a>'
          : App.esc(n.title);
        return '<div class="r">' +
          '<span class="k" style="flex:1;text-align:left">' + (n.is_read ? '' : '<span class="badge">new</span> ') + title +
            (n.body ? '<br><small>' + App.esc(n.body) + '</small>' : '') + '</span>' +
          '<span class="v nowrap"><small>' + App.esc(App.fmtDate(n.created_at, true)) + '</small></span>' +
        '</div>';
      }).join('') + '</div>';
    }).catch(function () {
      document.getElementById('notif-stream').innerHTML = App.emptyState('Could not load notifications', 'Please refresh.');
    });
  }

  App.ready(function (ctx) {
    document.getElementById('stat-notifs').textContent = '…';
    renderStaff(ctx);
    loadNotifications();

    App.on(document.getElementById('mark-read'), 'click', function () {
      const btn = this;
      App.busy(btn, function () {
        return App.api('/api/staff/notifications/read', { method: 'POST', body: {} });
      }).then(function () {
        document.getElementById('stat-notifs').textContent = '0';
        loadNotifications();
        App.toast('All notifications marked as read.', 'ok');
      }).catch(function (err) { App.toast(err.message, 'err'); });
    });

    App.on(document.getElementById('profile-form'), 'submit', function (e) {
      e.preventDefault();
      const errBox = document.getElementById('profile-error');
      errBox.classList.add('hidden');
      const file = document.getElementById('photo').files[0];
      if (file && file.size > 3 * 1024 * 1024) {
        errBox.textContent = 'The photograph must be 3 MB or smaller.';
        errBox.classList.remove('hidden');
        return;
      }
      const fd = new FormData();
      fd.append('phone', document.getElementById('phone').value.trim());
      if (file) fd.append('photo', file);

      const btn = document.getElementById('profile-btn');
      App.busy(btn, function () { return App.apiForm('/api/staff/me', fd, 'PUT'); }).then(function () {
        App.toast('Your record has been updated.', 'ok');
        document.getElementById('photo').value = '';
        return App.api('/api/staff/me').then(function (data) {
          ctx.staff = data.staff;
          App.state.staff = data.staff;
          renderStaff(ctx);
        });
      }).catch(function (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      });
    });
  });
})();
