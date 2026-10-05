/**
 * tools/start-prod.js — start the portal in production mode.
 *
 *   npm run start:prod
 *
 * Windows cannot do "NODE_ENV=production node server.js" in a plain npm script,
 * and we do not want a cross-env dependency, so we set the variable in Node
 * and then run the real entry point. No new dependency is needed.
 */
'use strict';

process.env.NODE_ENV = 'production';

/* Fail early and clearly rather than starting in a half-configured state. */
const missing = [];
if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).trim().length < 32) {
  missing.push('JWT_SECRET (32+ characters) — generate one with:\n' +
    '        node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
}
if (!process.env.COOKIE_SECURE || process.env.COOKIE_SECURE !== '1') {
  console.warn('[start:prod] WARNING: COOKIE_SECURE is not 1. The sign-in cookie will be sent');
  console.warn('  over plain HTTP. Only do this if TLS is terminated in front of the portal');
  console.warn('  and you set TRUST_PROXY=1 as well.');
}

if (missing.length) {
  console.error('\n[FATAL] Cannot start in production mode:');
  missing.forEach(function (m) { console.error('  - missing ' + m); });
  console.error('\n  Set these in your .env (or the process environment) and try again.\n');
  process.exit(1);
}

console.log('[start:prod] NODE_ENV=production — starting the portal.');
require('../server.js');