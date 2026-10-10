/**
 * public/js/pages/home-clean.js - keeps the home page honest.
 *
 * Runs after home.js. Any block whose setting is empty, or still contains
 * "[PLACEHOLDER", is hidden instead of showing bracketed text. Sections
 * whose data lists come back empty are hidden too. Nothing is invented.
 */
(function () {
  'use strict';

  /* /img/photos/*.svg are the "photograph to be supplied" panels.
   * Set to false to show them again while testing the layout. */
  var HIDE_PLACEHOLDER_IMAGES = true;

  function real(v) {
    var s = (v === undefined || v === null) ? '' : String(v).trim();
    return (!s || /\[PLACEHOLDER/i.test(s)) ? '' : s;
  }
  function realImage(v) {
    var s = real(v);
    if (s && HIDE_PLACEHOLDER_IMAGES && /\/img\/photos\/[^\/?#]+\.svg/i.test(s)) return '';
    return s;
  }
  function $(id) { return document.getElementById(id); }
  function hide(el) { if (el) el.style.display = 'none'; }
  function box(id, selector) {
    var el = $(id);
    return el ? (el.closest(selector) || el) : null;
  }
  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text || '';
  }

  function clean(s) {
    /* hero */
    var name = real(s.ministry_name);
    var heading = real(s.hero_heading) || (name ? 'Welcome to the ' + name : '');
    setText('hero-heading', heading);
    if (!heading) hide($('hero-heading'));
    if (!real(s.hero_subheading)) hide($('hero-sub'));
    var hero = $('hero');
    if (hero && !realImage(s.hero_image)) {
      hero.style.backgroundImage = '';
      hero.classList.remove('has-image');
    }

    /* programme banners: [titleId, title, textId, text, image, imageId] */
    var banners = [
      ['banner1-title', s.free_education_banner_title, 'banner1-text', s.free_education_banner_text, s.free_education_banner_image, 'banner1-img'],
      ['banner2-title', s.girl_child_banner_title, 'banner2-text', s.girl_child_banner_text, s.girl_child_banner_image, 'banner2-img']
    ];
    var shown = 0;
    banners.forEach(function (b) {
      var t = real(b[1]);
      var x = real(b[3]);
      if (!t && !x) { hide(box(b[0], '.banner-card')); return; }
      shown += 1;
      if (!t) hide($(b[0]));
      setText(b[2], x);
      if (!x) hide($(b[2]));
      if (!realImage(b[4])) hide(box(b[5], '.banner-media'));
    });
    if (!shown) hide(box('banner1-title', 'section'));

    /* governor */
    var gName = real(s.governor_name);
    var gFree = real(s.governor_vision_free_education);
    var gGirl = real(s.governor_vision_girl_child);
    if (!gName && !gFree && !gGirl) {
      hide($('vision'));
    } else {
      setText('gov-name', gName || "Governor's vision for education");
      setText('gov-title', real(s.governor_title));
      if (!real(s.governor_title)) hide($('gov-title'));
      if (!gFree) hide(box('gov-vision-free', '.vision-block'));
      if (!gGirl) hide(box('gov-vision-girl', '.vision-block'));
      if (!real(s.governor_vision_note)) hide($('gov-note'));
      if (!realImage(s.governor_photo)) hide(box('gov-photo', '.gov-portrait'));
    }

    /* commissioner */
    var cName = real(s.commissioner_name);
    var cMsg = real(s.commissioner_message);
    if (!cName && !cMsg) {
      hide($('commissioner'));
    } else {
      if (!cName) hide($('comm-name'));
      if (!real(s.commissioner_title)) hide($('comm-title'));
      if (!cMsg) hide($('comm-message'));
      if (!realImage(s.commissioner_photo)) hide(box('comm-photo', '.leader-photo'));
    }

    /* gallery: only the site's own photos are used. Empty, placeholder or
     * outside-link values fall back to the model school photos. */
    var FALLBACK = ['/img/photos/model-school-1.jpg', '/img/photos/model-school-2.jpg'];
    function localPath(v, fb) {
      var x = realImage(v);
      return (x && x.charAt(0) === '/' && x.charAt(1) !== '/') ? x : fb;
    }
    [['gal1-img', localPath(s.about_gallery_image_1, FALLBACK[0])],
     ['gal2-img', localPath(s.about_gallery_image_2, FALLBACK[1])]].forEach(function (p) {
      var img = $(p[0]);
      if (!img) return;
      img.classList.remove('is-broken');
      img.style.display = '';
      img.onerror = function () { hide(box(p[0], '.gallery-item')); };
      img.src = p[1];
    });

    /* about */
    var mission = real(s.mission);
    var vision = real(s.vision);
    var history = real(s.about_history);
    var lines = String(s.about_functions || '').split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/\[PLACEHOLDER/i.test(l); });
    if (!mission) hide(box('about-mission', '.card'));
    if (!vision) hide(box('about-vision', '.card'));
    if (!history) hide(box('about-history', '.card'));
    var fns = $('about-functions');
    if (fns) {
      if (lines.length) {
        fns.innerHTML = lines.map(function (l) { return '<li>' + App.esc(l) + '</li>'; }).join('');
      } else {
        hide(box('about-functions', '.card'));
      }
    }
    if (!mission && !vision && !history && !lines.length) hide($('about'));

    /* contact details on the home page */
    var rows = [
      ['Address', s.contact_address],
      ['Phone', s.contact_phone],
      ['Email', s.contact_email],
      ['Office hours', s.office_hours]
    ].filter(function (r) { return real(r[1]); });
    var cl = $('contact-list');
    if (cl) {
      if (!rows.length) {
        hide(cl.parentElement);
      } else {
        cl.innerHTML = rows.map(function (r) {
          return '<div class="r"><span class="k">' + App.esc(r[0]) + '</span><span class="v">' +
            App.esc(real(r[1])) + '</span></div>';
        }).join('');
      }
    }
  }

  /* Hide a whole section when its list loads empty ("No news ...", etc). */
  function watchEmpty(hostId) {
    var host = $(hostId);
    if (!host) return;
    var section = host.closest('section');
    function check() {
      var strong = host.querySelector('.empty-state strong');
      if (strong && /^No /i.test(strong.textContent.trim())) hide(section);
    }
    new MutationObserver(check).observe(host, { childList: true, subtree: true });
    check();
  }

  /* Do not advertise zeros in the hero. */
  function watchStats() {
    var host = $('hero-stats');
    if (!host) return;
    function check() {
      Array.prototype.forEach.call(host.querySelectorAll('.item'), function (it) {
        var n = it.querySelector('.num');
        if (n && n.textContent.trim() === '0') hide(it);
      });
    }
    new MutationObserver(check).observe(host, { childList: true });
    check();
  }

  App.ready(function (ctx) {
    var s = (ctx && ctx.settings) || {};
    setTimeout(function () {
      try { clean(s); } catch (e) { /* never break the page */ }
    }, 0);
    ['home-news', 'home-events', 'home-circulars', 'home-faq'].forEach(watchEmpty);
    watchStats();
  });
})();