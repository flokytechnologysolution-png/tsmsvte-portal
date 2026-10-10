/**
 * tools/test-roles.js — the role-rule suite for lib/roles.js.
 *
 * Engine-neutral: no database and no HTTP, so it can run anywhere the code
 * runs.  `node tools/test-roles.js`  (exit code 0 = all good)
 */
'use strict';

const roles = require('../lib/roles');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ok   ' + name); }
  else {
    failed += 1;
    console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  }
}

const U = {
  owner: { id: 1, role: 'OWNER' },
  admin: { id: 2, role: 'ADMIN' },
  admin2: { id: 9, role: 'ADMIN' },
  officer: { id: 3, role: 'LGA_OFFICER' },
  officer2: { id: 10, role: 'LGA_OFFICER' },
  school: { id: 4, role: 'SCHOOL_ADMIN' },
  editor: { id: 5, role: 'EDITOR' },
  staff: { id: 6, role: 'STAFF' },
  ghost: { id: 7 }
};

function run() {
  console.log('[roles-test] lib/roles.js rule suite');

  /* ------------------------------- ranks ------------------------------- */
  check('rank order OWNER>ADMIN>OFFICER>SCHOOL>EDITOR>STAFF',
    roles.RANK.OWNER > roles.RANK.ADMIN &&
    roles.RANK.ADMIN > roles.RANK.LGA_OFFICER &&
    roles.RANK.LGA_OFFICER > roles.RANK.SCHOOL_ADMIN &&
    roles.RANK.SCHOOL_ADMIN > roles.RANK.EDITOR &&
    roles.RANK.EDITOR > roles.RANK.STAFF, roles.RANK);
  check('rank() reads the table', roles.rank('ADMIN') === roles.RANK.ADMIN);
  check('rank() of an unknown role is 0', roles.rank('NOPE') === 0);
  check('ROLES holds exactly the six roles', roles.ROLES.length === 6, roles.ROLES);
  check('PORTAL_ROLES mirrors ROLES', roles.PORTAL_ROLES.join() === roles.ROLES.join());

  /* ---------------------------- predicates ----------------------------- */
  check('isOwner: owner only', roles.isOwner(U.owner) && !roles.isOwner(U.admin) && !roles.isOwner(null));
  check('isAdminish: owner + admin only',
    roles.isAdminish(U.owner) && roles.isAdminish(U.admin) &&
    !roles.isAdminish(U.officer) && !roles.isAdminish(U.editor) && !roles.isAdminish(null));
  check('isScoped: officer + school admin only',
    roles.isScoped(U.officer) && roles.isScoped(U.school) &&
    !roles.isScoped(U.admin) && !roles.isScoped(null));
  check('canUseAdminConsole: console roles only',
    roles.canUseAdminConsole(U.owner) && roles.canUseAdminConsole(U.admin) &&
    roles.canUseAdminConsole(U.officer) && roles.canUseAdminConsole(U.school) &&
    roles.canUseAdminConsole(U.editor) &&
    !roles.canUseAdminConsole(U.staff) && !roles.canUseAdminConsole(null));

  /* ----------------------------- grants -------------------------------- */
  check('OWNER may grant every role except OWNER',
    roles.grantableRoles(U.owner).join() === 'ADMIN,LGA_OFFICER,SCHOOL_ADMIN,EDITOR,STAFF' &&
    !roles.canGrant(U.owner, 'OWNER'), roles.grantableRoles(U.owner));
  check('ADMIN may not grant ADMIN',
    !roles.canGrant(U.admin, 'ADMIN') && roles.canGrant(U.admin, 'LGA_OFFICER') &&
    roles.grantableRoles(U.admin).join() === 'LGA_OFFICER,SCHOOL_ADMIN,EDITOR,STAFF');
  check('LGA_OFFICER may grant SCHOOL_ADMIN only',
    roles.canGrant(U.officer, 'SCHOOL_ADMIN') &&
    !roles.canGrant(U.officer, 'LGA_OFFICER') && !roles.canGrant(U.officer, 'EDITOR') &&
    roles.grantableRoles(U.officer).length === 1);
  check('SCHOOL_ADMIN, EDITOR and STAFF grant nothing',
    roles.grantableRoles(U.school).length === 0 &&
    roles.grantableRoles(U.editor).length === 0 &&
    roles.grantableRoles(U.staff).length === 0);
  check('nobody may grant OWNER (any actor)',
    roles.ROLES.every(function (r) { return !roles.canGrant({ role: r }, 'OWNER'); }));
  check('canGrant refuses unknown actors and unknown roles',
    !roles.canGrant(null, 'EDITOR') && !roles.canGrant(undefined, undefined) &&
    !roles.canGrant(U.admin, 'BOGUS_ROLE'));
  check('grantableRoles hands out a copy (GRANTABLE stays pristine)',
    (function () {
      const g = roles.grantableRoles(U.admin);
      g.push('OWNER');
      return roles.grantableRoles(U.admin).indexOf('OWNER') === -1;
    })());


  /* --------------------------- canManageUser --------------------------- */
  check('no actor: sign in first',
    roles.canManageUser(null, U.staff).ok === false &&
    roles.canManageUser(null, U.staff).reason === 'Sign in first.');
  check('no target: does not exist',
    roles.canManageUser(U.admin, null).reason === 'That account does not exist.');
  check('OWNER is invisible to everyone else (notfound, never forbidden)',
    roles.canManageUser(U.admin, U.owner).reason === 'notfound' &&
    roles.canManageUser(U.officer, U.owner).reason === 'notfound' &&
    roles.canManageUser(U.school, U.owner).reason === 'notfound');
  check('OWNER may manage any account, including their own',
    roles.canManageUser(U.owner, U.admin).ok && roles.canManageUser(U.owner, U.officer).ok &&
    roles.canManageUser(U.owner, U.owner).ok);
  check('an ADMIN target is hidden from non-owners',
    roles.canManageUser(U.officer, U.admin2).reason === 'notfound' &&
    roles.canManageUser(U.school, U.admin).reason === 'notfound' &&
    roles.canManageUser(U.admin, U.admin2).reason === 'notfound');
  check('self-edit is hidden (notfound)',
    roles.canManageUser(U.officer, U.officer).reason === 'notfound' &&
    roles.canManageUser(U.admin, U.admin).reason === 'notfound');
  check('ADMIN may manage every grantable role',
    roles.canManageUser(U.admin, U.officer).ok &&
    roles.canManageUser(U.admin, U.school).ok &&
    roles.canManageUser(U.admin, U.editor).ok &&
    roles.canManageUser(U.admin, U.staff).ok);
  check('LGA_OFFICER may manage SCHOOL_ADMIN but not EDITOR',
    roles.canManageUser(U.officer, U.school).ok === true &&
    roles.canManageUser(U.officer, U.editor).reason === 'forbidden');
  check('LGA_OFFICER may not manage another officer (not grantable)',
    roles.canManageUser(U.officer, U.officer2).reason === 'forbidden');
  check('SCHOOL_ADMIN manages nobody but themselves (hidden)',
    roles.canManageUser(U.school, U.staff).reason === 'forbidden' &&
    roles.canManageUser(U.school, U.editor).reason === 'forbidden' &&
    roles.canManageUser(U.school, U.school).reason === 'notfound');
  check('EDITOR and STAFF manage nobody',
    roles.canManageUser(U.editor, U.staff).reason === 'forbidden' &&
    roles.canManageUser(U.staff, U.editor).reason === 'forbidden');

  /* --------------------- validateRoleAssignment ------------------------ */
  let v = roles.validateRoleAssignment('ADMIN', null, null);
  check('ADMIN needs no scope columns', v.errors.length === 0 && v.value.role === 'ADMIN' &&
    v.value.lga_id === null && v.value.school_id === null, v);
  v = roles.validateRoleAssignment('lga_officer', 4, null);
  check('role is upper-cased; LGA_OFFICER needs an LGA',
    v.errors.length === 0 && v.value.role === 'LGA_OFFICER' && v.value.lga_id === 4, v);
  v = roles.validateRoleAssignment('LGA_OFFICER', null, null);
  check('LGA_OFFICER without an LGA is rejected',
    v.errors.length === 1 && /LGA Officer/.test(v.errors[0]), v);
  v = roles.validateRoleAssignment('SCHOOL_ADMIN', null, 7);
  check('SCHOOL_ADMIN needs a school, not an LGA',
    v.errors.length === 0 && v.value.school_id === 7 && v.value.lga_id === null, v);
  v = roles.validateRoleAssignment('SCHOOL_ADMIN', null, null);
  check('SCHOOL_ADMIN without a school is rejected',
    v.errors.length === 1 && /School Admin/.test(v.errors[0]), v);
  v = roles.validateRoleAssignment('OWNER', null, null);
  check('OWNER can never be assigned',
    v.errors.length === 1 && /transferred/.test(v.errors[0]), v);
  v = roles.validateRoleAssignment('JANITOR', null, null);
  check('unknown role is rejected', v.errors.length === 1 && /must be one of/.test(v.errors[0]), v);

  /* ---------------------- homeFor + hideOwnerFromSql -------------------- */
  check('owner/admin/officer/school/editor land on the admin console',
    ['OWNER', 'ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR']
      .every(function (r) { return roles.homeFor(r) === '/admin.html'; }));
  check('staff (and anything unknown) lands on the dashboard',
    roles.homeFor('STAFF') === '/dashboard.html' && roles.homeFor('NOPE') === '/dashboard.html');
  check('hideOwnerFromSql: empty for the owner, hiding clause for everyone else',
    roles.hideOwnerFromSql(U.owner) === '' &&
    roles.hideOwnerFromSql(U.admin) === "role <> 'OWNER'" &&
    roles.hideOwnerFromSql(U.officer) === "role <> 'OWNER'" &&
    roles.hideOwnerFromSql(null) === "role <> 'OWNER'");

  console.log('\n[roles-test] passed=' + passed + ' failed=' + failed);
  process.exit(failed ? 1 : 0);
}

run();
