/**
 * public/js/pages/circulars.js — searchable downloads list.
 */
(function () {
  'use strict';

  const host = document.getElementById('circular-list');

  function load() {
    const q = document.getElementById('q').value.trim();
    const cat = document.getElementById('category').value;
    const parts = [];
    if (q) parts.push('q=' + encodeURIComponent(q));
    if (cat) parts.push('category=' + encodeURIComponent(cat));
    const url = '/api/circulars' + (parts.length ? '?' + parts.join('&') : '');

    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    App.api(url).then(function (data) {
      if (!data.circulars.length) {
        host.innerHTML = App.emptyState('Nothing published yet', 'The ministry has not uploaded any circulars for this filter.');
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Document</th><th>Category</th><th>Published</th><th>Size</th><th></th>' +
        '</tr></thead><tbody>' +
        data.circulars.map(function (c) {
          const draft = c.status !== 'published'
            ? ' <span class="badge warn">' + App.esc(c.status) + '</span>' : '';
          return '<tr>' +
            '<td><strong>' + App.esc(c.title) + '</strong>' + draft +
              (c.description ? '<br><small>' + App.esc(c.description) + '</small>' : '') +
              '<br><small class="muted">' + App.esc(c.file_name || '') + '</small></td>' +
            '<td><span class="badge">' + App.esc(c.category) + '</span></td>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(c.created_at)) + '</td>' +
            '<td class="nowrap">' + App.esc(App.fmtSize(c.file_size)) + '</td>' +
            '<td class="actions"><a class="btn btn-sm btn-outline" href="' + App.esc(c.file_path) +
              '" target="_blank" rel="noopener">Open</a></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      /* Category chips come back with the list; keep the select in sync. */
      const sel = document.getElementById('category');
      if (sel.options.length === 1) {
        (data.categories || []).forEach(function (c) {
          const opt = document.createElement('option');
          opt.value = c;
          opt.textContent = c;
          sel.appendChild(opt);
        });
      }
    }).catch(function (err) {
      host.innerHTML = App.emptyState('Could not load downloads', err.message);
    });
  }

  App.ready(function () {
    const search = App.debounce(load, 300);
    App.on(document.getElementById('q'), 'input', search);
    App.on(document.getElementById('category'), 'change', load);
    App.on(document.getElementById('search-btn'), 'click', load);
    load();
  });
})();
