/**
 * public/js/pages/news.js — news archive: search, category filter, paging.
 */
(function () {
  'use strict';

  const grid = document.getElementById('news-grid');
  const pagerHost = document.getElementById('news-pager');
  let page = 1;

  function query() {
    const parts = ['page=' + page, 'limit=9'];
    const q = document.getElementById('q').value.trim();
    const cat = document.getElementById('category').value;
    if (q) parts.push('q=' + encodeURIComponent(q));
    if (cat) parts.push('category=' + encodeURIComponent(cat));
    return '/api/news?' + parts.join('&');
  }

  function card(n) {
    /* Fall back to the ministry's default cover when an item has none. */
    const src = n.cover_image || (App.state.settings && App.state.settings.default_news_cover) || '';
    const cover = src
      ? '<div class="cover"><img src="' + App.esc(src) + '" alt="" loading="lazy" ' +
        'onerror="this.style.display=\'none\'"></div>'
      : '<div class="cover" aria-hidden="true"></div>';
    return '<a class="news-card" href="/news/' + encodeURIComponent(n.slug || n.id) + '">' +
      cover +
      '<div class="body">' +
        '<span class="badge">' + App.esc(n.category || 'News') + '</span>' +
        '<h3>' + App.esc(n.title) + '</h3>' +
        '<p class="summary">' + App.esc((n.summary || '').slice(0, 170)) + '</p>' +
        '<div class="meta">' + App.esc(App.fmtDate(n.published_at || n.created_at)) +
          (n.status === 'draft' ? ' <span class="badge warn">draft</span>' : '') +
        '</div>' +
      '</div></a>';
  }

  function load() {
    grid.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    App.api(query()).then(function (data) {
      grid.innerHTML = data.news.length
        ? data.news.map(card).join('')
        : App.emptyState('Nothing found', 'Try a different search term or category.');
      pagerHost.innerHTML = App.pager(data.page, data.pages);
      App.qsa('#news-pager button[data-page]').forEach(function (btn) {
        App.on(btn, 'click', function () {
          page = Number(btn.getAttribute('data-page')) || 1;
          load();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      });
    }).catch(function (err) {
      grid.innerHTML = App.emptyState('Could not load news', err.message);
    });
  }

  App.ready(function () {
    App.api('/api/news/categories').then(function (data) {
      const sel = document.getElementById('category');
      (data.categories || []).forEach(function (c) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      });
    }).catch(function () { /* categories are optional */ });

    const search = App.debounce(function () { page = 1; load(); }, 300);
    App.on(document.getElementById('q'), 'input', search);
    App.on(document.getElementById('category'), 'change', function () { page = 1; load(); });
    App.on(document.getElementById('search-btn'), 'click', function () { page = 1; load(); });
    load();
  });
})();
