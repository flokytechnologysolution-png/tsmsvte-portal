/**
 * middleware/scope.js — LGA / school isolation for the scoped roles.
 *
 * schools.lga holds the canonical LGA NAME (text) purely for display; the
 * scope rules below match on the real FK columns only — schools.lga_id and
 * users.lga_id — so no spelling can widen or shrink a scope.  The rules are:
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
const { asyncHandler } = require('./errors');

/* The tolerant text matching that fills schools.lga_id lives in db.normLgaKey
 * (see the one-time backfill in db.js).  Nothing here matches on text any more. */

async function lgaNameById(id) {
  const row = toIntOrNull(id) ? await db.get('SELECT name FROM lgas WHERE id = ?', [toIntOrNull(id)]) : null;
  return row ? row.name : null;
}

/**
 * What may this user see?  (Async: resolving a scoped role may need to ask
 * the database which LGA / school the account points at.)
 * @returns {Promise<{kind:'all'|'lga'|'school'|'none', lgaName?:string, lgaId?:number, schoolId?:number}>}
 */
async function scopeOf(user) {
  /* No session at all means the public reader, and the schools directory is
   * deliberately public — anonymous callers are not scoped. */
  if (!user) return { kind: 'all' };
  if (!user.role) return { kind: 'none' };
  if (user.role === 'OWNER' || user.role === 'ADMIN') return { kind: 'all' };
  if (user.role === 'EDITOR' || user.role === 'STAFF') return { kind: 'all' };
  if (user.role === 'LGA_OFFICER') {
    const name = await lgaNameById(user.lga_id);
    return name ? { kind: 'lga', lgaId: toIntOrNull(user.lga_id), lgaName: name } : { kind: 'none' };
  }
  if (user.role === 'SCHOOL_ADMIN') {
    const s = toIntOrNull(user.school_id)
      ? await db.get('SELECT id, lga, lga_id FROM schools WHERE id = ?', [toIntOrNull(user.school_id)])
      : null;
    return s
      ? { kind: 'school', schoolId: s.id, lgaId: toIntOrNull(s.lga_id), lgaName: s.lga }
      : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Is this user confined to part of the state? */
async function isScopedUser(user) {
  const s = await scopeOf(user);
  return s.kind === 'lga' || s.kind === 'school';
}

/**
 * A WHERE fragment restricting a `schools` query to the caller's scope.
 * @returns {{sql:string, params:Array}} sql is '' when unrestricted.
 */
async function schoolWhere(user, alias) {
  const a = alias || 's';
  const s = await scopeOf(user);
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'lga') return { sql: a + '.lga_id = ?', params: [s.lgaId] };
  if (s.kind === 'school') return { sql: a + '.id = ?', params: [s.schoolId] };
  return { sql: '1 = 0', params: [] };            /* fail closed */
}

/** May this user see this particular school row? */
async function canViewSchool(user, row) {
  if (!row) return false;
  const s = await scopeOf(user);
  if (s.kind === 'all') return true;
  if (s.kind === 'lga') {
    /* A row with no lga_id (an unmatched LGA name) belongs to nobody's scope. */
    return toIntOrNull(row.lga_id) !== null && toIntOrNull(row.lga_id) === toIntOrNull(s.lgaId);
  }
  if (s.kind === 'school') return row.id === s.schoolId;
  return false;
}

/**
 * Guard for any /:id school route.  A school that exists but sits in another
 * scope is indistinguishable from one that does not exist.
 */
const requireSchoolScope = asyncHandler(async function (req, res, next) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM schools WHERE id = ?', [id]) : null;
  if (!(await canViewSchool(req.user, row))) {
    return res.status(404).json({ error: 'School not found' });
  }
  req.school = row;
  return next();
});

/* ------------------------------- teachers ------------------------------ */

/**
 * A WHERE fragment restricting a `teachers` query to the caller's scope.
 * Teachers inherit their visibility from the school they belong to, so a
 * broken scope assignment fails CLOSED (matches nothing) exactly like
 * schoolWhere does.
 * @returns {{sql:string, params:Array}} sql is '' when unrestricted.
 */
