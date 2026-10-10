/**
 * public/js/pages/register-school.js — staff-facing "register a school" form.
 * POSTs to /api/schools (the existing protected admin endpoint), so it runs
 * through the same validation, LGA lookup and scope rules as the admin edit
 * flow. Field labels mirror the admin editor; the 16 Taraba State LGAs are
 * loaded from /api/schools/options.
 */
(function () {
  'use strict';

  const TYPE_LABEL = {
    junior_secondary: 'Junior secondary',
    senior_secondary: 'Senior secondary',
    technical: 'Technical',
    vocational: 'Vocational'
  };
  const CAT_LABEL = { boys: 'Boys', girls: 'Girls', mixed: 'Mixed' };
  const BOARD_LABEL = { boarding: 'Boarding', day: 'Day', both: 'Both' };

  const form = document.getElementById('register-form');
  const body = document.getElementById('register-body');
  const notice = document.getElementById('register-notice');
  const errors = document.getElementById('register-errors');
  const success = document.getElementById('register-success');
  const submitBtn = document.getElementById('register-submit');
  if (!form || !body) return;

  function val(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function setBusy(busy) {
    if (submitBtn) submitBtn.disabled = Boolean(busy);
  }

  function showErrors(items) {
    if (!errors) return;
    const list = (items || []).map(function (p) {
      const msg = typeof p === 'string' ? p : (p && (p.message || p.msg || p.error)) || 'Invalid value';
      return '<li>' + App.esc(String(msg)) + '</li>';
    }).join('');
    errors.innerHTML = '<ul class="error-list">' + (list || '<li>Something went wrong</li>') + '</ul>';
    errors.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showSuccess(msg) {
    if (!success) return;
    success.hidden = false;
    success.innerHTML = App.esc(String(msg || 'Saved.'));
  }

  /* --------------------------------------------------------------- *
   * Boot: load the picklists the form needs. The selects already carry
   * a placeholder <option value="">, so we only append — never wipe.
   * --------------------------------------------------------------- */
  function labelForBoard(b) {
    return BOARD_LABEL[b] || (b ? b.charAt(0).toUpperCase() + b.slice(1) : b);
  }

  App.api('/api/schools/options').then(function (o) {
    o = o || {};
    fillSelect('register-lga', o.lgas, function (l) { return l.name; }, function (l) { return l.name; });
    fillSelect('register-type', o.types, function (t) { return TYPE_LABEL[t] || t; });
    fillSelect('register-category', o.categories, function (c) { return CAT_LABEL[c] || c; });
    fillSelect('register-boarding', o.boarding, labelForBoard);
    renameLoadingOption('register-lga', 'Select LGA…');
  }).catch(function (err) {
    /* Options failed (offline / API down): keep the form usable and explain
     * why the LGA picker is empty instead of deleting the whole form. */
    if (notice) {
      notice.innerHTML = '<div class="form-errors">Could not load the LGA list' +
        (err && err.message ? ': ' + App.esc(err.message) : '') +
        '. Please refresh — if it persists the directory API is down.</div>';
    }
    renameLoadingOption('register-lga', 'Could not load LGAs — refresh to retry');
  });

  function renameLoadingOption(id, text) {
    const sel = document.getElementById(id);
    if (sel && sel.options.length && sel.options[0].value === '') {
      sel.options[0].textContent = text;
    }
  }

  /* --------------------------------------------------------------- *
   * Shared picklist helper (same pattern as the schools directory).
   * The placeholder option stays; unknown items are skipped safely.
   * --------------------------------------------------------------- */
  function fillSelect(id, items, labelFn, valueFn) {
    const sel = document.getElementById(id);
    if (!sel) return;
    (items || []).forEach(function (it) {
      if (it === null || it === undefined) return;
      const opt = document.createElement('option');
      try {
        opt.value = valueFn ? valueFn(it) : it;
        opt.textContent = labelFn ? labelFn(it) : it;
      } catch (e) { return; }
      if (opt.value === '') return; /* never add a second blank option */
      sel.appendChild(opt);
    });
  }

  /* --------------------------------------------------------------- *
   * Form submit. The submit BUTTON is disabled while the request is in
   * flight (a .form-actions <div> has no .disabled property, so the old
   * code silently never disabled anything — and never re-enabled it).
   * Validation errors come back as { error, errors:[...] }; each entry
   * may be a string or { message }, so both shapes are rendered.
   * --------------------------------------------------------------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();

    const payload = {
      name: val('register-name'),
      lga: val('register-lga'),
      type: val('register-type'),
      category: val('register-category'),
      boarding: val('register-boarding'),
      address: val('register-address'),
      principal: val('register-principal'),
      phone: val('register-phone'),
      email: val('register-email'),
      year_established: val('register-year'),
      notes: val('register-notes')
    };

    /* Clear previous feedback. */
    if (errors) errors.innerHTML = '';
    if (success) {
      success.hidden = true;
      success.innerHTML = '';
    }
    setBusy(true);

    App.api('/api/schools', { method: 'POST', body: payload })
      .then(function (res) {
        setBusy(false);
        const id = res && res.id !== undefined ? res.id : '';
        /* Success: show a confirmation box with the new record id. */
        const box = App.openModal(
          '<h3>School registered</h3>' +
          '<p>Thank you. The school has been added to the directory.</p>' +
          (id !== '' ? '<div class="kv-note"><strong>Record #</strong> ' + App.esc(id) + '</div>' : '') +
          '<p class="mt-2">It is now visible in the public schools directory.</p>' +
          '<div class="modal-actions"><button class="btn" type="button" id="reg-ok">Done</button></div>',
          { wide: true });
        App.on(box.querySelector('#reg-ok'), 'click', function () { App.closeModal(); window.location.href = '/schools.html'; });
        App.toast('School registered' + (id !== '' ? ' (record #' + id + ')' : '') + '.', 'ok');
        form.reset();
      })
      .catch(function (err) {
        setBusy(false);
        /* Backend validation errors (422) come back as err.data.errors. */
        const data = (err && err.data) || {};
        if (err && err.status === 422 && data.errors && data.errors.length) {
          showErrors(data.errors);
        } else if (data.errors && data.errors.length) {
          showErrors(data.errors);
        } else {
          showErrors([err ? (err.message || 'Something went wrong') : 'Something went wrong']);
        }
      });
  });

  function showNotice(html) {
    if (!notice) return;
    notice.innerHTML = String(html || '');
  }

  App.ready(function (ctx) {
    /* Role hint — informational only, never destructive: the form stays in
     * the DOM so an unauthenticated visitor can still read it (and the
     * server enforces the real permission). SCHOOL_ADMIN cannot create
     * schools server-side, so they get the hint too. */
    const user = ctx && ctx.user ? ctx.user : null;
    if (!notice) return;
    if (!user) {
      showNotice(
        '<div class="form-errors">You are not signed in. Only OWNER, ADMIN and LGA officers ' +
        '(inside their own LGA) can add schools — ' +
        '<a href="/login.html?next=%2Fregister-school.html">sign in</a> first.</div>');
    } else if (user.role === 'SCHOOL_ADMIN') {
      showNotice(
        '<div class="form-errors"><strong>Note:</strong> school administrators cannot add schools ' +
        'to the directory — only OWNER, ADMIN and LGA officers (inside their own LGA) can. ' +
        'Ask your LGA officer to submit this school.</div>');
    } else if (user.role !== 'OWNER' && user.role !== 'ADMIN' && user.role !== 'LGA_OFFICER') {
      showNotice(
        '<div class="form-errors"><strong>Note:</strong> your role (' + App.esc(user.role) +
        ') cannot add schools to the directory. Ask an admin or your LGA officer to submit it.</div>');
    }
  });
})();
