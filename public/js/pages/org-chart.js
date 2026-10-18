/**
 * public/js/pages/org-chart.js — renders the ministry organization chart on
 * the public homepage from GET /api/org-chart (published entries only).
 *
 * The API returns a flat list; this file rebuilds the parent/child hierarchy
 * and draws the ministry's structure out of pure HTML + CSS (no chart
 * library, no canvas, no SVG connectors):
 *
 *   • a vertical CHAIN for the leadership spine (root -> ... -> last link),
 *   • a SIDE GROUP hanging beside the chain node it reports to — the agencies
 *     attached to the Permanent Secretary, joined by a horizontal line,
 *   • one horizontal BRANCH row for the reports of the last chain node,
 *   • their SUB-UNITS hanging underneath each branch card.
 *
 * The shape is derived from the data, never hard-coded: the spine keeps
 * following its single continuing report while the other reports stay beside
 * it (at most MAX_SIDE_GROUP side entries); the node where several reports
 * lead further on becomes the branch row.
 *
 * Every position without an uploaded portrait shows
 * /img/placeholder-portrait.svg, and an image that fails to load falls back
 * to the same file.  All text is escaped; a portrait is only ever shown from
 * the portal's own /files/<id> storage or the placeholder.  When nothing is
 * published (or the request fails) a neutral message appears — this chart
 * never invents names, titles or photographs.
 */
