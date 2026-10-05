/**
 * middleware/scope.js — LGA / school isolation for the scoped roles.
 *
 * schools.lga holds the canonical LGA NAME (text) while users.lga_id holds an
 * lgas.id, so every rule here resolves one into the other.  The rules are:
 *
 *   OWNER / ADMIN            every school in the state.
 *   LGA_OFFICER              only schools in their own LGA; only users
 *                            attached to that LGA.
 *   SCHOOL_ADMIN             only their one school; only users assigned to it.
 *
 * Two rules are absolute:
 *
 *   1. Anything outside the caller's scope is reported as 404, never 403 and
 *      never the other scope's data, so guessing an id in the URL reveals
 *      nothing at all.
 *   2. A scope that cannot be resolved fails CLOSED (matches nothing) rather
 *      than open, so a broken assignment can never widen access.
 */
'use strict';

const db = require('../db');
const roles = require('../lib/roles');
const { toIntOrNull } = require('./validate');

/** Case/space/hyphen-insensitive key, so "Karim Lamido" == "Karim-Lamido". */
function normKey(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The same normalisation expressed in SQL, for filtering a schools table. */
function normLgaSql(alias) {
  return "lower(replace(replace(replace(replace(" + alias +
    ".lga,' ',''),'-',''),'.',''),'''',''))";
}

function lgaNameById(id) {
  const row = toIntOrNull(id) ? db.prepare('SELECT name FROM lgas WHERE id = ?').get(toIntOrNull(id)) : null;
  return row ? row.name : null;
}

/**
 * What may this user see?
 * @returns {{kind:'all'|'lga'|'school'|'none', lgaName?:string, lgaId?:number, schoolId?:number}}
 */
function scopeOf(user) {
  /* No session at all means the public reader, and the schools directory is
   * deliberately public — anonymous callers are not scoped. */
  if (!user) return { kind: 'all' };
  if (!user.role) return { kind: 'none' };
  if (user.role === 'OWNER' || user.role === 'ADMIN') return { kind: 'all' };
  if (user.role === 'EDITOR' || user.role === 'STAFF') return { kind: 'all' };
  if (user.role === 'LGA_OFFICER') {
    const name = lgaNameById(user.lga_id);
    return name ? { kind: 'lga', lgaId: toIntOrNull(user.lga_id), lgaName: name } : { kind: 'none' };
  }
  if (user.role === 'SCHOOL_ADMIN') {
    const s = toIntOrNull(user.school_id)
      ? db.prepare('SELECT id, lga FROM schools WHERE id = ?').get(toIntOrNull(user.school_id))
      : null;
    return s ? { kind: 'school', schoolId: s.id, lgaName: s.lga } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Is this user confined to part of the state? */
function isScopedUser(user) {
  const s = scopeOf(user);
  return s.kind === 'lga' || s.kind === 'school';
}

/**
 * A WHERE fragment restricting a `schools` query to the caller's scope.
 * @returns {{sql:string, params:Array}} sql is '' when unrestricted.
 */
function schoolWhere(user, alias) {
  const a = alias || 's';
  const s = scopeOf(user);
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'lga') {
    return {
      sql: '(' + a + '.lga = ? COLLATE NOCASE OR ' + normLgaSql(a) + ' = ?)',
      params: [s.lgaName, normKey(s.lgaName)]
    };
  }
  if (s.kind === 'school') return { sql: a + '.id = ?', params: [s.schoolId] };
  return { sql: '1 = 0', params: [] };            /* fail closed */
}

/** May this user see this particular school row? */
function canViewSchool(user, row) {
  if (!row) return false;
  const s = scopeOf(user);
  if (s.kind === 'all') return true;
  if (s.kind === 'lga') {
    return row.lga === s.lgaName || normKey(row.lga) === normKey(s.lgaName);
  }
  if (s.kind === 'school') return row.id === s.schoolId;
  return false;
}

/**
 * Guard for any /:id school route.  A school that exists but sits in another
 * scope is indistinguishable from one that does not exist.
 */
function requireSchoolScope(req, res, next) {
  const id = toIntOrNull(req.params.id);
  const row = id ? db.prepare('SELECT * FROM schools WHERE id = ?').get(id) : null;
  if (!canViewSchool(req.user, row)) {
    return res.status(404).json({ error: 'School not found' });
  }
  req.school = row;
  return next();
}
/** A WHERE fragment restricting a query over the `lgas` table itself. */
function lgaListWhere(user, alias) {
  const l = alias || 'l';
  const s = scopeOf(user);
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'lga') return { sql: l + '.id = ?', params: [s.lgaId] };
  if (s.kind === 'school') {
    const row = db.prepare('SELECT id FROM lgas WHERE name = ? COLLATE NOCASE').get(s.lgaName);
    return row ? { sql: l + '.id = ?', params: [row.id] } : { sql: '1 = 0', params: [] };
  }
  return { sql: '1 = 0', params: [] };
}

/* ------------------------------- users --------------------------------- */

/**
 * A WHERE fragment restricting a `users` query to the caller's scope.
 * OWNER and ADMIN accounts are never inside anybody's scope but the owner's.
 * @returns {{sql:string, params:Array}}
 */
function userWhere(user, alias) {
  const u = alias || 'u';
  const s = scopeOf(user);
  /* Unscoped callers keep whatever the route already did (the owner-hiding
   * clause lives in the route), so this adds nothing for them. */
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'none') return { sql: '1 = 0', params: [] };   /* fail closed */

  const parts = [];
  const params = [];
  if (s.kind === 'lga') {
    /* Users pinned to this LGA, plus anyone attached to a school inside it. */
    parts.push('(' + u + '.lga_id = ? OR ' + u + '.school_id IN (' +
      'SELECT sc.id FROM schools sc WHERE sc.lga = ? COLLATE NOCASE OR ' +
      normLgaSql('sc') + ' = ?))');
    params.push(s.lgaId, s.lgaName, normKey(s.lgaName));
  } else {
    parts.push(u + '.school_id = ?');
    params.push(s.schoolId);
  }
  /* A scoped caller never sees the owner or a ministry-wide admin. */
  parts.push(u + ".role NOT IN ('OWNER','ADMIN')");
  return { sql: '(' + parts.join(' AND ') + ')', params: params };
}

