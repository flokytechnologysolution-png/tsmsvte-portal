/**
 * public/js/pages/login.js — sign in, then follow the server's redirect hint.
 */
(function () {
  'use strict';

  App.ready(function (ctx) {
    /* Already signed in? Go straight to the right home. */
    if (ctx.user) {
      window.location.replace(App.param('next') || (App.canEdit() ? '/admin.html' : '/dashboard.html'));
      return;
    }

    const form = document.getElementById('login-form');
    const errBox = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    App.on(form, 'submit', function (e) {
      e.preventDefault();
      errBox.classList.add('hidden');

      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      if (!email || !password) {
        errBox.textContent = 'Enter your email address and password.';
        errBox.classList.remove('hidden');
        return;
      }

      App.busy(btn, function () {
        return App.api('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
      }).then(function (data) {
        App.toast('Welcome back, ' + data.user.full_name + '.', 'ok');
        const next = App.param('next');
        window.location.href = next && next.charAt(0) === '/' ? next : data.redirect;
      }).catch(function (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
        if (err.status === 429) {
          errBox.textContent = err.message + ' Ask an administrator if you are locked out.';
        }
      });
    });
  });
})();
