/**
 * public/js/pages/accept-ownership.js — inspect the invitation (GET), then
 * accept it (POST) which promotes the account and demotes the old owner.
 */
(function () {
  'use strict';

  App.ready(function () {
    const token = App.param('token');
    const errBox = document.getElementById('to-error');
    const okBox = document.getElementById('to-success');
    const form = document.getElementById('to-form');
    const btn = document.getElementById('to-btn');
    const tokenField = document.getElementById('token');

    if (token) tokenField.value = token;

    function inspect() {
      const t = tokenField.value.trim();
      if (!t) return;
      App.api('/api/auth/transfer?token=' + encodeURIComponent(t)).then(function (data) {
        document.getElementById('to-email').textContent = data.email;
        document.getElementById('to-by').textContent = data.invited_by || '—';
        document.getElementById('to-exp').textContent = App.fmtDate(data.expires_at, true);
        document.getElementById('to-summary').classList.remove('hidden');
        errBox.classList.add('hidden');
      }).catch(function (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
        document.getElementById('to-summary').classList.add('hidden');
      });
    }

    if (token) inspect();
    App.on(tokenField, 'change', inspect);

    App.on(form, 'submit', function (e) {
      e.preventDefault();
      errBox.classList.add('hidden');
      okBox.classList.add('hidden');

      const payload = {
        token: tokenField.value.trim(),
        full_name: document.getElementById('full_name').value.trim(),
        password: document.getElementById('password').value,
        confirm: document.getElementById('confirm').value
      };
      if (!payload.token) {
        errBox.textContent = 'This page needs the invitation token from your link.';
        errBox.classList.remove('hidden');
        return;
      }
      if (payload.full_name.length < 3) {
        errBox.textContent = 'Enter your full name.';
        errBox.classList.remove('hidden');
        return;
      }
      if (payload.password.length < 8 || !/[A-Za-z]/.test(payload.password) || !/[0-9]/.test(payload.password)) {
        errBox.textContent = 'Choose a password of at least 8 characters with letters and numbers.';
        errBox.classList.remove('hidden');
        return;
      }
      if (payload.password !== payload.confirm) {
        errBox.textContent = 'The two passwords do not match.';
        errBox.classList.remove('hidden');
        return;
      }

      App.busy(btn, function () {
        return App.api('/api/auth/transfer/accept', { method: 'POST', body: payload });
      }).then(function (data) {
        form.classList.add('hidden');
        document.getElementById('to-summary').classList.add('hidden');
        okBox.innerHTML = App.esc(data.message) + '<br><br><a class="btn btn-sm" href="/login.html">Sign in as owner</a>';
        okBox.classList.remove('hidden');
      }).catch(function (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      });
    });
  });
})();
