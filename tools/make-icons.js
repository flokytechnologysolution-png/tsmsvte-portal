/**
 * tools/make-icons.js — generate the portal's PWA / favicon icon set.
 *
 * Run:  npm run icons      (or: node tools/make-icons.js)
 *
 * Writes into public/icons/:
 *   favicon-32.png   (32 x 32)   the browser tab icon every page links to
 *   logo-192.png     (192 x 192) PWA + the header logo (settings.logo)
 *   logo-512.png     (512 x 512) PWA install / splash icon
 *
 * These are exactly the paths referenced by the HTML pages, public/sw.js,
 * public/manifest.webmanifest and db.DEFAULT_SETTINGS.logo — so after this
 * runs nothing 404s.
 *
 * No dependencies and no build step: a tiny PNG encoder on top of the built-in
 * zlib, and a small RGBA rasteriser.  Colours are lifted from db.js /
 * css/main.css so the mark always matches the brand.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------------------------------------------- palette */
const PRIMARY = '#0b6b3a';   /* db.DEFAULT_SETTINGS.primary_color */
const ACCENT  = '#f2b705';   /* db.DEFAULT_SETTINGS.accent_color  */
const WHITE   = '#ffffff';

const SS = 4;                /* supersampling factor for smooth edges */

/* ------------------------------------------------------------------- png  */
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* Encode an RGBA canvas as a PNG buffer (8-bit, colour type 6). */
function encodePng(c) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8;   /* bit depth            */
  ihdr[9] = 6;   /* colour type: RGBA    */
  const stride = c.w * 4;
  const raw = Buffer.alloc((stride + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (stride + 1)] = 0;   /* filter: none */
    c.data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* -------------------------------------------------------------- rasterise */
function hexToRgba(hex, alpha) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, function (ch) { return ch + ch; }) : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
    alpha == null ? 255 : Math.round(alpha * 255)
  ];
}

function createCanvas(w, h, fill) {
  const data = Buffer.alloc(w * h * 4);
  if (fill) {
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1];
      data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = fill[3];
    }
  }
  return { w: w, h: h, data: data };
}

/* Source-over alpha composite of one pixel. */
function setPx(c, x, y, color) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const sa = color[3] / 255;
  if (sa <= 0) return;
  const i = (y * c.w + x) * 4;
  const ia = c.data[i + 3] / 255;
  const oa = sa + ia * (1 - sa);
  if (oa <= 0) { c.data[i + 3] = 0; return; }
  c.data[i]     = Math.round((color[0] * sa + c.data[i]     * ia * (1 - sa)) / oa);
  c.data[i + 1] = Math.round((color[1] * sa + c.data[i + 1] * ia * (1 - sa)) / oa);
  c.data[i + 2] = Math.round((color[2] * sa + c.data[i + 2] * ia * (1 - sa)) / oa);
  c.data[i + 3] = Math.round(oa * 255);
}

function fillRect(c, x, y, w, h, color) {
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) setPx(c, px, py, color);
  }
}

function fillCircle(c, cx, cy, r, color) {
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
    for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) setPx(c, px, py, color);
    }
  }
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function fillPolygon(c, pts, color) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach(function (p) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  });
  for (let py = Math.floor(minY); py <= Math.ceil(maxY); py++) {
    for (let px = Math.floor(minX); px <= Math.ceil(maxX); px++) {
      if (pointInPoly(px + 0.5, py + 0.5, pts)) setPx(c, px, py, color);
    }
  }
}

/* Box-downsample by an integer factor (averages the supersampled samples). */
function downscale(src, factor) {
  const w = src.w / factor, h = src.h / factor;
  const out = createCanvas(w, h, null);
  const samples = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * src.w + (x * factor + sx)) * 4;
          const sa = src.data[i + 3] / 255;
          r += src.data[i] * sa; g += src.data[i + 1] * sa; b += src.data[i + 2] * sa;
          a += sa;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o]     = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- artwork */
/* The mark: a green field, a gold rising sun with rays, and a white open
 * book.  Everything is expressed in normalised 0..1 coordinates and scaled to
 * the device canvas, so one routine renders all three sizes. */
function drawEmblem(c, size) {
  const U = size;
  const green = hexToRgba(PRIMARY);
  const gold = hexToRgba(ACCENT);
  const white = hexToRgba(WHITE);

  /* Full-bleed background (works as a maskable PWA icon). */
  fillRect(c, 0, 0, U, U, green);

  const cx = 0.5 * U;
  const cySun = 0.365 * U;
  const rSun = 0.105 * U;

  /* Sun rays — upper hemisphere only, so nothing pokes past the book. */
  for (let deg = 190; deg <= 350; deg += 20) {
    const th = deg * Math.PI / 180;
    const dx = Math.cos(th), dy = Math.sin(th);
    const px = -dy, py = dx;                       /* perpendicular */
    const r1 = 0.152 * U, r2 = 0.218 * U, t = 0.012 * U;
    fillPolygon(c, [
      [cx + r1 * dx - t * px, cySun + r1 * dy - t * py],
      [cx + r2 * dx - t * px, cySun + r2 * dy - t * py],
      [cx + r2 * dx + t * px, cySun + r2 * dy + t * py],
      [cx + r1 * dx + t * px, cySun + r1 * dy + t * py]
    ], gold);
  }

  /* Sun disc. */
  fillCircle(c, cx, cySun, rSun, gold);

  /* Open book: two reclining pages meeting at a gold spine. */
  const spineTop = [0.5 * U, 0.655 * U];
  const spineBot = [0.5 * U, 0.825 * U];
  fillPolygon(c, [spineTop, [0.145 * U, 0.585 * U], [0.145 * U, 0.755 * U], spineBot], white);
  fillPolygon(c, [spineTop, [0.855 * U, 0.585 * U], [0.855 * U, 0.755 * U], spineBot], white);
  fillPolygon(c, [
    [0.5 * U - 0.011 * U, 0.655 * U],
    [0.5 * U + 0.011 * U, 0.655 * U],
    [0.5 * U + 0.011 * U, 0.825 * U],
    [0.5 * U - 0.011 * U, 0.825 * U]
  ], gold);
}

function renderIcon(size) {
  const device = size * SS;
  const canvas = createCanvas(device, device, null);
  drawEmblem(canvas, device);
  return encodePng(downscale(canvas, SS));
}

/* ------------------------------------------------------------------- cli  */
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const TARGETS = [
  { file: 'favicon-32.png', size: 32 },
  { file: 'logo-192.png', size: 192 },
  { file: 'logo-512.png', size: 512 }
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('\nTSMSVTE portal — generating icons into ' + path.relative(path.join(__dirname, '..'), OUT_DIR));
  TARGETS.forEach(function (t) {
    const png = renderIcon(t.size);
    fs.writeFileSync(path.join(OUT_DIR, t.file), png);
    console.log('  ' + t.file.padEnd(16) + t.size + 'x' + t.size + '   ' + png.length + ' bytes');
  });
  console.log('  done — ' + TARGETS.length + ' icons written\n');
}

if (require.main === module) main();

module.exports = { renderIcon: renderIcon, drawEmblem: drawEmblem, encodePng: encodePng, createCanvas: createCanvas };

