/**
 * public/js/pages/home.js — assembles the landing page entirely from the
 * settings table and the public API.  No copy is hardcoded here: placeholders
 * entered by the ministry render exactly as stored.
 */
(function () {
  'use strict';

  function put(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '';
  }

  /* Point an <img> at a settings value. If the file is missing the image is
   * hidden and the brand-tinted box behind it is shown instead, so a page
   * never shows a broken-image icon. */
  function setPhoto(id, src) {
    const img = document.getElementById(id);
    if (!img) return;
    if (!src) { img.classList.add('is-broken'); return; }
    img.onerror = function () { img.classList.add('is-broken'); };
    img.src = src;
  }

  function renderSettings(s) {
    put('hero-heading', s.hero_heading);
    put('hero-sub', s.hero_subheading);
    put('banner1-title', s.free_education_banner_title);
    put('banner1-text', s.free_education_banner_text);
    put('banner2-title', s.girl_child_banner_title);
    put('banner2-text', s.girl_child_banner_text);

    /* programme banners */
    setPhoto('banner1-img', s.free_education_banner_image);
    setPhoto('banner2-img', s.girl_child_banner_image);

    /* governor */
    setPhoto('gov-photo', s.governor_photo);
    put('gov-name', s.governor_name);
    put('gov-title', s.governor_title);
    put('gov-vision-free', s.governor_vision_free_education);
    put('gov-vision-girl', s.governor_vision_girl_child);
    put('gov-note', s.governor_vision_note);

    /* commissioner */
    setPhoto('comm-photo', s.commissioner_photo);
    put('comm-name', s.commissioner_name);
    put('comm-title', s.commissioner_title);
    put('comm-message', s.commissioner_message);

    /* gallery */
    setPhoto('gal1-img', s.about_gallery_image_1);
    setPhoto('gal2-img', s.about_gallery_image_2);

    put('about-mission', s.mission);
    put('about-vision', s.vision);
    put('about-history', s.about_history);

    const fns = document.getElementById('about-functions');
    if (fns) {
      const lines = String(s.about_functions || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      fns.innerHTML = lines.length
        ? lines.map(function (l) { return '<li>' + App.esc(l) + '</li>'; }).join('')
        : '<li class="muted">' + App.esc(s.about_functions || 'Not yet entered.') + '</li>';
    }

    const hero = document.getElementById('hero');
    if (hero && s.hero_image) {
      hero.style.backgroundImage = 'url("' + s.hero_image + '")';
      hero.classList.add('has-image');
    }

    const contact = document.getElementById('contact-list');
    if (contact) {
      const rows = [
        ['Address', s.contact_address],
        ['Phone', s.contact_phone],
        ['Email', s.contact_email],
        ['Office hours', s.office_hours]
      ];
      contact.innerHTML = rows.map(function (r) {
        if (!r[1]) return '';
        return '<div class="r"><span class="k">' + App.esc(r[0]) + '</span><span class="v">' + App.esc(r[1]) + '</span></div>';
      }).join('');
    }
  }

  function renderStats(stats) {
    const host = document.getElementById('hero-stats');
    if (!host || !stats) return;
    const items = [
      [stats.lgas, 'LGAs'],
      [stats.schools, 'Schools'],
      [stats.staff, 'Staff'],
      [stats.news, 'News items'],
      [stats.circulars, 'Circulars']
    ];
    host.innerHTML = items.map(function (it) {
      if (it[0] === undefined || it[0] === null) return '';
      return '<div class="item"><div class="num">' + Number(it[0]) + '</div><div class="label">' + App.esc(it[1]) + '</div></div>';
    }).join('');
  }
    function newsCard(n) {
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
        '<p class="summary">' + App.esc((n.summary || '').slice(0, 150)) + '</p>' +
        '<div class="meta">' + App.esc(App.fmtDate(n.published_at || n.created_at)) + '</div>' +
      '</div></a>';
  }

  function loadNews() {
    App.api('/api/news?limit=3').then(function (data) {
      const host = document.getElementById('home-news');
      if (!host) return;
      host.innerHTML = data.news.length
        ? data.news.map(newsCard).join('')
        : App.emptyState('No news published yet', 'The ministry has not posted any news items.');
    }).catch(function () {
      const host = document.getElementById('home-news');
      if (host) host.innerHTML = App.emptyState('Could not load news', 'Please refresh the page.');
    });
  }

  function loadEvents() {
    App.api('/api/events').then(function (data) {
      const host = document.getElementById('home-events');
      if (!host) return;
      const list = (data.events || []).slice(0, 3);
      if (!list.length) {
        host.innerHTML = App.emptyState('No events coming up',
          'Meetings and workshops announced by the ministry will appear here.');
        return;
      }
      host.innerHTML = list.map(function (e) {
        const when = App.fmtDate(e.event_date);
        return '<article class="card event-card compact">' +
          '<div class="event-body">' +
            '<p class="event-when">' + App.esc(when) + '</p>' +
            '<h3 class="event-title">' + App.esc(e.title) + '</h3>' +
            (e.location ? '<p class="muted event-where">Where: ' + App.esc(e.location) + '</p>' : '') +
          '</div>' +
        '</article>';
      }).join('');
    }).catch(function () {
      const host = document.getElementById('home-events');
      if (host) host.innerHTML = App.emptyState('Could not load events', 'Please refresh the page.');
    });
  }

  function loadCirculars() {
    App.api('/api/circulars').then(function (data) {
      const host = document.getElementById('home-circulars');
      if (!host) return;
      if (!data.circulars.length) {
        host.innerHTML = App.emptyState('No circulars published', 'Check the downloads page later.');
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Title</th><th>Category</th><th>Published</th><th></th>' +
        '</tr></thead><tbody>' +
        data.circulars.slice(0, 6).map(function (c) {
          return '<tr>' +
            '<td>' + App.esc(c.title) + (c.description ? '<br><small>' + App.esc(c.description.slice(0, 120)) + '</small>' : '') + '</td>' +
            '<td><span class="badge">' + App.esc(c.category) + '</span></td>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(c.created_at)) + '</td>' +
            '<td class="actions"><a class="btn btn-sm btn-outline" href="' + App.esc(c.file_path) + '" target="_blank" rel="noopener">Download</a></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }).catch(function () { /* section stays as-is */ });
  }

  function loadLgas() {
    App.api('/api/schools/lgas').then(function (data) {
      const host = document.getElementById('home-lgas');
      if (!host) return;
      host.innerHTML = data.lgas.map(function (l) {
        return '<a class="lga-chip" href="/schools.html?lga=' + encodeURIComponent(l.name) + '">' +
          '<span>' + App.esc(l.name) + '</span>' +
          '<span class="count">' + l.total + '</span>' +
        '</a>';
      }).join('');
    }).catch(function () { /* ignore */ });
  }

  function faqItem(f) {
    return '<details class="faq-item">' +
      '<summary>' + App.esc(f.question) + (f.status === 'draft' ? ' <span class="badge warn">draft</span>' : '') + '</summary>' +
      '<div class="answer">' + App.esc(f.answer) + '</div>' +
    '</details>';
  }

  function loadFaq() {
    App.api('/api/faqs').then(function (data) {
      const host = document.getElementById('home-faq');
      if (!host) return;
      host.innerHTML = data.faqs.length
        ? data.faqs.slice(0, 5).map(faqItem).join('')
        : App.emptyState('No questions published', 'Please check back soon.');
    }).catch(function () { /* ignore */ });
  }

  App.ready(function (ctx) {
    renderSettings(ctx.settings);
    loadNews();
    loadEvents();
    loadCirculars();
    loadLgas();
    loadFaq();
    App.api('/api/auth/stats').then(renderStats).catch(function () { /* stats are optional */ });
    App.on(App.qs('#open-chat-btn'), 'click', function () {
      const fab = document.getElementById('chat-fab');
      if (fab) fab.click();
    });
  });
})();
