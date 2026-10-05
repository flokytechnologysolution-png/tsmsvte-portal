/**
 * tools/make-placeholders.js — branded placeholder tiles for ministry photos.
 *
 * Run:  npm run placeholders
 *
 * The ministry's photographs have not been supplied yet.  Until they are, this
 * writes clearly-labelled branded panels to public/img/photos/ at the exact
 * paths the settings already point to, so the site never shows an empty box.
 *
 * These are NOT photographs and contain no people.  When the real images
 * arrive, replace each file (same path) or point the matching setting in
 * Admin -> Site settings at the new file.  Nothing else needs to change.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'photos');

/* Brand palette, matching css/main.css and db.js. */
const PRIMARY = '#0b6b3a';
const PRIMARY_DARK = '#08522c';
const PRIMARY_TINT = '#e8f4ee';
const ACCENT = '#f2b705';
const INK = '#17251e';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object} o  name, w, h, title, caption, accent
 */
function tile(o) {
  const w = o.w, h = o.h;
  const cx = w / 2;
  const cy = h / 2;
  /* Title block sits in the lower half so the top stays clean for a crop. */
  const titleY = cy + (o.titleOffset || 0);

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" ' +
    'viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.alt || o.title) + '">' +
    '<defs>' +
      '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + PRIMARY_DARK + '"/>' +
        '<stop offset="1" stop-color="' + PRIMARY + '"/>' +
      '</linearGradient>' +
    '</defs>' +
    '<rect width="' + w + '" height="' + h + '" fill="url(#g)"/>' +
    /* soft decorative shapes — an abstract mark, not a picture of anything */
    '<circle cx="' + (cx) + '" cy="' + (cy - h * 0.12) + '" r="' + (h * 0.17) + '" fill="' + ACCENT + '" opacity="0.16"/>' +
    '<circle cx="' + (cx) + '" cy="' + (cy - h * 0.12) + '" r="' + (h * 0.10) + '" fill="' + ACCENT + '" opacity="0.28"/>' +
    '<rect x="' + (cx - h * 0.20) + '" y="' + (cy + h * 0.02) + '" width="' + (h * 0.40) + '" height="' + (h * 0.055) + '" rx="' + (h * 0.027) + '" fill="#ffffff" opacity="0.30"/>' +
    '<rect x="' + (cx - h * 0.14) + '" y="' + (cy + h * 0.10) + '" width="' + (h * 0.28) + '" height="' + (h * 0.055) + '" rx="' + (h * 0.027) + '" fill="#ffffff" opacity="0.22"/>' +
    '<text x="' + cx + '" y="' + titleY + '" fill="#ffffff" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ' +
      'font-size="' + Math.round(h * 0.072) + '" font-weight="700" text-anchor="middle">' + esc(o.title) + '</text>' +
    '<text x="' + cx + '" y="' + (titleY + h * 0.075) + '" fill="#ffffff" opacity="0.82" ' +
      'font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="' + Math.round(h * 0.042) + '" ' +
      'text-anchor="middle">' + esc(o.caption) + '</text>' +
    '</svg>';
}

const PENDING = 'Photograph to be supplied by the Ministry';

const TILES = [
  { name: 'hero-group.svg', w: 1600, h: 900, title: 'Ministry hero photograph', caption: PENDING },
  { name: 'programme-free-education.svg', w: 960, h: 540, title: 'Free education programme', caption: PENDING },
  { name: 'programme-girl-child.svg', w: 960, h: 540, title: 'Girl-child support programme', caption: PENDING },
  { name: 'governor.svg', w: 480, h: 600, title: 'Governor', caption: PENDING, titleOffset: 90 },
  { name: 'commissioner.svg', w: 480, h: 480, title: 'Commissioner', caption: PENDING, titleOffset: 80 },
  { name: 'about-classroom.svg', w: 960, h: 640, title: 'Classroom photograph', caption: PENDING },
  { name: 'news-backpacks.svg', w: 960, h: 640, title: 'School materials photograph', caption: PENDING }
];

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
TILES.forEach(function (t) {
  const svg = tile(t);
  fs.writeFileSync(path.join(OUT_DIR, t.name), svg, 'utf8');
  total += Buffer.byteLength(svg);
  console.log('  ' + t.name.padEnd(30) + t.w + 'x' + t.h + '  ' + svg.length + ' bytes');
});
console.log('\n' + TILES.length + ' placeholder tiles written to public/img/photos (' + total + ' bytes total)');
console.log('Replace these files with the ministry photographs as they arrive.');