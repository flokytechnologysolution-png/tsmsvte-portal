/**
 * public/js/pages/reset-password.js — consume a one-time token and set
 * a new password.  The token may arrive in ?token= or be pasted manually.
 */
(function () {
  'use strict';

  App.ready(function () {
    const form = document.getElementById('rp-form');
    const errBox = document.getElementById('rp-error');
    const okBox = document.getElementById('rp-success');
    const btn = document.getElementById('rp-btn');

    const preset = App.param('token');
    if (preset) document.getElementById('token').value = preset;

    App.on(form, 'submit', function (e) {
      e.preventDefault();
      errBox.classList.add('hidden');
      okBox.classList.add('hidden');

      const token = document.getElementById('token').value.trim();
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;

      if (!token) {
        errBox.textContent = 'Paste the reset token you were given.';
        errBox.classList.remove('hidden');
        return;
      }
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        errBox.textContent = 'Choose a password of at least 8 characters containing letters and numbers.';
        errBox.classList.remove('hidden');
        return;
      }
      if (password !== confirm) {
        errBox.textContent = 'The two passwords do not match.';
        errBox.classList.remove('hidden');
        return;
      }

      App.busy(btn, function () {
        return App.api('/api/auth/reset-password', {
          method: 'POST',
          body: { token: token, password: password, confirm: confirm }
        });
      }).then(function (data) {
        form.classList.add('hidden');
        okBox.innerHTML = App.esc(data.message) + '<br><br><a class="btn btn-sm" href="/login.html">Sign in now</a>';
        okBox.classList.remove('hidden');
      }).catch(function (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      });
    });
  });
})();
