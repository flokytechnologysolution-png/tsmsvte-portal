/**
 * public/js/pages/org-chart.js — renders the ministry organization chart on
 * the public homepage from GET /api/org-chart (published entries only).
 *
 * The API returns a flat list; this file rebuilds the parent/child hierarchy
 * and draws the ministry's structure out of pure HTML + CSS (no chart
 * library, no canvas, no SVG connectors):
 *
 *   • a horizontal TOP ROW for the extra leadership roots — the Governor and
 *     the Secretary to the Government sit above the chain, on a rail that
 *     feeds down into it (as on the ministry's chart diagram); any children
 *     they have hang underneath their card,
 *   • a vertical CHAIN for the main reporting line (deepest root -> ... ->
 *     last link), walked one single child at a time regardless of category,
 *   • one horizontal DIRECTOR ROW for the reports of the last chain link,
 *   • their SUB-UNITS hanging underneath each director card, each set on its
 *     own horizontal rail so every units row starts at the same height.
 *
 * The shape is derived from the data, never hard-coded: the chain keeps
 * following its single continuing report while the other reports share one
 * horizontal director row; the node where several reports lead further on
 * feeds that row.  Every published entry appears exactly once — entries whose
 * parent is not published are shown at the top level rather than dropped.
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

  /* variant: 'chain' (leadership spine / top row, full card) |
   * 'compact' (director row) | 'unit' (sub-unit under a director). */
  function cardHtml(entry, variant) {
    var p = portraitOf(entry);
    var name = String(entry.name || '').trim();
    var title = String(entry.title || '').trim();
    var description = String(entry.description || '').trim();
    var alt = name ? 'Portrait of ' + name : 'Portrait placeholder for ' + title;
    var cat = variant === 'chain' ? (CATEGORY_LABEL[entry.category] || '') : '';
    return '<article class="org-card org-card--' + variant +
        (p.placeholder ? ' is-placeholder' : '') + '" data-id="' + App.esc(entry.id) + '">' +
      '<div class="org-portrait"><img src="' + App.esc(p.src) + '" alt="' +
        App.esc(alt) + '" loading="lazy" data-fallback="1"></div>' +
      '<div class="org-info">' +
        (cat ? '<span class="org-cat">' + App.esc(cat) + '</span>' : '') +
        '<h4 class="org-title">' + App.esc(title) + '</h4>' +
        (name ? '<p class="org-name">' + App.esc(name) + '</p>' : '') +
        (description ? '<p class="org-desc">' + App.esc(description) + '</p>' : '') +
      '</div>' +
    '</article>';
  }

  /* The sub-units hanging under a card, each set on its own rail row. `seen`
   * keeps a corrupted parent loop from ever recursing forever. */
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

  /* Turn the flat published list into { spine, side, branch, top, childMap }.
   * Category-agnostic: the chain follows the single continuing report from
   * the deepest root, whatever its category; the first node with anything
   * other than exactly one child stops the chain and feeds the director row.
   * Extra true roots (no parent) ride ABOVE the chain; an entry whose parent
   * id is set but not published joins the director row so it is never lost. */
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
     * top-level entry can never displace the main reporting line. */
    var start = roots[0];
    roots.forEach(function (r) {
      if (heightOf(r) > heightOf(start)) start = r;
    });

    var spine = [];
    var used = {};
    var cur = start;
    while (cur && !used[cur.id]) {
      used[cur.id] = true;
      spine.push(cur);
      var kids = childMap[cur.id] || [];
      if (kids.length !== 1) break;   /* several reports feed the director row */
      cur = kids[0];
    }

    var branch = (childMap[cur.id] || []).slice();
    /* Further top-level entries are never hidden: parentless roots are lifted
     * ABOVE the chain onto their own rail; an entry whose parent id points at
     * an unpublished row still rides along in the director row. */
    var top = [];
    roots.forEach(function (r) {
      if (r.id === start.id) return;
      if (r.parent_id === null || r.parent_id === undefined) top.push(r);
      else branch.push(r);
    });

    return { spine: spine, side: {}, branch: branch, top: top, childMap: childMap };
  }

  function render(layout) {
    /* The extra leadership roots sit above the chain, on their own rail,
     * with any of their own reports hanging underneath. */
    var topHtml = '';
    if (layout.top && layout.top.length) {
      topHtml = '<div class="org-leaders"><ul class="org-leaders-row">' +
        layout.top.map(function (e) {
          return '<li class="org-leaders-item">' + cardHtml(e, 'chain') +
            unitsHtml(e, layout.childMap, {}) + '</li>';
        }).join('') +
      '</ul></div>';
    }
    var spineHtml = layout.spine.map(function (e) {
      return '<li class="org-spine-item"><div class="org-spine-slot">' +
        cardHtml(e, 'chain') + '</div></li>';
    }).join('');

    var branchHtml = '';
    if (layout.branch.length) {
      branchHtml = '<div class="org-branch">' +
        '<ul class="org-branch-row">' +
          layout.branch.map(function (e) {
            return '<li class="org-branch-item">' + cardHtml(e, 'compact') +
              unitsHtml(e, layout.childMap, {}) + '</li>';
          }).join('') +
        '</ul>' +
      '</div>';
    }

    return '<div class="org-scroll"><div class="org-tree">' + topHtml +
      '<ul class="org-spine">' + spineHtml + '</ul>' +
      branchHtml +
    '</div></div>' +
    '<div class="org-scroll-bar" hidden>' +
      '<button type="button" class="org-scroll-btn org-scroll-btn--prev" ' +
        'aria-label="Scroll the chart to the left">&larr;</button>' +
      '<span class="org-scroll-hint">Scroll to see all departments</span>' +
      '<button type="button" class="org-scroll-btn org-scroll-btn--next" ' +
        'aria-label="Scroll the chart to the right">&rarr;</button>' +
    '</div>';
  }

  /* The rails keep FULL card sizes — never scaled to dust.  When the chart
   * is wider than the homepage slot it scrolls sideways INSIDE its own frame,
   * with a hint and prev/next buttons; the page itself never scrolls
   * sideways.  The bar only appears when the tree really overflows (the
   * stacked layout below 900px never needs it). */
  function wireScroll() {
    var el = host();
    if (!el || !el.querySelector) return;
    var scroller = el.querySelector('.org-scroll');
    var bar = el.querySelector('.org-scroll-bar');
    if (!scroller || !bar) return;
    var prev = bar.querySelector('.org-scroll-btn--prev');
    var next = bar.querySelector('.org-scroll-btn--next');
    function update() {
      if (window.innerWidth < 900) { bar.hidden = true; return; }
      var over = scroller.scrollWidth - scroller.clientWidth > 1;
      bar.hidden = !over;
      if (!over) return;
      prev.disabled = scroller.scrollLeft <= 1;
      next.disabled = scroller.scrollLeft >= scroller.scrollWidth - scroller.clientWidth - 1;
    }
    function step(dir) {
      var by = Math.max(240, Math.round(scroller.clientWidth * 0.6));
      if (scroller.scrollBy) scroller.scrollBy({ left: dir * by, behavior: 'smooth' });
      else scroller.scrollLeft += dir * by;
    }
    if (!el.__orgScrollWired) {
      el.__orgScrollWired = true;
      if (prev && next) {
        prev.addEventListener('click', function () { step(-1); });
        next.addEventListener('click', function () { step(1); });
      }
      scroller.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
    }
    update();
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
      wireScroll();
    }).catch(function () {
      show('<div class="empty-state"><strong>Organization chart is temporarily unavailable.</strong> ' +
        'Please refresh the page in a moment.</div>');
    });
  }

  App.ready(function () { load(); });

  /* Exposed for tools/test-org-chart.js (it runs this file in a sandbox with a
   * stubbed window/App); the page's own behaviour is unchanged. */
  window.__orgChart = { buildLayout: buildLayout, render: render, cardHtml: cardHtml, wireScroll: wireScroll };

})();