async function teacherWhere(user, alias) {
  const t = alias || 't';
  const s = await scopeOf(user);
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'lga') {
    return { sql: t + '.school_id IN (SELECT sc.id FROM schools sc WHERE sc.lga_id = ?)', params: [s.lgaId] };
  }
  if (s.kind === 'school') return { sql: t + '.school_id = ?', params: [s.schoolId] };
  return { sql: '1 = 0', params: [] };            /* fail closed */
}

/**
 * Guard for any /:id teacher route.  A teacher that exists but sits at a
 * school outside the caller's scope is indistinguishable from one that does
 * not exist (404, never 403), same rule as the schools.
 */
const requireTeacherScope = asyncHandler(async function (req, res, next) {
  const id = toIntOrNull(req.params.id);
  const row = id ? await db.get('SELECT * FROM teachers WHERE id = ?', [id]) : null;
  const school = row
    ? await db.get('SELECT * FROM schools WHERE id = ?', [row.school_id])
    : null;
  if (!row || !(await canViewSchool(req.user, school))) {
    return res.status(404).json({ error: 'Teacher not found' });
  }
  req.teacher = row;
  return next();
});

/** A WHERE fragment restricting a query over the `lgas` table itself. */
async function lgaListWhere(user, alias) {
  const l = alias || 'l';
  const s = await scopeOf(user);
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'lga') return { sql: l + '.id = ?', params: [s.lgaId] };
  if (s.kind === 'school') {
    /* The LGA of the school they administer — by id, never by spelling. */
    return s.lgaId ? { sql: l + '.id = ?', params: [s.lgaId] } : { sql: '1 = 0', params: [] };
  }
  return { sql: '1 = 0', params: [] };
}

/* ------------------------------- users --------------------------------- */

/**
 * A WHERE fragment restricting a `users` query to the caller's scope.
 * OWNER and ADMIN accounts are never inside anybody's scope but the owner's.
 * @returns {{sql:string, params:Array}}
 */
async function userWhere(user, alias) {
  const u = alias || 'u';
  const s = await scopeOf(user);
  /* Unscoped callers keep whatever the route already did (the owner-hiding
   * clause lives in the route), so this adds nothing for them. */
  if (s.kind === 'all') return { sql: '', params: [] };
  if (s.kind === 'none') return { sql: '1 = 0', params: [] };   /* fail closed */

  const parts = [];
  const params = [];
  if (s.kind === 'lga') {
    /* Users pinned to this LGA, plus anyone attached to a school inside it. */
    parts.push('(' + u + '.lga_id = ? OR ' + u + '.school_id IN (' +
      'SELECT sc.id FROM schools sc WHERE sc.lga_id = ?))');
    params.push(s.lgaId, s.lgaId);
  } else {
    parts.push(u + '.school_id = ?');
    params.push(s.schoolId);
  }
  /* A scoped caller never sees the owner or a ministry-wide admin. */
  parts.push(u + ".role NOT IN ('OWNER','ADMIN')");
  return { sql: '(' + parts.join(' AND ') + ')', params: params };
}

/** Is this user row inside the caller's scope? */
async function canViewUser(user, target) {
  if (!target) return false;
  const s = await scopeOf(user);
  if (s.kind === 'all') return target.role !== 'OWNER' || user.role === 'OWNER';
  if (target.role === 'OWNER' || target.role === 'ADMIN') return false;
  if (s.kind === 'lga') {
    if (target.lga_id && Number(target.lga_id) === Number(s.lgaId)) return true;
    if (!target.school_id) return false;
    const sc = await db.get('SELECT lga_id FROM schools WHERE id = ?', [target.school_id]);
    return Boolean(sc) && toIntOrNull(sc.lga_id) !== null &&
      toIntOrNull(sc.lga_id) === toIntOrNull(s.lgaId);
  }
  if (s.kind === 'school') return Number(target.school_id) === Number(s.schoolId);
  return false;
}

/* ------------------------------ writes --------------------------------- */

/** Fields a SCHOOL_ADMIN may change on their own school. */
const SCHOOL_ADMIN_FIELDS = ['address', 'principal', 'phone', 'email', 'type',
  'category', 'boarding', 'year_established', 'notes'];

