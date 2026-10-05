/**
 * public/js/pages/schools.js — filterable schools directory with paging.
 * Reads ?lga= (home page LGA chips deep-link here).
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

  const grid = document.getElementById('school-grid');
  const pagerHost = document.getElementById('school-pager');
  const countEl = document.getElementById('school-count');
  let page = 1;

  function val(id) { return document.getElementById(id).value; }

  function query() {
    const parts = ['page=' + page, 'limit=12'];
    ['q', 'lga', 'type', 'category', 'boarding'].forEach(function (k) {
      const v = val(k);
      if (v) parts.push(k + '=' + encodeURIComponent(v));
    });
    return '/api/schools?' + parts.join('&');
  }

  function card(s) {
    return '<a class="news-card" href="/school/' + s.id + '">' +
      '<div class="body">' +
        '<div class="spread"><span class="badge">' + App.esc(TYPE_LABEL[s.type] || s.type) + '</span>' +
          '<span class="badge info">' + App.esc(CAT_LABEL[s.category] || s.category) + '</span></div>' +
        '<h3>' + App.esc(s.name) + '</h3>' +
        '<p class="summary">' + App.esc(s.address || '') + '</p>' +
        '<div class="meta"><span>' + App.esc(s.lga) + ' LGA</span>' +
          (s.principal ? '<span>· Principal: ' + App.esc(s.principal) + '</span>' : '') +
        '</div>' +
      '</div></a>';
  }

  function load() {
    grid.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    App.api(query()).then(function (data) {
      countEl.textContent = data.total + ' school' + (data.total === 1 ? '' : 's') + ' found';
      grid.innerHTML = data.schools.length
        ? data.schools.map(card).join('')
        : App.emptyState('No schools match', 'The ministry adds schools from the admin dashboard — try clearing the filters.');
      pagerHost.innerHTML = App.pager(data.page, data.pages);
      App.qsa('#school-pager button[data-page]').forEach(function (btn) {
        App.on(btn, 'click', function () {
          page = Number(btn.getAttribute('data-page')) || 1;
          load();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      });
    }).catch(function (err) {
      grid.innerHTML = App.emptyState('Could not load schools', err.message);
    });
  }

  function fillSelect(id, items, labelFn, valueFn) {
    const sel = document.getElementById(id);
    (items || []).forEach(function (it) {
      const opt = document.createElement('option');
      opt.value = valueFn ? valueFn(it) : it;
      opt.textContent = labelFn ? labelFn(it) : it;
      sel.appendChild(opt);
    });
  }

  App.ready(function () {
    App.api('/api/schools/options').then(function (o) {
      fillSelect('lga', o.lgas, function (l) { return l.name; }, function (l) { return l.name; });
      fillSelect('type', o.types, function (t) { return TYPE_LABEL[t] || t; });
      fillSelect('category', o.categories, function (c) { return CAT_LABEL[c] || c; });
      fillSelect('boarding', o.boarding, function (b) { return b.charAt(0).toUpperCase() + b.slice(1); });
      /* Deep link from the home page LGA chips. */
      const preset = App.param('lga');
      if (preset) document.getElementById('lga').value = preset;
      load();
    }).catch(function (err) {
      grid.innerHTML = App.emptyState('Could not load filter options', err.message);
    });

    const search = App.debounce(function () { page = 1; load(); }, 300);
    App.on(document.getElementById('q'), 'input', search);
    ['lga', 'type', 'category', 'boarding'].forEach(function (id) {
      App.on(document.getElementById(id), 'change', function () { page = 1; load(); });
    });
    App.on(document.getElementById('search-btn'), 'click', function () { page = 1; load(); });
    App.on(document.getElementById('reset-btn'), 'click', function () {
      ['q', 'lga', 'type', 'category', 'boarding'].forEach(function (id) {
        document.getElementById(id).value = '';
      });
      page = 1;
      load();
    });
  });
})();
