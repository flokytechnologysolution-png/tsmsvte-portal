/**
 * lib/csv.js — tiny dependency-free CSV reader/writer.
 * Handles quoted fields, embedded commas, embedded newlines, CRLF and BOM.
 */
'use strict';

function parse(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
}

function toObjects(text) {
  const rows = parse(text);
  if (!rows.length) return [];
  const header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  return rows.slice(1).map(function (r) {
    const obj = {};
    header.forEach(function (key, idx) {
      obj[key] = r[idx] === undefined ? '' : String(r[idx]).trim();
    });
    return obj;
  });
}

function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  rows.forEach(function (r) {
    lines.push(headers.map(function (h) { return escapeCell(r[h]); }).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parse: parse, toObjects: toObjects, toCsv: toCsv, escapeCell: escapeCell };