/** May this user create a school in the given LGA (a validated lgas.id)? */
async function canCreateSchool(user, lgaId) {
  const s = await scopeOf(user);
  if (s.kind === 'all') return true;               /* OWNER / ADMIN */
  if (s.kind === 'lga') return toIntOrNull(lgaId) !== null && toIntOrNull(lgaId) === s.lgaId;
  return false;                                    /* SCHOOL_ADMIN and 'none' */
}

/** May this user run a CSV import at all? */
async function canImportSchools(user) {
  const s = await scopeOf(user);
  return s.kind === 'all' || s.kind === 'lga';
}

/** May this user delete a school row? Only the statewide roles. */
async function canDeleteSchool(user) {
  return (await scopeOf(user)).kind === 'all';
}

/**
 * Guard for POST /schools and the CSV importer: 403 for anyone not allowed to
 * create schools at all, 422 when the LGA is outside their scope.
 */
const requireSchoolCreate = asyncHandler(async function (req, res, next) {
  const s = await scopeOf(req.user);
  if (s.kind === 'none') return res.status(403).json({ error: 'You do not have permission to do that' });
  if (s.kind === 'school') {
    return res.status(403).json({ error: 'School administrators cannot add schools to the directory.' });
  }
  return next();
});

/**
 * Who may enter the user-account console to WRITE?  OWNER, ADMIN and the LGA
 * officer.  SCHOOL_ADMIN has no account management at all — every write route
 * answers 403 for them — and EDITOR / STAFF never had any either: before this
 * gate they were refused by requireRole('ADMIN'), and they still are.
 */
const requireUserConsole = asyncHandler(async function (req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const r = req.user.role;
  const allowed = r === 'OWNER' || r === 'ADMIN' || r === 'LGA_OFFICER';
  /* A scope that cannot be resolved is refused rather than shown an empty
   * directory: a broken assignment must never look like a working one. */
  if (allowed && (await scopeOf(req.user)).kind !== 'none') return next();
  return res.status(403).json({ error: 'You do not have permission to do that' });
});

/**
 * Reading the account list is one notch wider: a SCHOOL_ADMIN may see their
 * own school's accounts (scope.userWhere keeps the slice tight) but can never
 * change one.  EDITOR and STAFF are still refused.
 */
const requireUserList = asyncHandler(async function (req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const r = req.user.role;
  const allowed = r === 'OWNER' || r === 'ADMIN' || r === 'LGA_OFFICER' || r === 'SCHOOL_ADMIN';
  if (allowed && (await scopeOf(req.user)).kind !== 'none') return next();
  return res.status(403).json({ error: 'You do not have permission to do that' });
});

/**
 * Reading AND writing the teachers register is open to exactly four roles:
 * OWNER, ADMIN (whole state), LGA_OFFICER (their LGA) and SCHOOL_ADMIN
 * (their one school).  EDITOR and STAFF are content/self-service roles and
 * are refused outright; a scope that cannot be resolved is refused too,
 * never shown an empty register that looks like a working one.
 */
const requireTeacherConsole = asyncHandler(async function (req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const r = req.user.role;
  const allowed = r === 'OWNER' || r === 'ADMIN' || r === 'LGA_OFFICER' || r === 'SCHOOL_ADMIN';
  if (allowed && (await scopeOf(req.user)).kind !== 'none') return next();
  return res.status(403).json({ error: 'You do not have permission to do that' });
});

module.exports = {
  lgaNameById: lgaNameById,
  scopeOf: scopeOf,
  isScopedUser: isScopedUser,
  schoolWhere: schoolWhere,
  lgaListWhere: lgaListWhere,
  canViewSchool: canViewSchool,
  requireSchoolScope: requireSchoolScope,
  teacherWhere: teacherWhere,
  requireTeacherScope: requireTeacherScope,
  requireTeacherConsole: requireTeacherConsole,
  userWhere: userWhere,
  canViewUser: canViewUser,
  SCHOOL_ADMIN_FIELDS: SCHOOL_ADMIN_FIELDS,
  canCreateSchool: canCreateSchool,
  canImportSchools: canImportSchools,
  canDeleteSchool: canDeleteSchool,
  requireSchoolCreate: requireSchoolCreate,
  requireUserConsole: requireUserConsole,
  requireUserList: requireUserList
};