(function () {
  'use strict';

  /* Idempotent: a duplicate script tag must never double-wire the section. */
  if (window.__orgChartLoaded) return;
  window.__orgChartLoaded = true;

  var HOST_ID = 'org-chart';
  var PLACEHOLDER = '/img/placeholder-portrait.svg';
  /* Must mirror the server's rule in routes/org-chart.js: only portal-stored
   * images, never an outside link. */
  var FILE_URL_RE = /^\/files\/[a-f0-9]{24}$/;
  var CATEGORY_LABEL = {
    leadership: 'Leadership',
    directorate: 'Directorate',
    unit_board: 'Unit & Board'
  };
  /* How many childless reports may sit beside a chain link as a side group
   * before that link is treated as the branch row instead. */
  var MAX_SIDE_GROUP = 3;

  function host() { return document.getElementById(HOST_ID); }

  function show(html) {
    var el = host();
    if (el) el.innerHTML = html;
  }

  function portraitOf(entry) {
    var s = String(entry.portrait || '').trim();
    if (FILE_URL_RE.test(s)) return { src: s, placeholder: false };
    return { src: PLACEHOLDER, placeholder: true };
  }

  /* Cards never break the chart: a portrait that fails to load swaps itself
   * for the placeholder exactly once (data-fallback stops any loop). */
  function wireFallback(el) {
    if (!el || el.__orgFallback) return;
    el.__orgFallback = true;
    el.addEventListener('error', function (ev) {
      var t = ev.target;
      if (t && t.tagName === 'IMG' && t.getAttribute('data-fallback') !== '1') {
        t.setAttribute('data-fallback', '1');
        t.setAttribute('src', PLACEHOLDER);
      }
    }, true);
  }

  /* variant: 'chain' (leadership spine, full card) | 'compact' (branch row and
   * side group) | 'unit' (sub-unit hanging under a branch card). */
  function cardHtml(entry, variant) {
    var p = portraitOf(entry);
    var name = String(entry.name || '').trim();
    var title = String(entry.title || '').trim();
    var description = String(entry.description || '').trim();
    var alt = name ? 'Portrait of ' + name : 'Portrait placeholder for ' + title;
    var cat = variant === 'chain' ? (CATEGORY_LABEL[entry.category] || '') : '';
    return '<article class="org-card org-card--' + variant +
        (p.placeholder ? ' is-placeholder' : '') + '">' +
      '<div class="org-portrait"><img src="' + App.esc(p.src) + '" alt="' +
        App.esc(alt) + '" loading="lazy"></div>' +
      '<div class="org-info">' +
        (cat ? '<span class="org-cat">' + App.esc(cat) + '</span>' : '') +
        '<h4 class="org-title">' + App.esc(title) + '</h4>' +
        (name ? '<p class="org-name">' + App.esc(name) + '</p>' : '') +
        (description ? '<p class="org-desc">' + App.esc(description) + '</p>' : '') +
      '</div>' +
    '</article>';
  }

  /* The sub-units hanging under a branch card. `seen` keeps a corrupted parent
   * loop from ever recursing forever. */
  function unitsHtml(entry, childMap, seen) {
    var kids = childMap[entry.id] || [];
    if (!kids.length) return '';
    seen = seen || {};
    return '<div class="org-drop"><ul class="org-units">' +
      kids.map(function (k) {
        if (seen[k.id]) return '';
        seen[k.id] = true;
        return '<li class="org-unit">' + cardHtml(k, 'unit') +
          unitsHtml(k, childMap, seen) + '</li>';
      }).join('') +
    '</ul></div>';
  }
  function sortList(list) {
    list.sort(function (a, b) {
      return (Number(a.sort_order || 0) - Number(b.sort_order || 0)) ||
        String(a.title || '').localeCompare(String(b.title || '')) ||
        (Number(a.id) - Number(b.id));
    });
    return list;
  }

  /* Turn the flat published list into { spine, side, branch, childMap }. */
  function buildLayout(entries) {
    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });

    var childMap = {};
    entries.forEach(function (e) {
      /* An entry whose parent is missing from the published set (for example
       * its parent is still a draft) is shown at the top level rather than
       * dropped, so no verified entry ever disappears. */
      if (e.parent_id === null || e.parent_id === undefined || !byId[e.parent_id]) return;
      if (!childMap[e.parent_id]) childMap[e.parent_id] = [];
      childMap[e.parent_id].push(e);
    });
    Object.keys(childMap).forEach(function (k) { sortList(childMap[k]); });

    var roots = sortList(entries.filter(function (e) {
      return e.parent_id === null || e.parent_id === undefined || !byId[e.parent_id];
    }));
    if (!roots.length) return null;

    /* Height of the chain below an entry (memoised, cycle guarded). */
    var heights = {};
    function heightOf(e, guard) {
      if (heights[e.id] !== undefined) return heights[e.id];
      guard = guard || {};
      if (guard[e.id]) return 1;
      guard[e.id] = true;
      var kids = childMap[e.id] || [];
      var h = 1;
      kids.forEach(function (k) { h = Math.max(h, 1 + heightOf(k, guard)); });
      heights[e.id] = h;
      return h;
    }

    /* The chain starts at the root that reaches deepest, so a stray extra
     * top-level entry can never displace the leadership spine. */
    var start = roots[0];
    roots.forEach(function (r) {
      if (heightOf(r) > heightOf(start)) start = r;
    });

    var spine = [];
    var side = {};
    var used = {};
    var cur = start;
    while (cur && !used[cur.id]) {
      used[cur.id] = true;
      spine.push(cur);
      var kids = childMap[cur.id] || [];
      if (!kids.length) break;
      var continuing = kids.filter(function (k) {
        return (childMap[k.id] || []).length > 0;
      });
      if (continuing.length === 1 && (kids.length - continuing.length) <= MAX_SIDE_GROUP) {
        var next = continuing[0];
        var others = kids.filter(function (k) { return k.id !== next.id; });
        if (others.length) side[cur.id] = others;
        cur = next;
        continue;
      }
      break; /* several reports lead on — this node feeds the branch row. */
    }

    var branch = (childMap[cur.id] || []).slice();
    /* Further top-level entries ride along in the branch row: published work
     * is never hidden just because it sits outside the main spine. */
    roots.forEach(function (r) { if (r.id !== start.id) branch.push(r); });

    return { spine: spine, side: side, branch: branch, childMap: childMap };
  }

  function render(layout) {
    var spineHtml = layout.spine.map(function (e) {
      var group = layout.side[e.id] || [];
      var groupHtml = group.length
        ? '<aside class="org-side-group"><ul class="org-side-list">' +
            group.map(function (s) {
              return '<li class="org-side-item">' + cardHtml(s, 'compact') + '</li>';
            }).join('') +
          '</ul></aside>'
        : '';
      return '<li class="org-spine-item"><div class="org-spine-slot">' +
        cardHtml(e, 'chain') + groupHtml + '</div></li>';
    }).join('');

    var branchHtml = '';
    if (layout.branch.length) {
      branchHtml = '<div class="org-branch">' +
        '<div class="org-branch-scroll"><ul class="org-branch-row">' +
          layout.branch.map(function (e) {
            return '<li class="org-branch-item">' + cardHtml(e, 'compact') +
              unitsHtml(e, layout.childMap, {}) + '</li>';
          }).join('') +
        '</ul></div>' +
        '<p class="org-scroll-hint" id="org-scroll-hint" hidden>' +
          'Scroll sideways to see every position on this level.</p>' +
      '</div>';
    }

    return '<div class="org-tree">' +
      '<ul class="org-spine">' + spineHtml + '</ul>' +
      branchHtml +
    '</div>';
  }

  /* The hint only appears when the branch row really is cut off. */
  function checkHint() {
    var hint = document.getElementById('org-scroll-hint');
    var scroller = document.querySelector('.org-branch-scroll');
    if (!hint || !scroller) return;
    if (scroller.scrollWidth > scroller.clientWidth + 4) hint.removeAttribute('hidden');
  }
  function load() {
    show('<div class="empty-state"><strong>Loading&hellip;</strong></div>');
    wireFallback(host());
    App.api('/api/org-chart').then(function (data) {
      var entries = (data && data.entries) || [];
      var layout = entries.length ? buildLayout(entries) : null;
      if (!layout || !layout.spine.length) {
        show('<div class="empty-state"><strong>Organization chart is being updated.</strong> ' +
          'The ministry is verifying the details of its leadership and structure.</div>');
        return;
      }
      show(render(layout));
      checkHint();
    }).catch(function () {
      show('<div class="empty-state"><strong>Organization chart is temporarily unavailable.</strong> ' +
        'Please refresh the page in a moment.</div>');
    });
  }

  App.ready(function () { load(); });

  /* Exposed for tools/test-org-chart.js (it runs this file in a sandbox with a
   * stubbed window/App); the page's own behaviour is unchanged. */
  window.__orgChart = { buildLayout: buildLayout, render: render, cardHtml: cardHtml };

})();
