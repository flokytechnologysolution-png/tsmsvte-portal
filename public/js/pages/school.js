/**
 * public/js/pages/school.js — one school record.  Friendly URL /school/:id
 * (rewritten by the server); /school.html?id=N also works.
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

  function idFromPath() {
    const m = window.location.pathname.match(/^\/school\/(\d+)\/?$/);
    return m ? m[1] : (App.param('id') || '');
  }

  App.ready(function () {
    const host = document.getElementById('school-detail');
    const id = idFromPath();
    if (!id) {
      host.innerHTML = App.emptyState('School not found', 'Go back to the directory and pick a school.');
      return;
    }
    App.api('/api/schools/' + encodeURIComponent(id)).then(function (data) {
      const s = data.school;
      document.title = s.name + ' — Schools directory';
      const row = function (k, v, isHtml) {
        if (!v && v !== 0) return '';
        return '<div class="r"><span class="k">' + App.esc(k) + '</span><span class="v">' +
          (isHtml ? v : App.esc(v)) + '</span></div>';
      };
      host.innerHTML =
        '<span class="badge">' + App.esc(TYPE_LABEL[s.type] || s.type) + '</span> ' +
        '<span class="badge info">' + App.esc(CAT_LABEL[s.category] || s.category) + '</span> ' +
        '<span class="badge muted">' + App.esc(s.boarding) + '</span>' +
        '<h1 class="mt-1">' + App.esc(s.name) + '</h1>' +
        '<div class="card">' +
          '<div class="detail-list">' +
            row('LGA', s.lga) +
            row('Address', s.address) +
            row('Principal', s.principal) +
            row('Phone', s.phone
              ? '<a href="tel:' + App.esc(s.phone) + '">' + App.esc(s.phone) + '</a>'
              : '', true) +
            row('Email', s.email
              ? '<a href="mailto:' + App.esc(s.email) + '">' + App.esc(s.email) + '</a>'
              : '', true) +
            row('Year established', s.year_established) +
            row('Record status', '<span class="badge ' + (s.status === 'active' ? 'ok' : 'warn') + '">' + App.esc(s.status) + '</span>', true) +
            row('Last updated', App.fmtDate(s.updated_at)) +
          '</div>' +
        '</div>' +
        '<p class="mt-2"><a class="btn btn-outline btn-sm" href="/schools.html">&larr; Back to directory</a> ' +
        '<a class="btn btn-ghost btn-sm" href="/schools.html?lga=' + encodeURIComponent(s.lga) + '">More in ' + App.esc(s.lga) + '</a></p>';
    }).catch(function (err) {
      host.innerHTML = App.emptyState('School not found', err.status === 404
        ? 'This school record has been removed or the link is wrong.'
        : err.message);
    });
  });
})();
