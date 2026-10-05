/**
 * lib/roles.js — the one place that decides who may do what.
 *
 * Every rule lives here so the API, the admin UI and the tests can never
 * drift apart:
 *
 *   OWNER        exactly one, invisible to everyone else, cannot be deleted,
 *                demoted or locked out — not even by themselves.
 *   ADMIN        whole state. May create LGA_OFFICER, SCHOOL_ADMIN, EDITOR
 *                and STAFF — never another ADMIN.
 *   LGA_OFFICER  one LGA. May create SCHOOL_ADMINs inside that LGA only.
 *   SCHOOL_ADMIN one school. May manage that school only.
 *   EDITOR       content only.  STAFF self-service only.
 */
'use strict';

const ROLES = ['OWNER', 'ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR', 'STAFF'];

const RANK = {
  OWNER: 6, ADMIN: 5, LGA_OFFICER: 4, SCHOOL_ADMIN: 3, EDITOR: 2, STAFF: 1
};

/** Roles that may sign in and reach the staff side at all. */
const PORTAL_ROLES = ['OWNER', 'ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR', 'STAFF'];

/** Roles an actor of the given rank may hand out. */
const GRANTABLE = {
  OWNER: ['ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR', 'STAFF'],
  ADMIN: ['LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR', 'STAFF'],
  LGA_OFFICER: ['SCHOOL_ADMIN'],
  SCHOOL_ADMIN: [],
  EDITOR: [],
  STAFF: []
};

function rank(role) { return RANK[role] || 0; }

function isOwner(user) { return Boolean(user) && user.role === 'OWNER'; }
function isAdminish(user) { return Boolean(user) && (user.role === 'OWNER' || user.role === 'ADMIN'); }
function isScoped(user) {
  return Boolean(user) && (user.role === 'LGA_OFFICER' || user.role === 'SCHOOL_ADMIN');
}
/** Anyone who should see the admin console. */
function canUseAdminConsole(user) {
  return isAdminish(user) || isScoped(user) || (Boolean(user) && user.role === 'EDITOR');
}

/** The roles this actor is allowed to assign to somebody. */
function grantableRoles(actor) {
  if (!actor || !actor.role) return [];
  return (GRANTABLE[actor.role] || []).slice();
}

/**
 * May `actor` assign `role`?
 * Nobody may assign OWNER — ownership moves only through the transfer flow.
 */
function canGrant(actor, role) {
  if (!actor || !actor.role) return false;
  if (role === 'OWNER') return false;
  return grantableRoles(actor).indexOf(role) !== -1;
}

/**
 * May `actor` change this account?
 * @returns {{ok:boolean, reason:string}}
 */
function canManageUser(actor, target) {
  if (!actor) return { ok: false, reason: 'Sign in first.' };
  if (!target) return { ok: false, reason: 'That account does not exist.' };
  /* The owner is invisible to everyone else: 404, never 403, so an admin
   * cannot even learn that the account exists by guessing ids. */
  if (target.role === 'OWNER' && actor.role !== 'OWNER') {
    return { ok: false, reason: 'notfound' };
  }
  if (actor.role === 'OWNER') return { ok: true, reason: '' };
  if (target.role === 'ADMIN') return { ok: false, reason: 'notfound' };
  if (target.id === actor.id) return { ok: false, reason: 'notfound' };
  return canGrant(actor, target.role)
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'forbidden' };
}

/**
 * Validate a role + its scope columns.
 * @returns {{errors:string[], value:object}}
 */
function validateRoleAssignment(role, lgaId, schoolId) {
  const errors = [];
  const r = String(role || '').toUpperCase();
  if (ROLES.indexOf(r) === -1) {
    errors.push('Role must be one of ' + ROLES.join(', ') + '.');
  }
  if (r === 'LGA_OFFICER' && !lgaId) errors.push('An LGA Officer must be assigned to an LGA.');
  if (r === 'SCHOOL_ADMIN' && !schoolId) errors.push('A School Admin must be assigned to a school.');
  if (r === 'OWNER') errors.push('Ownership is transferred, never assigned.');
  return {
    errors: errors,
    value: { role: r, lga_id: lgaId || null, school_id: schoolId || null }
  };
}

/** Where a user lands after signing in. */
function homeFor(role) {
  if (['OWNER', 'ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR'].indexOf(role) !== -1) return '/admin.html';
  return '/dashboard.html';
}

/**
 * SQL fragment that hides the OWNER, for queries built from a `where` array
 * joined with " AND ".  Returns an empty string for the owner themselves.
 * NB: no leading AND — the caller supplies the separator.
 */
function hideOwnerFromSql(user) {
  return isOwner(user) ? '' : "role <> 'OWNER'";
}

module.exports = {
  ROLES: ROLES,
  RANK: RANK,
  PORTAL_ROLES: PORTAL_ROLES,
  GRANTABLE: GRANTABLE,
  rank: rank,
  isOwner: isOwner,
  isAdminish: isAdminish,
  isScoped: isScoped,
  canUseAdminConsole: canUseAdminConsole,
  grantableRoles: grantableRoles,
  canGrant: canGrant,
  canManageUser: canManageUser,
  validateRoleAssignment: validateRoleAssignment,
  homeFor: homeFor,
  hideOwnerFromSql: hideOwnerFromSql
};