/**
 * public/js/pages/faq.js — searchable FAQ accordion.
 */
(function () {
  'use strict';

  const host = document.getElementById('faq-list');

  function load() {
    const q = document.getElementById('q').value.trim();
    const cat = document.getElementById('category').value;
    const parts = [];
    if (q) parts.push('q=' + encodeURIComponent(q));
    if (cat) parts.push('category=' + encodeURIComponent(cat));

    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    App.api('/api/faqs' + (parts.length ? '?' + parts.join('&') : '')).then(function (data) {
      if (!data.faqs.length) {
        host.innerHTML = App.emptyState('No matching questions', 'Try another keyword, or ask the assistant below.');
        return;
      }
      host.innerHTML = data.faqs.map(function (f) {
        const draft = f.status === 'draft' ? ' <span class="badge warn">draft</span>' : '';
        return '<details class="faq-item">' +
          '<summary>' + App.esc(f.question) + draft + '</summary>' +
          '<div class="answer">' + App.esc(f.answer) + '</div>' +
        '</details>';
      }).join('');

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
      host.innerHTML = App.emptyState('Could not load questions', err.message);
    });
  }

  App.ready(function () {
    const search = App.debounce(load, 300);
    App.on(document.getElementById('q'), 'input', search);
    App.on(document.getElementById('category'), 'change', load);
    App.on(document.getElementById('search-btn'), 'click', load);
    App.on(document.getElementById('open-chat-btn'), 'click', function () {
      const fab = document.getElementById('chat-fab');
      if (fab) fab.click();
    });
    load();
  });
})();