/** Is this user row inside the caller's scope? */
function canViewUser(user, target) {
  if (!target) return false;
  const s = scopeOf(user);
  if (s.kind === 'all') return target.role !== 'OWNER' || user.role === 'OWNER';
  if (target.role === 'OWNER' || target.role === 'ADMIN') return false;
  if (s.kind === 'lga') {
    if (target.lga_id && Number(target.lga_id) === Number(s.lgaId)) return true;
    if (!target.school_id) return false;
    const sc = db.prepare('SELECT lga FROM schools WHERE id = ?').get(target.school_id);
    return Boolean(sc) && normKey(sc.lga) === normKey(s.lgaName);
  }
  if (s.kind === 'school') return Number(target.school_id) === Number(s.schoolId);
  return false;
}

/* ------------------------------ writes --------------------------------- */

/** Fields a SCHOOL_ADMIN may change on their own school. */
const SCHOOL_ADMIN_FIELDS = ['address', 'principal', 'phone', 'email', 'type',
  'category', 'boarding', 'year_established', 'notes'];

/** May this user create a school in the given LGA? */
function canCreateSchool(user, lgaName) {
  const s = scopeOf(user);
  if (s.kind === 'all') return true;               /* OWNER / ADMIN */
  if (s.kind === 'lga') return normKey(lgaName) === normKey(s.lgaName);
  return false;                                    /* SCHOOL_ADMIN and 'none' */
}

/** May this user run a CSV import at all? */
function canImportSchools(user) {
  const s = scopeOf(user);
  return s.kind === 'all' || s.kind === 'lga';
}

/** May this user delete a school row? Only the statewide roles. */
function canDeleteSchool(user) {
  return scopeOf(user).kind === 'all';
}

/**
 * Guard for POST /schools and the CSV importer: 403 for anyone not allowed to
 * create schools at all, 422 when the LGA is outside their scope.
 */
function requireSchoolCreate(req, res, next) {
  const s = scopeOf(req.user);
  if (s.kind === 'none') return res.status(403).json({ error: 'You do not have permission to do that' });
  if (s.kind === 'school') {
    return res.status(403).json({ error: 'School administrators cannot add schools to the directory.' });
  }
  return next();
}

/**
 * Who may open the user-account console at all?  OWNER and ADMIN see the whole
 * state; the two scoped roles see their slice; everyone else is refused.
 */
function requireUserConsole(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const kind = scopeOf(req.user).kind;
  if (kind === 'all' || kind === 'lga' || kind === 'school') return next();
  return res.status(403).json({ error: 'You do not have permission to do that' });
}

module.exports = {
  normKey: normKey,
  normLgaSql: normLgaSql,
  lgaNameById: lgaNameById,
  scopeOf: scopeOf,
  isScopedUser: isScopedUser,
  schoolWhere: schoolWhere,
  lgaListWhere: lgaListWhere,
  canViewSchool: canViewSchool,
  requireSchoolScope: requireSchoolScope,
  userWhere: userWhere,
  canViewUser: canViewUser,
  SCHOOL_ADMIN_FIELDS: SCHOOL_ADMIN_FIELDS,
  canCreateSchool: canCreateSchool,
  canImportSchools: canImportSchools,
  canDeleteSchool: canDeleteSchool,
  requireSchoolCreate: requireSchoolCreate,
  requireUserConsole: requireUserConsole
};