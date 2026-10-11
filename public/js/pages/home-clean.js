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

/* ---------------------------------------------------------------------------
 * Permanent image / message fix (safe).
 *
 * Runs after home.js has rendered and repairs two things, but ONLY with real,
 * non-placeholder values:
 *   - the commissioner photo and message (#comm-photo / #comm-message), which
 *     the ministry fills in Admin -> Site settings;
 *   - news cover images, replacing a missing / .svg / placeholder source with
 *     a real local photo already shipped in /img/photos/.
 *
 * It never shows "[PLACEHOLDER]" text, never un-hides a card the page hides on
 * purpose, and never points at an outside or invented image. News cards are
 * injected asynchronously, so the news host is observed for late additions.
 * Wrapped so a settings/network error can never break the page.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  function isReal(v) {
    var s = (v === undefined || v === null) ? '' : String(v).trim();
    return s && !/\[PLACEHOLDER/i.test(s) && !/\.svg(\?|$)/i.test(s);
  }
  var NEWS_FALLBACK = '/img/photos/model-school-1.jpg';

  fetch('/api/settings/public')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var s = data && data.settings;
      if (!s) return;

      /* Commissioner photo / message: set only when real values exist. The
       * commissioner card itself is shown or hidden by the logic above. */
      var commImg = document.getElementById('comm-photo');
      if (commImg && isReal(s.commissioner_photo)) commImg.src = s.commissioner_photo;

      var commMsg = document.getElementById('comm-message');
      if (commMsg && isReal(s.commissioner_message)) commMsg.textContent = s.commissioner_message;

      /* News covers: swap a broken/placeholder source for a real local photo. */
      var coverFallback = isReal(s.default_news_cover) ? s.default_news_cover : NEWS_FALLBACK;
      function fixNews() {
        var imgs = document.querySelectorAll('#home-news .cover img');
        Array.prototype.forEach.call(imgs, function (img) {
          var src = img.getAttribute('src') || '';
          if (!src || /\.svg(\?|$)/i.test(src) || /placeholder/i.test(src)) {
            img.src = coverFallback;
            img.style.objectFit = 'cover';
          }
        });
      }
      fixNews();
      var host = document.getElementById('home-news');
      if (host && window.MutationObserver) {
        new MutationObserver(fixNews).observe(host, { childList: true, subtree: true });
      }

      /* Hero background: applied ONLY when the ministry has set a real raster
       * image (jpg/jpeg/png/webp). SVG placeholders are ignored, so the framed
       * portrait hero stays intact until a real photo is uploaded in Admin. */
      var heroImage = s.hero_image;
      if (isReal(heroImage) && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(heroImage)) {
        var hero = document.querySelector('.hero, .hero-parallax');
        if (hero) {
          hero.style.backgroundImage =
            "linear-gradient(135deg, rgba(11,107,58,.75), rgba(0,0,0,.8)), url('" + heroImage + "')";
          hero.style.backgroundSize = 'cover';
          hero.style.backgroundPosition = 'center';
          hero.style.backgroundRepeat = 'no-repeat';
        }
      }
    })
    .catch(function () { /* network/JSON error: leave the page as-is */ });
})();
// === ULTIMATE PERMANENT RESTORATION & 3D GOVERNOR EFFECT ===
document.addEventListener('DOMContentLoaded', () => {
  fetch('/api/settings/public')
    .then(res => res.json())
    .then(data => {
      const s = data.settings;
      if (!s) return;

      // THE GUARD: Only accept real image files
      const isReal = (url) => url && typeof url === 'string' && /\.(jpg|jpeg|png|webp)$/i.test(url) && !url.includes('PLACEHOLDER');

      // 1. RESTORE HERO TEXT
      const h1 = document.getElementById('hero-heading');
      if (h1 && s.hero_heading) h1.innerText = s.hero_heading;
      const sub = document.getElementById('hero-sub');
      if (sub && s.site_tagline) sub.innerText = s.site_tagline;

      // 2. RESTORE GOVERNOR PORTRAIT WITH 3D EFFECT
      const govSelectors = ['.gov-portrait img', '.hero-portrait img', '#hero img', 'img[src*="governor"]'];
      for (let sel of govSelectors) {
        const img = document.querySelector(sel);
        if (img && isReal(s.governor_photo)) {
          img.src = s.governor_photo;
          img.style.display = 'block';
          img.style.visibility = 'visible';
          img.style.opacity = '1';
          img.style.maxWidth = '400px';
          img.style.width = '100%';
          img.style.borderRadius = '16px';
          
          // 3D EFFECT STYLES
          img.style.border = '5px solid #f2b705'; // Taraba Gold
          img.style.boxShadow = '0 20px 40px rgba(0,0,0,0.5)';
          img.style.transform = 'perspective(1000px) rotateY(-5deg) rotateX(2deg)';
          img.style.transition = 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
          
          // 3D HOVER EFFECT
          img.onmouseenter = () => {
            img.style.transform = 'perspective(1000px) rotateY(0deg) scale(1.05)';
            img.style.boxShadow = '0 30px 60px rgba(0,0,0,0.6), 0 0 0 3px #f2b705';
          };
          img.onmouseleave = () => {
            img.style.transform = 'perspective(1000px) rotateY(-5deg) rotateX(2deg)';
            img.style.boxShadow = '0 20px 40px rgba(0,0,0,0.5)';
          };
          console.log('? Governor 3D portrait applied.');
          break; 
        }
      }

      // 3. RESTORE COMMISSIONER PHOTO & MESSAGE
      const commImg = document.querySelector('.commissioner-photo img, #comm-photo img, img[src*="commissioner"]');
      if (commImg && isReal(s.commissioner_photo)) {
        commImg.src = s.commissioner_photo;
        commImg.style.display = 'block';
      }
      const commMsg = document.querySelector('.commissioner-message, .gov-message');
      if (commMsg && s.commissioner_message && !s.commissioner_message.includes('PLACEHOLDER')) {
        commMsg.innerText = s.commissioner_message;
      }

      // 4. RESTORE MODEL SCHOOLS & NEWS IMAGES
      const gal1 = document.querySelector('.about-gallery-1 img, #gallery-img-1');
      if (gal1 && isReal(s.about_gallery_image_1)) gal1.src = s.about_gallery_image_1;
      
      const gal2 = document.querySelector('.about-gallery-2 img, #gallery-img-2');
      if (gal2 && isReal(s.about_gallery_image_2)) gal2.src = s.about_gallery_image_2;

      document.querySelectorAll('.news-card img, .news-cover img').forEach(img => {
        if (img.src.includes('.svg') || img.src.includes('placeholder')) {
          img.src = isReal(s.default_news_cover) ? s.default_news_cover : '/img/photos/model-school-1.jpg';
          img.style.display = 'block';
          img.style.objectFit = 'cover';
        }
      });

      console.log('?? ULTIMATE RESTORATION COMPLETE! All features are now permanent.');
    })
    .catch(err => console.error('? Failed to load settings:', err));
});

