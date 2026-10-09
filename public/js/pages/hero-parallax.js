/**
 * public/js/pages/hero-parallax.js - gentle depth for the home hero.
 * The photo is a fixed CSS background; this only eases the text layer.
 * Off on touch devices and for reduced-motion users. Never throws.
 */
(function () {
  'use strict';
  try {
    var mm = window.matchMedia;
    if (!mm || mm('(prefers-reduced-motion: reduce)').matches || mm('(hover: none)').matches) return;
    var hero = document.getElementById('hero');
    var inner = hero && hero.querySelector('.container');
    if (!hero || !inner) return;
    var ticking = false;
    function update() {
      ticking = false;
      var y = window.pageYOffset || 0;
      var h = hero.offsetHeight || 1;
      if (y > h) return;
      inner.style.transform = 'translate3d(0,' + Math.round(y * 0.18) + 'px,0)';
      inner.style.opacity = String(Math.max(0, 1 - y / (h * 0.9)));
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
    }, { passive: true });
    update();
  } catch (e) { /* decoration only */ }
})();