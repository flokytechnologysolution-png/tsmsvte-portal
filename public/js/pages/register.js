/**
 * public/js/pages/register.js — staff self-registration (multipart: photo).
 */
(function () {
  'use strict';

  function fillSelect(id, items, labelFn, valueFn) {
    const sel = document.getElementById(id);
    (items || []).forEach(function (it) {
      const opt = document.createElement('option');
      opt.value = valueFn(it);
      opt.textContent = labelFn(it);
      sel.appendChild(opt);
    });
  }

  App.ready(function (ctx) {
    const form = document.getElementById('reg-form');
    const errBox = document.getElementById('reg-error');
    const okBox = document.getElementById('reg-success');
    const btn = document.getElementById('reg-btn');
    const closed = document.getElementById('reg-closed');

    /* The privacy notice is deliberately NOT in ctx.settings (it is a private
     * key); the registration form fetches it from its own endpoint. */
    App.api('/api/settings/privacy-notice').then(function (d) {
      document.getElementById('privacy-text').textContent = d.privacy_notice ||
        'I consent to the processing of my personal data for staff verification.';
    }).catch(function () {
      document.getElementById('privacy-text').textContent =
        'I consent to the processing of my personal data for staff verification.';
    });

    if (ctx.settings.registration_open === '0') {
      closed.classList.remove('hidden');
      form.classList.add('hidden');
    }

    /* LGA list comes from the LGAs endpoint; schools only once an LGA is chosen. */
    App.api('/api/schools/lgas').then(function (data) {
      fillSelect('lga', data.lgas, function (l) { return l.name; }, function (l) { return l.name; });
    }).catch(function () { /* the form still works with free-text school */ });

    App.on(document.getElementById('lga'), 'change', function () {
      const lga = this.value;
      const sel = document.getElementById('school');
      sel.innerHTML = '<option value="">Select your school</option>';
      document.getElementById('school-name-wrap').classList.add('hidden');
      if (!lga) return;
      App.api('/api/schools?lga=' + encodeURIComponent(lga) + '&limit=100').then(function (data) {
        fillSelect('school', data.schools, function (s) { return s.name; }, function (s) { return String(s.id); });
        const wrap = document.getElementById('school-name-wrap');
        wrap.classList.remove('hidden'); /* admins may register staff for schools not yet recorded */
      }).catch(function () {
        document.getElementById('school-name-wrap').classList.remove('hidden');
      });
    });

    App.on(form, 'submit', function (e) {
      e.preventDefault();
      errBox.classList.add('hidden');
      okBox.classList.add('hidden');

      const photo = document.getElementById('photo').files[0];
      if (photo && photo.size > 3 * 1024 * 1024) {
        errBox.textContent = 'The passport photograph must be 3 MB or smaller.';
        errBox.classList.remove('hidden');
        return;
      }

      const fd = new FormData();
      fd.append('full_name', document.getElementById('full_name').value.trim());
      fd.append('email', document.getElementById('email').value.trim());
      fd.append('phone', document.getElementById('phone').value.trim());
      fd.append('staff_number', document.getElementById('staff_number').value.trim());
      fd.append('rank', document.getElementById('rank').value.trim());
      fd.append('lga', document.getElementById('lga').value);
      const schoolId = document.getElementById('school').value;
      if (schoolId) fd.append('school_id', schoolId);
      fd.append('school_name', document.getElementById('school_name').value.trim());
      fd.append('consent', document.getElementById('consent').checked ? '1' : '0');
      if (photo) fd.append('photo', photo);

      App.busy(btn, function () { return App.apiForm('/api/auth/register', fd); }).then(function (data) {
        form.classList.add('hidden');
        okBox.innerHTML = '<strong>Registration received.</strong><br>' + App.esc(data.message) +
          '<br><br><a class="btn btn-sm" href="/login.html">Go to sign in</a>';
        okBox.classList.remove('hidden');
        okBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }).catch(function (err) {
        errBox.textContent = err.message;
        if (err.data && Array.isArray(err.data.errors) && err.data.errors.length > 1) {
          errBox.innerHTML = err.data.errors.map(function (m) { return App.esc(m); }).join('<br>');
        }
        errBox.classList.remove('hidden');
        errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  });
})();
