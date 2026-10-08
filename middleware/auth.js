/**
 * middleware/auth.js — JWT in an httpOnly + SameSite cookie, role checks.
 * The token is never stored in localStorage and never rendered into HTML.
 */
'use strict';

const jwt = require('jsonwebtoken');
const db = require('../db');

const COOKIE_NAME = 'tsmsvte_token';
const IS_PROD = process.env.NODE_ENV === 'production';
/* A token signed with an empty or predictable secret can be forged by anyone,
 * which would hand them an OWNER session. Production therefore refuses to
 * start without a strong secret; in development we generate a random one for
 * this process only, so nobody is ever locked out and login still works. */
let SECRET = String(process.env.JWT_SECRET || '').trim();
if (!SECRET || SECRET.length < 32) {
  if (IS_PROD) {
    console.error('\n[FATAL] JWT_SECRET is missing or shorter than 32 characters.');
    console.error('  Generate a strong one with:');
    console.error('    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    console.error('  then put it in your .env as JWT_SECRET=... and start again.');
    console.error('  The portal has NOT started.\n');
    process.exit(1);
  }
  SECRET = require('crypto').randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET is missing or shorter than 32 characters. A random ' +
    'secret was generated for this process only; sessions will be invalidated ' +
    'when the server restarts. Set JWT_SECRET in .env for a permanent one.');
}
const EXPIRES = process.env.JWT_EXPIRES || '7d';
const SECURE = String(process.env.COOKIE_SECURE || '0') === '1';

const ROLE_RANK = require('../lib/roles').RANK;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.full_name },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  };
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/' });
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    status: row.status,
    phone: row.phone,
    mail_address: row.mail_address,
    avatar: row.avatar,
    created_at: row.created_at
  };
}

/** Populate req.user (full DB row) when a valid token is present. */
function attachUser(req, res, next) {
  req.user = null;
  let token = (req.cookies && req.cookies[COOKIE_NAME]) || null;
  if (!token && req.headers.authorization && req.headers.authorization.indexOf('Bearer ') === 0) {
    token = req.headers.authorization.slice(7);
  }
  if (!token) return next();
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (user && user.status === 'ACTIVE') req.user = user;
  } catch (err) {
    /* expired / tampered token: treat as anonymous */
  }
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  return next();
}

/** Any of the listed roles (or higher rank for OWNER/ADMIN/EDITOR). */
function requireRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (roles.indexOf(req.user.role) !== -1) return next();
    /* OWNER implicitly satisfies ADMIN and EDITOR checks.  LGA_OFFICER and
     * SCHOOL_ADMIN deliberately do NOT — they are scoped, not statewide. */
    if (req.user.role === 'OWNER' && (roles.indexOf('ADMIN') !== -1 || roles.indexOf('EDITOR') !== -1)) {
      return next();
    }
    return res.status(403).json({ error: 'You do not have permission to do that' });
  };
}

/**
 * Guard for anything that touches the OWNER account.  Non-owners get a plain
 * 404 so a guessed id reveals nothing.
 */
function requireNotOwnerTarget(req, res, next) {
  const id = parseInt(String(req.params.id || ''), 10);
  if (Number.isFinite(id)) {
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (target && target.role === 'OWNER' && req.user.role !== 'OWNER') {
      return res.status(404).json({ error: 'Not found' });
    }
  }
  return next();
}

function requireExactRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (roles.indexOf(req.user.role) === -1) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    return next();
  };
}

function isAdminish(user) {
  return Boolean(user) && (user.role === 'OWNER' || user.role === 'ADMIN');
}

module.exports = {
  COOKIE_NAME: COOKIE_NAME,
  ROLE_RANK: ROLE_RANK,
  signToken: signToken,
  setAuthCookie: setAuthCookie,
  clearAuthCookie: clearAuthCookie,
  attachUser: attachUser,
  requireAuth: requireAuth,
  requireRole: requireRole,
  requireNotOwnerTarget: requireNotOwnerTarget,
  requireExactRole: requireExactRole,
  isAdminish: isAdminish,
  isOwner: require('../lib/roles').isOwner,
  publicUser: publicUser
};