/**
 * middleware/errors.js — uniform JSON errors, no stack traces in production.
 */
'use strict';

const multer = require('multer');

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function notFound(req, res) {
  /* Express rewrites req.path when a middleware is mounted with app.use(path),
   * so inside a handler mounted on '/api' the path is relative ('/nope') and
   * the original URL still holds '/api/nope'. Check the original. */
  const isApi = String(req.originalUrl || req.url || '').indexOf('/api/') === 0;
  if (isApi) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.status(404).sendFile(require('path').join(__dirname, '..', 'public', '404.html'));
}

/* eslint-disable-next-line no-unused-vars */
function errorHandler(err, req, res, next) {
  /* body-parser failures (malformed JSON, oversized body) carry internal
   * parser text such as "Unexpected token x in JSON at position 1". Replace it
   * with our own wording so nothing about the server leaks. */
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' ||
    err instanceof SyntaxError && 'body' in (err || {}))) {
    const message = err.type === 'entity.too.large'
      ? 'That request was too large. Please send something smaller.'
      : 'Invalid request body.';
    return res.status(400).json({ error: message });
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That file is too large. Maximum size is ' + (process.env.MAX_UPLOAD_MB || 5) + ' MB.'
      : (err.field || 'Upload rejected. Check the file type and size.');
    return res.status(400).json({ error: message });
  }

  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, '-', err.message);
    if (process.env.NODE_ENV !== 'production' && err.stack) console.error(err.stack);
  }

  const body = {
    error: err.publicMessage || (status >= 500 ? 'Something went wrong on the server. Please try again.' : err.message)
  };
  if (err.errors) body.errors = err.errors;
  return res.status(status).json(body);
}

module.exports = { asyncHandler: asyncHandler, notFound: notFound, errorHandler: errorHandler };