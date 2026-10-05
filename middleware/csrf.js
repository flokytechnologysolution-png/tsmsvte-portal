/**
 * middleware/csrf.js — double-submit cookie CSRF protection.
 *
 * A random token is stored in a readable cookie; the page must echo it back
 * in the `X-CSRF-Token` header on every state-changing request.  Because an
 * attacker on another origin cannot read our cookie, they cannot forge the
 * header.  Combined with SameSite=Lax cookies this blocks cross-site POSTs.
 */
'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'tsmsvte_csrf';
const HEADER = 'x-csrf-token';
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function issueToken(req, res, next) {
  let token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token || !/^[a-f0-9]{32,}$/i.test(token)) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie(COOKIE_NAME, token, {
      httpOnly: false,           // must be readable by the page's JS
      sameSite: 'lax',
      secure: String(process.env.COOKIE_SECURE || '0') === '1',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });
  }
  res.locals.csrfToken = token;
  next();
}

function verify(req, res, next) {
  if (SAFE_METHODS.indexOf(req.method) !== -1) return next();
  const cookieToken = (req.cookies && req.cookies[COOKIE_NAME]) || '';
  const headerToken = req.get(HEADER) || (req.body && req.body._csrf) || '';
  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: 'Missing CSRF token. Reload the page and try again.' });
  }
  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid CSRF token. Reload the page and try again.' });
  }
  return next();
}

module.exports = {
  COOKIE_NAME: COOKIE_NAME,
  HEADER: HEADER,
  issueToken: issueToken,
  verify: verify
};