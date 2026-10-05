/**
 * middleware/validate.js — shared express-validator helpers.
 * Text is stored raw and escaped by the UI, so validation trims, length-checks
 * and type-checks without mangling the ministry's own wording.
 */
'use strict';

const { validationResult } = require('express-validator');

function handleErrors(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  const errors = result.array().map(function (e) {
    return { field: e.path, message: e.msg };
  });
  const err = new Error('Validation failed');
  err.status = 422;
  err.errors = errors;
  err.publicMessage = errors.length
    ? errors[0].message + (errors.length > 1 ? ' (and ' + (errors.length - 1) + ' more)' : '')
    : 'Please check the form and try again.';
  return next(err);
}

/** Strip control characters that could break logs or CSV exports. */
function clean(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function digitsOnly(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function toIntOrNull(value) {
  const n = parseInt(String(value === undefined ? '' : value).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function isTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'on' || value === 'yes';
}

function oneOf(list, field, label) {
  return function (value) {
    if (String(value || '').trim() === '') return true;
    if (list.indexOf(String(value)) !== -1) return true;
    throw new Error('Invalid ' + label + '. Allowed: ' + list.join(', '));
  };
}

module.exports = {
  handleErrors: handleErrors,
  clean: clean,
  digitsOnly: digitsOnly,
  toIntOrNull: toIntOrNull,
  isTrue: isTrue,
  oneOf: oneOf
};