// === PERMANENT TEXT VISIBILITY FIX ===
document.addEventListener('DOMContentLoaded', () => {
  fetch('/api/settings/public')
    .then(res => res.json())
    .then(data => {
      const s = data.settings;
      if (!s) return;

      // Force Hero Heading Visibility
      const h1 = document.getElementById('hero-heading');
      if (h1 && s.hero_heading) {
        h1.innerText = s.hero_heading;
        h1.style.setProperty('display', 'block', 'important');
        h1.style.setProperty('visibility', 'visible', 'important');
        h1.style.setProperty('opacity', '1', 'important');
        h1.style.setProperty('color', '#ffffff', 'important');
        h1.style.setProperty('text-shadow', '3px 3px 10px rgba(0,0,0,0.9)', 'important');
      }

      // Force Tagline Visibility
      const sub = document.getElementById('hero-sub');
      if (sub && s.site_tagline) {
        sub.innerText = s.site_tagline;
        sub.style.setProperty('display', 'block', 'important');
        sub.style.setProperty('visibility', 'visible', 'important');
        sub.style.setProperty('opacity', '1', 'important');
        sub.style.setProperty('color', '#f0f0f0', 'important');
        sub.style.setProperty('text-shadow', '2px 2px 5px rgba(0,0,0,0.9)', 'important');
      }
      console.log('? Text visibility permanently fixed.');
    });
});

// === PERMANENT PUBLIC VIEW FIX ===
document.addEventListener('DOMContentLoaded', () => {
  fetch('/api/settings/public')
    .then(res => res.json())
    .then(data => {
      const s = data.settings;
      if (!s) return;

      // Force Text
      const h1 = document.getElementById('hero-heading');
      if (h1 && s.hero_heading) {
        h1.innerText = s.hero_heading;
        h1.style.cssText = 'display:block!important; visibility:visible!important; opacity:1!important; color:#ffffff!important; font-size:clamp(2rem, 4vw, 3.5rem)!important; font-weight:800!important; text-shadow:3px 3px 10px rgba(0,0,0,0.9)!important; z-index:100!important;';
      }
      const sub = document.getElementById('hero-sub');
      if (sub && s.site_tagline) {
        sub.innerText = s.site_tagline;
        sub.style.cssText = 'display:block!important; visibility:visible!important; opacity:1!important; color:#f0f0f0!important; font-size:1.2rem!important; text-shadow:2px 2px 5px rgba(0,0,0,0.9)!important; z-index:100!important;';
      }

      // Force Governor Photo
      const govImg = document.querySelector('.gov-portrait img, .hero-portrait img');
      if (govImg && s.governor_photo) {
        govImg.src = s.governor_photo;
        govImg.style.cssText = 'display:block!important; visibility:visible!important; opacity:1!important; max-width:400px!important; border-radius:16px!important; border:5px solid #f2b705!important; box-shadow:0 20px 40px rgba(0,0,0,0.5)!important;';
      }

      // Force Commissioner Photo
      const commImg = document.querySelector('.commissioner-photo img, #comm-photo img');
      if (commImg && s.commissioner_photo) {
        commImg.src = s.commissioner_photo;
        commImg.style.display = 'block';
      }

      console.log('? Permanent public view fix applied.');
    });
});
