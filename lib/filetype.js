/**
 * lib/filetype.js — server-side file type detection by MAGIC BYTES.
 *
 * We never trust the client's filename, extension or declared MIME type: any
 * of those can be forged to smuggle an SVG (which can run script) or an HTML
 * document through an "image" upload.  Instead we sniff the leading bytes and
 * only accept a small allow-list:
 *
 *   images   : JPEG, PNG, WebP
 *   documents: PDF, DOCX, XLSX  (DOCX/XLSX = ZIP container + an OOXML entry)
 *
 * Everything else — SVG, HTML, GIF, plain ZIP, executables — returns null so
 * the caller can reject it with 415.
 */
'use strict';

/* Scan a whole buffer for an ASCII/byte marker. Cheap enough for small files
 * and avoids pulling in a zip parser just to tell DOCX from XLSX. */
function hasMarker(buf, ascii) {
  return buf.indexOf(Buffer.from(ascii, 'ascii')) !== -1;
}

function isPdf(buf) {
  return buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-';
}

/* ZIP local-file / empty-archive / spanned signatures: PK\x03\x04 / 05 06 / 07 08 */
function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function isJpeg(buf) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isPng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

/* WebP: "RIFF" <4-byte size> "WEBP" */
function isWebp(buf) {
  return buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * @param {Buffer} buf
 * @returns {{kind:'image'|'document', mime:string, ext:string}|null}
 */
function detectFileType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  if (isJpeg(buf)) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (isPng(buf)) return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (isWebp(buf)) return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  if (isPdf(buf)) return { kind: 'document', mime: 'application/pdf', ext: '.pdf' };

  if (isZip(buf)) {
    /* OOXML documents are ZIPs that contain [Content_Types].xml plus a
     * package-specific top-level folder. Require both so a generic ZIP or a
     * DOCX disguised as XLSX is rejected. */
    const ooxml = hasMarker(buf, '[Content_Types].xml');
    if (ooxml && hasMarker(buf, 'word/')) {
      return {
        kind: 'document',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: '.docx'
      };
    }
    if (ooxml && hasMarker(buf, 'xl/')) {
      return {
        kind: 'document',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: '.xlsx'
      };
    }
    return null; /* plain/other ZIP: not allowed */
  }

  return null;
}

/**
 * Sanitise a client filename into safe DISPLAY text. The stored name is never
 * used to write to disk; this only prevents control characters or path tricks
 * from reaching the browser in a Content-Disposition header or an audit line.
 */
function sanitizeFilename(name) {
  let s = String(name === null || name === undefined ? '' : name).trim();
  s = s.replace(/[\\/:*?"<>|\r\n\t]/g, '_');   /* path + header-injection chars */
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 120) s = s.slice(0, 120);
  return s || 'file';
}

module.exports = { detectFileType: detectFileType, sanitizeFilename: sanitizeFilename };
