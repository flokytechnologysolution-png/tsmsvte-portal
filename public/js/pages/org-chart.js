/**
 * public/js/pages/org-chart.js — renders the ministry organization chart on
 * the public homepage from GET /api/org-chart (published entries only).
 *
 * The API returns a flat list; this file rebuilds the parent/child hierarchy
 * and draws it as nested levels.  Every piece of text is escaped and a portrait
 * is only shown when it points at the portal's own /files/<id> storage.  When
 * nothing is published (or the request fails) a neutral message appears — the
 * chart never invents names, titles or photographs.
 */
(function () {
  'use strict';

  /* Idempotent: a duplicate script tag must never double-wire the section. */
  if (window.__orgChartLoaded) return;
  window.__orgChartLoaded = true;

  var HOST_ID = 'org-chart';
  /* Must mirror the server's rule in routes/org-chart.js: only portal-stored
   * images, never an outside link. */
  var FILE_URL_RE = /^\/files\/[a-f0-9]{24}$/;
  var CATEGORY_LABEL = {
    leadership: 'Leadership',
    directorate: 'Directorate',
    unit_board: 'Unit & Board'
  };

  function host() { return document.getElementById(HOST_ID); }

  function show(html) {
    var el = host();
    if (el) el.innerHTML = html;
  }

  function portraitSrc(url) {
    var s = String(url || '').trim();
    return FILE_URL_RE.test(s) ? s : '';
  }

  function cardHtml(entry) {
    var src = portraitSrc(entry.portrait);
    var name = String(entry.name || '').trim();
    var cat = CATEGORY_LABEL[entry.category] || '';
    var description = String(entry.description || '').trim();
    var portrait = src
      ? '<div class="org-portrait"><img src="' + App.esc(src) + '" alt="' +
        App.esc(name ? 'Portrait of ' + name : 'Official portrait') +
        '" loading="lazy"></div>'
      : '';
    return '<article class="org-card' + (src ? ' has-portrait' : '') + '">' +
      portrait +
      '<div class="org-info">' +
        (cat ? '<span class="org-cat">' + App.esc(cat) + '</span>' : '') +
        '<h4 class="org-title">' + App.esc(entry.title) + '</h4>' +
        (name ? '<p class="org-name">' + App.esc(name) + '</p>' : '') +
        (description ? '<p class="org-desc">' + App.esc(entry.description) + '</p>' : '') +
      '</div>' +
    '</article>';
  }

  function nodeHtml(node) {
    var kids = (node.children || []).map(nodeHtml).join('');
    return '<li class="org-node">' + cardHtml(node.entry) +
      (kids ? '<ul class="org-children">' + kids + '</ul>' : '') + '</li>';
  }

  function buildTree(entries) {
    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });

    var childMap = {};
    entries.forEach(function (e) {
      /* An entry whose parent is missing from the published set (for example
       * its parent is still a draft) is shown at the top level rather than
       * dropped, so no verified entry ever disappears. */
      if (e.parent_id === null || e.parent_id === undefined || !byId[e.parent_id]) {
        return; /* handled below */
      }
      if (!childMap[e.parent_id]) childMap[e.parent_id] = [];
      childMap[e.parent_id].push(e);
    });

    function sortList(list) {
      list.sort(function (a, b) {
        return (Number(a.sort_order || 0) - Number(b.sort_order || 0)) ||
          String(a.title || '').localeCompare(String(b.title || '')) ||
          (Number(a.id) - Number(b.id));
      });
    }

    var roots = entries.filter(function (e) {
      return e.parent_id === null || e.parent_id === undefined || !byId[e.parent_id];
    });
    sortList(roots);

    /* `seen` guards against a corrupted loop ever causing infinite recursion. */
    var seen = {};
    function wrap(list) {
      sortList(list);
      return list.map(function (e) {
        if (seen[e.id]) return { entry: e, children: [] };
        seen[e.id] = true;
        return { entry: e, children: wrap(childMap[e.id] || []) };
      });
    }
    return wrap(roots);
  }

  function load() {
    show('<div class="empty-state"><strong>Loading&hellip;</strong></div>');
    App.api('/api/org-chart').then(function (data) {
      var entries = (data && data.entries) || [];
      if (!entries.length) {
        show('<div class="empty-state"><strong>Organization chart is being updated.</strong>' +
          'The ministry is verifying the details of its leadership and structure.</div>');
        return;
      }
      var tree = buildTree(entries);
      show('<ul class="org-level org-roots">' + tree.map(nodeHtml).join('') + '</ul>');
    }).catch(function () {
      show('<div class="empty-state"><strong>Organization chart is temporarily unavailable.</strong>' +
        'Please refresh the page in a moment.</div>');
    });
  }

  App.ready(function () { load(); });
})();
