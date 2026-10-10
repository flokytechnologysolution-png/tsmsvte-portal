/**
 * public/js/pages/events.js — the public events list.
 *
 * Same shape as pages/news.js: a search box that reloads the list, cards
 * built from the API, and every string passed through App.esc.
 */
(function () {
  'use strict';

  function fmtDate(value) {
    if (!value) return 'Date to be announced';
    var d = new Date(String(value).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'
    });
  }

  function card(e) {
    var img = e.image
      ? '<div class="cover"><img src="' + App.esc(e.image) + '" alt="" loading="lazy"></div>'
      : '';
    return '<article class="card event-card">' +
      img +
      '<div class="event-body">' +
        '<p class="event-when">' + App.esc(fmtDate(e.event_date)) + '</p>' +
        '<h2 class="event-title">' + App.esc(e.title) + '</h2>' +
        (e.location ? '<p class="muted event-where">Where: ' + App.esc(e.location) + '</p>' : '') +
        (e.description ? '<p class="event-desc">' + App.esc(e.description) + '</p>' : '') +
      '</div>' +
    '</article>';
  }

  function render(list, host, emptyTitle, emptyNote) {
    host.innerHTML = list.length
      ? list.map(card).join('')
      : App.emptyState(emptyTitle, emptyNote);
  }

  App.ready(function () {
    var q = document.getElementById('q');
    var host = document.getElementById('events-list');
    var pastWrap = document.getElementById('past-toggle-wrap');
    var pastHost = document.getElementById('past-list');
    var pastBtn = document.getElementById('past-toggle');
    var showPast = false;

    function load() {
      var parts = [];
      if (q && q.value.trim()) parts.push('q=' + encodeURIComponent(q.value.trim()));
      var url = '/api/events' + (parts.length ? '?' + parts.join('&') : '');

      App.api(url).then(function (d) {
        render(d.events || [], host, 'No events coming up',
          'When the ministry schedules something, it will appear here.');

        if (!showPast) {
          pastHost.innerHTML = '';
          pastWrap.hidden = true;
          return;
        }
        /* Past events are fetched on their own so the main list stays upcoming. */
        var pastParts = ['past=1'];
        if (q && q.value.trim()) pastParts.push('q=' + encodeURIComponent(q.value.trim()));
        return App.api('/api/events?' + pastParts.join('&')).then(function (p) {
          pastWrap.hidden = false;
          pastBtn.textContent = 'Hide past events';
          render(p.events || [], pastHost, 'No past events', 'Nothing to show here.');
        });
      }).catch(function (err) {
        host.innerHTML = App.emptyState('Could not load events', err.message);
      });
    }

    App.on(q, 'input', App.debounce(load, 300));
    App.on(document.getElementById('search-btn'), 'click', load);
    App.on(pastBtn, 'click', function () {
      showPast = !showPast;
      if (!showPast) {
        pastHost.innerHTML = '';
        pastWrap.hidden = true;
      } else {
        pastBtn.textContent = 'Hide past events';
        load();
      }
    });

    load();
  });
})();