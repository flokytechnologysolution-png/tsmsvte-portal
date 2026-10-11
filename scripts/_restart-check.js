/* scripts/_restart-check.js — a SECOND, independent Node process that boots a
 * fresh server against the SAME database the test suite used, then reads the
 * saved image settings and the stored file bytes back through the HTTP API.
 * If the images lived only in the first process's memory this would fail; it
 * passes only because everything is persisted in the files/settings tables.
 *
 *   node scripts/_restart-check.js <expectedLogoUrl>
 *
 * Prints "RESTART-RESULT ok|fail <detail>" and exits 0/1. Spawned by
 * scripts/test-images.js to prove a genuine restart survives. */
'use strict';

const path = require('path');
const http = require('http');

/* Inherit DB_FILE / JWT_SECRET from the parent (the test copy), don't override. */
const expectedLogo = process.argv[2] || '';
const PORT = 3778; /* different port so it never clashes with the running suite */
const ROOT = path.join(__dirname, '..');

const express = require('express');
const cookieParser = require('cookie-parser');
const csrf = require('../middleware/csrf');
const auth = require('../middleware/auth');

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(csrf.issueToken);
app.use('/api', csrf.verify);
app.use(auth.attachUser);
app.use('/api/settings', require('../routes/settings'));
const filesRoute = require('../routes/files');
app.use('/api/files', filesRoute);
app.get('/files/:id', filesRoute.serve);

function get(urlPath) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          ctype: res.headers['content-type'] || ''
        });
      });
    }).on('error', reject);
  });
}

const server = app.listen(PORT, '127.0.0.1', async function () {
  let ok = true;
  let detail = '';
  try {
    const pub = await get('/api/settings/public');
    let settings = {};
    try { settings = JSON.parse(pub.body).settings || {}; } catch (e) { /* ignore */ }
    if (pub.status !== 200 || settings.logo !== expectedLogo) {
      ok = false;
      detail = 'logo=' + settings.logo + ' expected=' + expectedLogo;
    }
    if (ok && expectedLogo) {
      const img = await get(expectedLogo);
      if (img.status !== 200 || img.ctype.indexOf('image/') !== 0) {
        ok = false;
        detail = 'file serve status=' + img.status + ' ctype=' + img.ctype;
      }
    }
  } catch (e) {
    ok = false;
    detail = e && e.message ? e.message : String(e);
  }
  console.log('RESTART-RESULT ' + (ok ? 'ok' : 'fail') + (detail ? ' :: ' + detail : ''));
  server.close(function () { process.exit(ok ? 0 : 1); });
});
