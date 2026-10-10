/**
 * public/js/pages/hero-parallax.js - gentle fixed-background depth for the hero.
 * The portrait is a plain <img> (not a stretched background); this only eases
 * the copy layer while the hero is on screen. Off unless the hero image is at
 * least 1200px wide (the ministry's photos are far smaller, so there is no
 * depth effect by default), off on touch devices and for reduced-motion users.
 * Never throws.
 */
(function () {
  'use strict';
  try {
    var MIN_WIDTH = 1200;
    var mm = window.matchMedia;
    if (!mm || mm('(prefers-reduced-motion: reduce)').matches || mm('(hover: none)').matches) return;
    var img = document.getElementById('hero-portrait');
    var natural = img ? (img.naturalWidth || img.width || 0) : 0;
    if (!img || natural < MIN_WIDTH) return;   /* too small to parallax - do nothing */
    var hero = document.getElementById('hero');
    var inner = hero && hero.querySelector('.hero-copy');
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
    if (img.complete) update(); else img.addEventListener('load', update);
  } catch (e) { /* decoration only */ }
})();