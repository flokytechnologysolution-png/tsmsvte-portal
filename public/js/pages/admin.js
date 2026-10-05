/**
 * public/js/pages/admin.js — the administrator console.
 *
 * Hash-routed sections (#overview, #staff, #chats, ...).  The side nav is
 * filtered by role: EDITOR sees content only, ADMIN adds people/schools/SMS,
 * OWNER adds audit/backup/transfer.
 */
(function () {
  'use strict';

  const main = document.getElementById('admin-main');
  const navHost = document.getElementById('side-nav');
  let role = 'ADMIN';

  const SECTIONS = [
    { id: 'overview', label: 'Overview', roles: ['OWNER', 'ADMIN', 'EDITOR'] },
    { id: 'staff', label: 'Staff registrations', roles: ['OWNER', 'ADMIN'], pill: 'staffPending' },
    { id: 'schools', label: 'Schools', roles: ['OWNER', 'ADMIN'] },
    { id: 'news', label: 'News', roles: ['OWNER', 'ADMIN', 'EDITOR'] },
    { id: 'events', label: 'Events', roles: ['OWNER', 'ADMIN', 'EDITOR'] },
    { id: 'circulars', label: 'Circulars', roles: ['OWNER', 'ADMIN'] },
    { id: 'faq', label: 'FAQ & knowledge base', roles: ['OWNER', 'ADMIN', 'EDITOR'] },
    { id: 'users', label: 'User accounts', roles: ['OWNER', 'ADMIN'] },
    { id: 'chats', label: 'Live chat', roles: ['OWNER', 'ADMIN'], pill: 'chatsWaiting' },
    { id: 'sms', label: 'Bulk SMS', roles: ['OWNER', 'ADMIN'] },
    { id: 'settings', label: 'Site settings', roles: ['OWNER', 'ADMIN'] },
    { id: 'audit', label: 'Audit log', roles: ['OWNER'] },
    { id: 'backup', label: 'Backup & ownership', roles: ['OWNER'] }
  ];
  const pills = { staffPending: 0, chatsWaiting: 0 };

  function visibleSections() {
    return SECTIONS.filter(function (s) { return s.roles.indexOf(role) !== -1; });
  }

  function renderNav(activeId) {
    navHost.innerHTML = visibleSections().map(function (s) {
      const pill = s.pill && pills[s.pill] ? '<span class="pill">' + pills[s.pill] + '</span>' : '';
      return '<a href="#' + s.id + '" class="' + (s.id === activeId ? 'active' : '') + '">' +
        '<span>' + App.esc(s.label) + '</span>' + pill + '</a>';
    }).join('');
  }

  function currentSection() {
    const hash = window.location.hash.replace('#', '').split('?')[0];
    const allowed = visibleSections().map(function (s) { return s.id; });
    if (allowed.indexOf(hash) !== -1) return hash;
    return allowed[0] || 'overview';
  }

  function section(id, title, bodyHtml) {
    main.innerHTML =
      '<div class="card">' +
        '<div class="card-head"><h2>' + App.esc(title) + '</h2><div id="section-tools"></div></div>' +
        '<div id="section-body">' + bodyHtml + '</div>' +
      '</div>';
  }

  function loading() {
    main.innerHTML = '<div class="card"><div class="empty-state"><strong>Loading…</strong></div></div>';
  }

  function failed(err) {
    main.innerHTML = '<div class="card">' +
      App.emptyState('Could not load this section', err && err.message ? err.message : 'Please refresh.') +
      '</div>';
  }

  function refreshPills() {
    if (role === 'OWNER' || role === 'ADMIN') {
      App.api('/api/staff?status=PENDING&limit=1').then(function (d) {
        pills.staffPending = d.total || 0;
        renderNav(currentSection());
      }).catch(function () { /* ignore */ });
      App.api('/api/chat/admin/queue').then(function (d) {
        pills.chatsWaiting = (d.sessions || []).filter(function (s) { return s.status === 'waiting'; }).length;
        renderNav(currentSection());
      }).catch(function () { /* ignore */ });
    }
  }

  /* --------------------------------------------------------------------- *
   * Shared widget: confirm dialog (promise based)                          *
   * --------------------------------------------------------------------- */
  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      const box = App.openModal(
        '<h3>' + App.esc(title) + '</h3>' +
        '<p>' + App.esc(message) + '</p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" data-act="no">Cancel</button>' +
          '<button class="btn btn-danger" type="button" data-act="yes">' + App.esc(okLabel || 'Confirm') + '</button>' +
        '</div>'
      );
      App.on(box.querySelector('[data-act="no"]'), 'click', function () { App.closeModal(); resolve(false); });
      App.on(box.querySelector('[data-act="yes"]'), 'click', function () { App.closeModal(); resolve(true); });
    });
  }

  function copyText(text, label) {
    const done = function () { App.toast((label || 'Copied') + ' to the clipboard.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { App.toast('Copy failed — select the text manually.', 'err'); }
      ta.remove();
    }
  }
    /* --------------------------------------------------------------------- *
   * Overview                                                               *
   * --------------------------------------------------------------------- */
  function loadOverview() {
    section('overview', 'Overview', '<div class="empty-state"><strong>Loading…</strong></div>');
    App.api('/api/admin/dashboard').then(function (d) {
      const c = d.cards;
      const cards = [
        [c.schools, 'Active schools'],
        [c.staff_pending, 'Staff awaiting approval'],
        [c.staff_approved, 'Approved staff'],
        [c.news_published, 'Published news'],
        [c.waiting_chats, 'Chats waiting'],
        [c.users, 'Active users']
      ];
      const maxLga = Math.max.apply(null, d.schools_per_lga.map(function (r) { return r.total; }).concat([1]));

      const integ = d.integrations;
      const badges =
        '<div class="integ">' +
          '<span class="badge ' + (integ.ai.configured ? 'ok' : 'muted') + '">AI: ' + App.esc(integ.ai.model) + '</span>' +
          '<span class="badge ' + (integ.sms.dryRun ? 'warn' : 'ok') + '">SMS: ' + App.esc(integ.sms.provider) +
            (integ.sms.dryRun ? ' (dry-run)' : ' (live)') + '</span>' +
          '<span class="badge ' + (integ.mail.external ? 'ok' : 'info') + '">Mail: ' + App.esc(integ.mail.adapter) + '</span>' +
          '<span class="badge ' + (integ.admin_chat_status === 'online' ? 'ok' : 'muted') + '">Chat: ' +
            App.esc(integ.admin_chat_status) + '</span>' +
          '<span class="badge info">Sockets: ' + (integ.sockets ? integ.sockets.sockets : 0) + '</span>' +
        '</div>';

      main.innerHTML =
        '<div class="card">' +
          '<div class="card-head"><h2>At a glance</h2></div>' +
          '<div class="grid grid-3">' +
            cards.map(function (x) {
              return '<div class="stat-card"><div class="num">' + Number(x[0] || 0) +
                '</div><div class="label">' + App.esc(x[1]) + '</div></div>';
            }).join('') +
          '</div>' +
          '<hr class="divider">' +
          '<h3>Integrations</h3>' + badges +
        '</div>' +

        '<div class="grid grid-2 mt-2">' +
          '<div class="card">' +
            '<h3>Schools per LGA</h3>' +
            d.schools_per_lga.map(function (r) {
              const pct = Math.round((r.total / maxLga) * 100);
              return '<div class="bar-row"><span>' + App.esc(r.name) + '</span>' +
                '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
                '<strong>' + r.total + '</strong></div>';
            }).join('') +
          '</div>' +
          '<div class="card">' +
            '<h3>Recent activity</h3>' +
            (d.recent_audit.length
              ? '<div class="detail-list pre-scroll">' + d.recent_audit.map(function (a) {
                  return '<div class="r"><span class="k" style="flex:1;text-align:left">' +
                    '<strong>' + App.esc(a.user_name) + '</strong> ' + App.esc(a.action) +
                    (a.entity ? ' <small>(' + App.esc(a.entity) + ' ' + App.esc(a.entity_id) + ')</small>' : '') +
                    '</span><span class="v nowrap"><small>' + App.esc(App.fmtDate(a.created_at, true)) + '</small></span></div>';
                }).join('') + '</div>'
              : '<p class="muted">No activity recorded yet.</p>') +
            (role === 'OWNER' ? '<p class="mt-2"><a class="btn btn-sm btn-outline" href="#audit">Open full audit log</a></p>' : '') +
          '</div>' +
        '</div>';

      if (c.last_sms) {
        const box = document.createElement('div');
        box.className = 'card mt-2';
        box.innerHTML = '<h3>Last SMS batch</h3><p class="mb-0">' +
          App.esc(c.last_sms.at ? App.fmtDate(c.last_sms.at, true) : '') + ' — ' +
          Number(c.last_sms.to) + ' recipients, status ' + App.esc(c.last_sms.status) +
          (c.last_sms.dry_run ? ' (dry-run)' : '') +
          (c.last_sms.by ? ', sent by ' + App.esc(c.last_sms.by) : '') + '</p>';
        main.appendChild(box);
      }
    }).catch(failed);
  }
    /* --------------------------------------------------------------------- *
   * Staff registrations (approve / reject / reset token)                   *
   * --------------------------------------------------------------------- */
  const staffFilters = { status: '', lga: '', q: '', page: 1 };

  function loadStaff() {
    section('staff', 'Staff registrations',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="s-q">Search</label>' +
          '<input type="search" id="s-q" placeholder="Name, email, staff number…" value="' + App.esc(staffFilters.q) + '"></div>' +
        '<div class="field"><label for="s-status">Status</label>' +
          '<select id="s-status"><option value="">All</option>' +
          '<option value="PENDING">Pending</option><option value="APPROVED">Approved</option>' +
          '<option value="REJECTED">Rejected</option></select></div>' +
        '<div class="field"><label for="s-lga">LGA</label><select id="s-lga"><option value="">All LGAs</option></select></div>' +
        '<a class="btn btn-ghost btn-sm" href="/api/staff/export.csv">Export CSV</a>' +
      '</div>' +
      '<div id="staff-rows"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div id="staff-pager"></div>');

    document.getElementById('s-status').value = staffFilters.status;
    App.on(document.getElementById('s-status'), 'change', function () {
      staffFilters.status = this.value; staffFilters.page = 1; renderStaffRows();
    });
    App.on(document.getElementById('s-lga'), 'change', function () {
      staffFilters.lga = this.value; staffFilters.page = 1; renderStaffRows();
    });
    App.on(document.getElementById('s-q'), 'input', App.debounce(function () {
      staffFilters.q = document.getElementById('s-q').value.trim();
      staffFilters.page = 1;
      renderStaffRows();
    }, 300));

    App.api('/api/schools/lgas').then(function (d) {
      const sel = document.getElementById('s-lga');
      d.lgas.forEach(function (l) {
        const o = document.createElement('option');
        o.value = l.name; o.textContent = l.name;
        sel.appendChild(o);
      });
      sel.value = staffFilters.lga;
    }).catch(function () { /* LGA filter optional */ });

    renderStaffRows();
  }

  function renderStaffRows() {
    const host = document.getElementById('staff-rows');
    if (!host) return;
    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const parts = ['page=' + staffFilters.page, 'limit=25'];
    if (staffFilters.status) parts.push('status=' + staffFilters.status);
    if (staffFilters.lga) parts.push('lga=' + encodeURIComponent(staffFilters.lga));
    if (staffFilters.q) parts.push('q=' + encodeURIComponent(staffFilters.q));

    App.api('/api/staff?' + parts.join('&')).then(function (d) {
      if (!d.staff.length) {
        host.innerHTML = App.emptyState('No registrations match', 'Adjust the filters above.');
        document.getElementById('staff-pager').innerHTML = '';
        return;
      }
      const badgeFor = function (s) {
        const cls = s === 'APPROVED' ? 'ok' : (s === 'REJECTED' ? 'danger' : 'warn');
        return '<span class="badge ' + cls + '">' + App.esc(s) + '</span>';
      };
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Rank / school</th><th>LGA</th><th>Status</th><th>Registered</th><th></th>' +
        '</tr></thead><tbody>' +
        d.staff.map(function (s) {
          return '<tr>' +
            '<td><strong>' + App.esc(s.full_name) + '</strong><br><small>' + App.esc(s.email) + '</small>' +
              (s.staff_number ? '<br><small>#' + App.esc(s.staff_number) + '</small>' : '') + '</td>' +
            '<td>' + App.esc(s.rank || '—') + '<br><small>' + App.esc(s.school_name || '') + '</small></td>' +
            '<td>' + App.esc(s.lga || '—') + '</td>' +
            '<td>' + badgeFor(s.status) +
              (s.status === 'REJECTED' && s.rejection_reason ? '<br><small>' + App.esc(s.rejection_reason) + '</small>' : '') + '</td>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(s.created_at)) + '</td>' +
            '<td class="actions">' +
              (s.status !== 'APPROVED'
                ? '<button class="btn btn-sm" data-act="approve" data-id="' + s.id + '">Approve</button> ' : '') +
              (s.status !== 'REJECTED'
                ? '<button class="btn btn-sm btn-ghost" data-act="reject" data-id="' + s.id + '">Reject</button>' : '') +
              (s.user_id
                ? '<button class="btn btn-sm btn-outline" data-act="token" data-id="' + s.id + '">Reset token</button>' : '') +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      document.getElementById('staff-pager').innerHTML = App.pager(d.page, d.pages, 'data-spage');
      App.qsa('#staff-pager button[data-spage]').forEach(function (b) {
        App.on(b, 'click', function () {
          staffFilters.page = Number(b.getAttribute('data-spage')) || 1;
          renderStaffRows();
        });
      });
      wireStaffActions();
      refreshPills();
    }).catch(failed);
  }
    function wireStaffActions() {
    App.qsa('[data-act="approve"]', main).forEach(function (btn) {
      App.on(btn, 'click', function () {
        const id = btn.getAttribute('data-id');
        App.busy(btn, function () { return App.api('/api/staff/' + id + '/approve', { method: 'POST', body: {} }); })
          .then(function (data) {
            renderStaffRows();
            const box = App.openModal(
              '<h3>Staff member approved</h3>' +
              '<p>The portal mail address is <strong>' + App.esc(data.mail_address) + '</strong>.</p>' +
              '<p>Give this one-time password token to the staff member. It is shown only once.</p>' +
              '<div class="token-box">' + App.esc(data.reset_token) + '</div>' +
              '<div class="copy-row"><button class="btn btn-sm" type="button" id="copy-tok">Copy token</button>' +
              '<a class="btn btn-sm btn-outline" href="/reset-password.html?token=' + encodeURIComponent(data.reset_token) +
              '">Open reset page</a></div>' +
              '<p class="kv-note mt-2">' + App.esc(data.note || '') + '</p>' +
              '<div class="modal-actions"><button class="btn" type="button" id="done-tok">Done</button></div>');
            App.on(box.querySelector('#copy-tok'), 'click', function () { copyText(data.reset_token, 'Token'); });
            App.on(box.querySelector('#done-tok'), 'click', App.closeModal);
          }).catch(function (err) { App.toast(err.message, 'err'); });
      });
    });

    App.qsa('[data-act="reject"]', main).forEach(function (btn) {
      App.on(btn, 'click', function () {
        const id = btn.getAttribute('data-id');
        const box = App.openModal(
          '<h3>Reject registration</h3>' +
          '<div class="field"><label for="rej-reason">Reason (optional, shown to the applicant)</label>' +
          '<textarea id="rej-reason" rows="3" maxlength="500"></textarea></div>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost" type="button" id="rej-cancel">Cancel</button>' +
            '<button class="btn btn-danger" type="button" id="rej-ok">Reject</button>' +
          '</div>');
        App.on(box.querySelector('#rej-cancel'), 'click', App.closeModal);
        App.on(box.querySelector('#rej-ok'), 'click', function () {
          const reason = box.querySelector('#rej-reason').value.trim();
          App.busy(this, function () {
            return App.api('/api/staff/' + id + '/reject', { method: 'POST', body: { reason: reason } });
          }).then(function () {
            App.closeModal();
            App.toast('Registration rejected.', 'ok');
            renderStaffRows();
          }).catch(function (err) { App.toast(err.message, 'err'); });
        });
      });
    });

    App.qsa('[data-act="token"]', main).forEach(function (btn) {
      App.on(btn, 'click', function () {
        const id = btn.getAttribute('data-id');
        App.busy(btn, function () {
          return App.api('/api/staff/' + id + '/reset-token', { method: 'POST', body: {} });
        }).then(function (data) {
          const box = App.openModal(
            '<h3>Password reset token</h3>' +
            '<p>Hand this token to the staff member directly — it is shown only once.</p>' +
            '<div class="token-box">' + App.esc(data.reset_token) + '</div>' +
            '<div class="copy-row"><button class="btn btn-sm" type="button" id="copy-tok2">Copy token</button>' +
            '<a class="btn btn-sm btn-outline" href="/reset-password.html?token=' +
              encodeURIComponent(data.reset_token) + '">Open reset page</a></div>' +
            '<p class="kv-note mt-2">Expires ' + App.esc(App.fmtDate(data.reset_expires, true)) + '</p>' +
            '<div class="modal-actions"><button class="btn" type="button" id="done-tok2">Done</button></div>');
          App.on(box.querySelector('#copy-tok2'), 'click', function () { copyText(data.reset_token, 'Token'); });
          App.on(box.querySelector('#done-tok2'), 'click', App.closeModal);
        }).catch(function (err) { App.toast(err.message, 'err'); });
      });
    });
  }
    /* --------------------------------------------------------------------- *
   * Schools (CRUD + CSV import/export)                                     *
   * --------------------------------------------------------------------- */
  const schoolFilters = { q: '', lga: '', page: 1 };
  const TYPE_LABEL = {
    junior_secondary: 'Junior secondary', senior_secondary: 'Senior secondary',
    technical: 'Technical', vocational: 'Vocational'
  };
  const CAT_LABEL = { boys: 'Boys', girls: 'Girls', mixed: 'Mixed' };

  function loadSchools() {
    section('schools', 'Schools',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="sc-q">Search</label>' +
          '<input type="search" id="sc-q" placeholder="School name, address or principal…" value="' + App.esc(schoolFilters.q) + '"></div>' +
        '<div class="field"><label for="sc-lga">LGA</label><select id="sc-lga"><option value="">All LGAs</option></select></div>' +
        '<button class="btn" type="button" id="sc-new">+ Add school</button>' +
        '<a class="btn btn-ghost btn-sm" href="/api/schools/export.csv">Export</a>' +
        '<a class="btn btn-ghost btn-sm" href="/api/schools/template.csv">Template</a>' +
        '<button class="btn btn-outline btn-sm" type="button" id="sc-import">CSV import</button>' +
      '</div>' +
      '<div id="sc-rows"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div id="sc-pager"></div>');

    App.on(document.getElementById('sc-new'), 'click', function () { schoolEditor(null); });
    App.on(document.getElementById('sc-import'), 'click', importDialog);
    App.on(document.getElementById('sc-q'), 'input', App.debounce(function () {
      schoolFilters.q = document.getElementById('sc-q').value.trim();
      schoolFilters.page = 1;
      renderSchoolRows();
    }, 300));
    App.on(document.getElementById('sc-lga'), 'change', function () {
      schoolFilters.lga = this.value; schoolFilters.page = 1; renderSchoolRows();
    });

    App.api('/api/schools/lgas').then(function (d) {
      const sel = document.getElementById('sc-lga');
      d.lgas.forEach(function (l) {
        const o = document.createElement('option');
        o.value = l.name; o.textContent = l.name;
        sel.appendChild(o);
      });
      sel.value = schoolFilters.lga;
    }).catch(function () { /* optional */ });

    renderSchoolRows();
  }

  function renderSchoolRows() {
    const host = document.getElementById('sc-rows');
    if (!host) return;
    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const parts = ['page=' + schoolFilters.page, 'limit=25'];
    if (schoolFilters.q) parts.push('q=' + encodeURIComponent(schoolFilters.q));
    if (schoolFilters.lga) parts.push('lga=' + encodeURIComponent(schoolFilters.lga));

    App.api('/api/schools?' + parts.join('&')).then(function (d) {
      if (!d.schools.length) {
        host.innerHTML = App.emptyState('No schools recorded',
          'Add schools one at a time or bulk-import a CSV built from the downloadable template.');
        document.getElementById('sc-pager').innerHTML = '';
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>School</th><th>LGA</th><th>Type</th><th>Principal</th><th>Phone</th><th></th>' +
        '</tr></thead><tbody>' +
        d.schools.map(function (s) {
          return '<tr>' +
            '<td><strong>' + App.esc(s.name) + '</strong><br><small>' + App.esc(s.address || '') + '</small></td>' +
            '<td>' + App.esc(s.lga) + '</td>' +
            '<td><span class="badge">' + App.esc(TYPE_LABEL[s.type] || s.type) + '</span><br>' +
              '<span class="badge info">' + App.esc(CAT_LABEL[s.category] || s.category) + '</span></td>' +
            '<td>' + App.esc(s.principal || '—') + '</td>' +
            '<td class="nowrap">' + App.esc(s.phone || '—') + '</td>' +
            '<td class="actions">' +
              '<a class="btn btn-sm btn-ghost" href="/school/' + s.id + '">View</a> ' +
              '<button class="btn btn-sm btn-outline" data-sc-edit="' + s.id + '">Edit</button> ' +
              '<button class="btn btn-sm btn-danger" data-sc-del="' + s.id + '">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      document.getElementById('sc-pager').innerHTML = App.pager(d.page, d.pages, 'data-scpage');
      App.qsa('#sc-pager button[data-scpage]').forEach(function (b) {
        App.on(b, 'click', function () {
          schoolFilters.page = Number(b.getAttribute('data-scpage')) || 1;
          renderSchoolRows();
        });
      });
      App.qsa('[data-sc-edit]', main).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-sc-edit'));
          const rec = d.schools.find(function (x) { return x.id === id; });
          schoolEditor(rec);
        });
      });
      App.qsa('[data-sc-del]', main).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = b.getAttribute('data-sc-del');
          confirmDialog('Delete school', 'Remove this school record permanently? This cannot be undone.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.busy(b, function () { return App.api('/api/schools/' + id, { method: 'DELETE' }); })
                .then(function () { App.toast('School deleted.', 'ok'); renderSchoolRows(); })
                .catch(function (err) { App.toast(err.message, 'err'); });
            });
        });
      });
    }).catch(failed);
  }
  /* --- school create / edit ------------------------------------------------ */
  function schoolEditor(rec) {
    const isNew = !rec;
    App.api('/api/schools/lgas').then(function (d) {
      const lgas = d.lgas.map(function (l) { return l.name; });
      const BOARD_LABEL = { boarding: 'Boarding', day: 'Day', both: 'Both' };
      const sel = function (name, map, current) {
        return '<select id="sf-' + name + '">' + Object.keys(map).map(function (k) {
          return '<option value="' + App.esc(k) + '"' + (k === current ? ' selected' : '') + '>' +
            App.esc(map[k]) + '</option>';
        }).join('') + '</select>';
      };

      const box = App.openModal(
        '<h3>' + (isNew ? 'Add a school' : 'Edit school') + '</h3>' +
        (isNew ? '' : '<p class="kv-note">Record #' + App.esc(rec.id) + '</p>') +
        '<div class="form-grid">' +
          '<div class="field span-2"><label for="sf-name">School name *</label>' +
            '<input id="sf-name" maxlength="200" value="' + App.esc(rec ? rec.name : '') + '"></div>' +
          '<div class="field"><label for="sf-lga">LGA *</label><select id="sf-lga">' +
            lgas.map(function (l) {
              return '<option value="' + App.esc(l) + '"' +
                (rec && rec.lga === l ? ' selected' : '') + '>' + App.esc(l) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field"><label for="sf-type">Type *</label>' +
            sel('type', TYPE_LABEL, rec ? rec.type : 'junior_secondary') + '</div>' +
          '<div class="field"><label for="sf-category">Category *</label>' +
            sel('category', CAT_LABEL, rec ? rec.category : 'mixed') + '</div>' +
          '<div class="field"><label for="sf-boarding">Boarding *</label>' +
            sel('boarding', BOARD_LABEL, rec ? rec.boarding : 'day') + '</div>' +
          '<div class="field span-2"><label for="sf-address">Address</label>' +
            '<input id="sf-address" maxlength="300" value="' + App.esc(rec ? rec.address : '') + '"></div>' +
          '<div class="field"><label for="sf-principal">Principal</label>' +
            '<input id="sf-principal" maxlength="120" value="' + App.esc(rec ? rec.principal : '') + '"></div>' +
          '<div class="field"><label for="sf-phone">Phone</label>' +
            '<input id="sf-phone" maxlength="40" value="' + App.esc(rec ? rec.phone : '') + '"></div>' +
          '<div class="field"><label for="sf-email">Email</label>' +
            '<input id="sf-email" type="email" maxlength="120" value="' + App.esc(rec ? rec.email : '') + '"></div>' +
          '<div class="field"><label for="sf-year">Year established</label>' +
            '<input id="sf-year" inputmode="numeric" maxlength="4" value="' +
              App.esc(rec && rec.year_established ? rec.year_established : '') + '"></div>' +
          '<div class="field span-2"><label for="sf-notes">Internal notes</label>' +
            '<textarea id="sf-notes" rows="2" maxlength="1000">' + App.esc(rec ? rec.notes : '') + '</textarea></div>' +
          '<div class="field span-2"><label for="sf-status">Status</label><select id="sf-status">' +
            '<option value="active"' + (!rec || rec.status === 'active' ? ' selected' : '') + '>Active</option>' +
            '<option value="inactive"' + (rec && rec.status === 'inactive' ? ' selected' : '') + '>Inactive</option>' +
          '</select></div>' +
        '</div>' +
        '<p class="form-error" id="sf-err" hidden></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" id="sf-cancel">Cancel</button>' +
          '<button class="btn" type="button" id="sf-save">' + (isNew ? 'Create school' : 'Save changes') + '</button>' +
        '</div>', { wide: true });

      App.on(box.querySelector('#sf-cancel'), 'click', App.closeModal);
      App.on(box.querySelector('#sf-save'), 'click', function () {
        const payload = {
          name: box.querySelector('#sf-name').value.trim(),
          lga: box.querySelector('#sf-lga').value,
          type: box.querySelector('#sf-type').value,
          category: box.querySelector('#sf-category').value,
          boarding: box.querySelector('#sf-boarding').value,
          address: box.querySelector('#sf-address').value.trim(),
          principal: box.querySelector('#sf-principal').value.trim(),
          phone: box.querySelector('#sf-phone').value.trim(),
          email: box.querySelector('#sf-email').value.trim(),
          year_established: box.querySelector('#sf-year').value.trim(),
          notes: box.querySelector('#sf-notes').value.trim(),
          status: box.querySelector('#sf-status').value
        };
        const err = box.querySelector('#sf-err');
        err.hidden = true;
        if (!payload.name) { err.hidden = false; err.textContent = 'A school name is required.'; return; }

        App.busy(this, function () {
          return App.api(isNew ? '/api/schools' : '/api/schools/' + rec.id,
            { method: isNew ? 'POST' : 'PUT', body: payload });
        }).then(function () {
          App.closeModal();
          App.toast(isNew ? 'School added.' : 'School updated.', 'ok');
          renderSchoolRows();
        }).catch(function (e) {
          err.hidden = false;
          err.textContent = e.message;
        });
      });
    }).catch(failed);
  }
  /* --- CSV import (dry-run first, then commit) ---------------------------- */
  function errorList(errors) {
    if (!errors || !errors.length) return '';
    return '<div class="pre-scroll detail-list" style="margin-top:10px">' + errors.map(function (e) {
      return '<div class="r"><span class="k">Row ' + App.esc(e.row) + '</span>' +
        '<span class="v">' + App.esc(e.error) + '</span></div>';
    }).join('') + '</div>';
  }

  function importDialog() {
    const box = App.openModal(
      '<h3>Bulk import schools</h3>' +
      '<p>Download the <a href="/api/schools/template.csv">CSV template</a>, fill it in, then upload it. ' +
      'A school with the same name and LGA is updated; anything else is created.</p>' +
      '<div class="field"><label for="csv-file">CSV file</label>' +
        '<input id="csv-file" type="file" accept=".csv,text/csv"></div>' +
      '<p class="kv-note">Always preview first — a real import writes to the database immediately.</p>' +
      '<div id="csv-report"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" id="csv-cancel">Cancel</button>' +
        '<button class="btn btn-outline" type="button" id="csv-check">Preview</button>' +
        '<button class="btn" type="button" id="csv-go" disabled>Import for real</button>' +
      '</div>');

    const fileInput = box.querySelector('#csv-file');
    const report = box.querySelector('#csv-report');
    const go = box.querySelector('#csv-go');
    let picked = null;

    const send = function (dryRun) {
      const fd = new FormData();
      fd.append('file', picked);
      if (dryRun) fd.append('dry_run', '1');
      return App.apiForm('/api/schools/import', fd);
    };

    App.on(box.querySelector('#csv-cancel'), 'click', App.closeModal);
    App.on(fileInput, 'change', function () {
      picked = this.files && this.files[0] ? this.files[0] : null;
      go.disabled = !picked;
      report.innerHTML = '';
    });
    App.on(box.querySelector('#csv-check'), 'click', function () {
      if (!picked) return;
      App.busy(this, function () { return send(true); }).then(function (data) {
        const r = data.report;
        report.innerHTML =
          '<div class="placeholder-note">Dry run: ' + r.total + ' row(s) read — <strong>' + r.created +
          '</strong> would be created, <strong>' + r.updated + '</strong> updated, <strong>' +
          r.failed + '</strong> rejected.</div>' + errorList(r.errors);
        go.disabled = (r.created + r.updated) === 0;
      }).catch(function (e) { App.toast(e.message, 'err'); });
    });
    App.on(go, 'click', function () {
      if (!picked) return;
      confirmDialog('Import for real', 'This writes ' + picked.name + ' to the database. Continue?', 'Import')
        .then(function (ok) {
          if (!ok) return;
          App.busy(go, function () { return send(false); }).then(function (data) {
            App.closeModal();
            const r = data.report;
            App.toast('Imported: ' + r.created + ' created, ' + r.updated + ' updated, ' +
              r.failed + ' rejected.', 'ok');
            renderSchoolRows();
          }).catch(function (e) { App.toast(e.message, 'err'); });
        });
    });
  }
  /* --------------------------------------------------------------------- *
   * Events (EDITOR and above)                                              *
   * --------------------------------------------------------------------- */
  const eventFilters = { q: '', status: '' };

  function loadEvents() {
    section('events', 'Events',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="ev-q">Search</label>' +
          '<input type="search" id="ev-q" placeholder="Title, place or description…" value="' +
          App.esc(eventFilters.q) + '"></div>' +
        '<div class="field"><label for="ev-status">Status</label><select id="ev-status">' +
          '<option value="">All</option><option value="draft">Drafts</option>' +
          '<option value="published">Published</option></select></div>' +
        '<button class="btn" type="button" id="ev-new">+ Add event</button>' +
      '</div>' +
      '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Event</th><th>Date</th><th>Location</th><th>Status</th><th class="right">Actions</th>' +
      '</tr></thead><tbody id="ev-rows"><tr><td colspan="5">' +
        '<div class="empty-state"><strong>Loading…</strong></div></td></tr></tbody></table></div>');

    App.on(document.getElementById('ev-new'), 'click', function () { eventEditor(null); });
    App.on(document.getElementById('ev-q'), 'input', App.debounce(function () {
      eventFilters.q = document.getElementById('ev-q').value.trim();
      renderEventRows();
    }, 300));
    App.on(document.getElementById('ev-status'), 'change', function () {
      eventFilters.status = this.value;
      renderEventRows();
    });
    renderEventRows();
  }

  function renderEventRows() {
    const host = document.getElementById('ev-rows');
    if (!host) return;
    const parts = ['all=1'];
    if (eventFilters.q) parts.push('q=' + encodeURIComponent(eventFilters.q));

    App.api('/api/events?' + parts.join('&')).then(function (d) {
      let rows = d.events || [];
      if (eventFilters.status) rows = rows.filter(function (e) { return e.status === eventFilters.status; });

      if (!rows.length) {
        host.innerHTML = '<tr><td colspan="5">' +
          App.emptyState('No events yet', 'Add the ministry\'s first meeting or workshop.') + '</td></tr>';
        return;
      }

      host.innerHTML = rows.map(function (e) {
        const id = Number(e.id);
        return '<tr>' +
          '<td><strong>' + App.esc(e.title) + '</strong>' +
            (e.description ? '<br><small class="muted">' + App.esc(e.description.slice(0, 120)) + '</small>' : '') +
          '</td>' +
          '<td class="nowrap">' + App.esc(e.event_date || '—') + '</td>' +
          '<td>' + App.esc(e.location || '—') + '</td>' +
          '<td><span class="badge ' + (e.status === 'published' ? 'ok' : 'warn') + '">' +
            App.esc(e.status) + '</span></td>' +
          '<td class="actions">' +
            '<button class="btn btn-sm" type="button" data-ev-edit="' + id + '">Edit</button>' +
            '<button class="btn btn-sm btn-danger" type="button" data-ev-del="' + id + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      host.querySelectorAll('[data-ev-edit]').forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-ev-edit'));
          eventEditor(rows.find(function (x) { return Number(x.id) === id; }) || null);
        });
      });
      host.querySelectorAll('[data-ev-del]').forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-ev-del'));
          const ev = rows.find(function (x) { return Number(x.id) === id; });
          confirmDialog('Delete event',
            'Delete "' + (ev ? ev.title : 'this event') + '"? This cannot be undone.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.busy(b, function () { return App.api('/api/events/' + id, { method: 'DELETE' }); })
                .then(function () { App.toast('Event deleted.', 'ok'); renderEventRows(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(function (err) {
      host.innerHTML = '<tr><td colspan="5">' +
        App.emptyState('Could not load events', err.message) + '</td></tr>';
    });
  }

  /* --------------------------------------------------------------------- *
   * News (EDITOR and above)                                                *
   * --------------------------------------------------------------------- */
  const newsFilters = { status: '', q: '', page: 1 };

  function loadNews() {
    section('news', 'News articles',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="nw-q">Search</label>' +
          '<input type="search" id="nw-q" placeholder="Headline or summary…" value="' + App.esc(newsFilters.q) + '"></div>' +
        '<div class="field"><label for="nw-status">Status</label><select id="nw-status">' +
          '<option value="">All</option><option value="draft">Drafts</option>' +
          '<option value="published">Published</option></select></div>' +
        '<button class="btn" type="button" id="nw-new">+ Write article</button>' +
      '</div>' +
      '<div id="nw-rows"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div id="nw-pager"></div>');

    document.getElementById('nw-status').value = newsFilters.status;
    App.on(document.getElementById('nw-new'), 'click', function () { newsEditor(null); });
    App.on(document.getElementById('nw-q'), 'input', App.debounce(function () {
      newsFilters.q = document.getElementById('nw-q').value.trim();
      newsFilters.page = 1;
      renderNewsRows();
    }, 300));
    App.on(document.getElementById('nw-status'), 'change', function () {
      newsFilters.status = this.value; newsFilters.page = 1; renderNewsRows();
    });
    renderNewsRows();
  }

  function renderNewsRows() {
    const host = document.getElementById('nw-rows');
    if (!host) return;
    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const parts = ['page=' + newsFilters.page, 'limit=20'];
    if (newsFilters.status) parts.push('status=' + newsFilters.status);
    if (newsFilters.q) parts.push('q=' + encodeURIComponent(newsFilters.q));

    App.api('/api/news?' + parts.join('&')).then(function (d) {
      if (!d.news.length) {
        host.innerHTML = App.emptyState('No articles match', 'Write the first one, or relax the filters.');
        document.getElementById('nw-pager').innerHTML = '';
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Headline</th><th>Category</th><th>Status</th><th>Date</th><th></th>' +
        '</tr></thead><tbody>' +
        d.news.map(function (n) {
          return '<tr>' +
            '<td><strong>' + App.esc(n.title) + '</strong><br><small>' +
              App.esc((n.summary || '').slice(0, 110)) + '</small></td>' +
            '<td>' + App.esc(n.category) + '</td>' +
            '<td><span class="badge ' + (n.status === 'published' ? 'ok' : 'warn') + '">' +
              App.esc(n.status) + '</span></td>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(n.published_at || n.created_at)) + '</td>' +
            '<td class="actions">' +
              '<a class="btn btn-sm btn-ghost" href="/news/' + encodeURIComponent(n.slug) + '">View</a> ' +
              '<button class="btn btn-sm btn-outline" data-nw-edit="' + n.id + '">Edit</button> ' +
              '<button class="btn btn-sm btn-danger" data-nw-del="' + n.id + '">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      document.getElementById('nw-pager').innerHTML = App.pager(d.page, d.pages, 'data-nwpage');
      App.qsa('#nw-pager button[data-nwpage]').forEach(function (b) {
        App.on(b, 'click', function () {
          newsFilters.page = Number(b.getAttribute('data-nwpage')) || 1;
          renderNewsRows();
        });
      });
      App.qsa('[data-nw-edit]', main).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-nw-edit'));
          newsEditor(d.news.find(function (x) { return x.id === id; }) || null);
        });
      });
      App.qsa('[data-nw-del]', main).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = b.getAttribute('data-nw-del');
          confirmDialog('Delete article', 'This permanently removes the article from the portal.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.busy(b, function () { return App.api('/api/news/' + id, { method: 'DELETE' }); })
                .then(function () { App.toast('Article deleted.', 'ok'); renderNewsRows(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(failed);
  }
  function eventEditor(rec) {
    const isNew = !rec;
    const e = rec || { title: '', description: '', event_date: '', location: '', image: '', status: 'draft' };

    const box = App.openModal(
      '<h3>' + (isNew ? 'Add event' : 'Edit event') + '</h3>' +
      '<form id="ev-form" class="form">' +
        '<div class="form-grid">' +
          '<div class="field span-2"><label for="ev-title">Title</label>' +
            '<input id="ev-title" value="' + App.esc(e.title) + '"></div>' +
          '<div class="field"><label for="ev-date">Date</label>' +
            '<input id="ev-date" type="date" value="' + App.esc(e.event_date) + '"></div>' +
          '<div class="field"><label for="ev-loc">Location</label>' +
            '<input id="ev-loc" value="' + App.esc(e.location) + '"></div>' +
          '<div class="field span-2"><label for="ev-desc">Description</label>' +
            '<textarea id="ev-desc" rows="4">' + App.esc(e.description) + '</textarea></div>' +
          '<div class="field"><label for="ev-status-f">Status</label><select id="ev-status-f">' +
            '<option value="draft"' + (e.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
            '<option value="published"' + (e.status === 'published' ? ' selected' : '') + '>Published</option>' +
          '</select></div>' +
          '<div class="field"><label for="ev-img">Image</label><input id="ev-img" type="file" accept="image/*">' +
            (e.image ? '<p class="kv-note mt-0">Current: ' + App.esc(e.image) + '</p>' : '') + '</div>' +
        '</div>' +
        '<p class="form-error" id="ev-error" hidden></p>' +
        '<div class="form-actions">' +
          '<button class="btn" type="submit">' + (isNew ? 'Create event' : 'Save changes') + '</button>' +
          '<button class="btn btn-ghost" type="button" id="ev-cancel">Cancel</button>' +
        '</div>' +
      '</form>');

    const err = box.querySelector('#ev-error');
    const form = box.querySelector('#ev-form');
    const submit = form.querySelector('button[type="submit"]');

    App.on(box.querySelector('#ev-cancel'), 'click', function () { App.closeModal(); });
    App.on(form, 'submit', function (ev2) {
      ev2.preventDefault();
      const fd = new FormData();
      fd.append('title', box.querySelector('#ev-title').value.trim());
      fd.append('event_date', box.querySelector('#ev-date').value);
      fd.append('location', box.querySelector('#ev-loc').value.trim());
      fd.append('description', box.querySelector('#ev-desc').value);
      fd.append('status', box.querySelector('#ev-status-f').value);
      const picked = box.querySelector('#ev-img').files[0];
      if (picked) fd.append('image', picked);

      App.busy(submit, function () {
        return App.apiForm(isNew ? '/api/events' : '/api/events/' + e.id, fd, isNew ? 'POST' : 'PUT');
      }).then(function () {
        App.closeModal();
        App.toast(isNew ? 'Event created.' : 'Event saved.', 'ok');
        renderEventRows();
      }).catch(function (x) { err.hidden = false; err.textContent = x.message; });
    });
  }

  /* --- article editor ------------------------------------------------------ */
  function newsEditor(rec) {
    const isNew = !rec;
    /* The list endpoint omits the body, so fetch the full record on edit. */
    const ready = isNew ? Promise.resolve(null) : App.api('/api/news/' + rec.id);

    ready.then(function (full) {
      const n = full ? full.news || full : rec;
      const box = App.openModal(
        '<h3>' + (isNew ? 'Write an article' : 'Edit article') + '</h3>' +
        '<div class="form-grid">' +
          '<div class="field span-2"><label for="nf-title">Headline *</label>' +
            '<input id="nf-title" maxlength="200" value="' + App.esc(n ? n.title : '') + '"></div>' +
          '<div class="field"><label for="nf-category">Category</label>' +
            '<input id="nf-category" maxlength="60" value="' + App.esc(n ? n.category : 'General') + '"></div>' +
          '<div class="field"><label for="nf-status">Status</label><select id="nf-status">' +
            '<option value="draft"' + (n && n.status === 'published' ? '' : ' selected') + '>Draft</option>' +
            '<option value="published"' + (n && n.status === 'published' ? ' selected' : '') + '>Published</option>' +
          '</select></div>' +
          '<div class="field span-2"><label for="nf-summary">Summary</label>' +
            '<textarea id="nf-summary" rows="2" maxlength="400">' + App.esc(n ? n.summary : '') + '</textarea></div>' +
          '<div class="field span-2"><label for="nf-body">Body *</label>' +
            '<textarea id="nf-body" rows="10" maxlength="40000">' + App.esc(n ? n.body : '') + '</textarea></div>' +
          '<div class="field span-2"><label for="nf-cover">Cover image</label>' +
            '<input id="nf-cover" type="file" accept="image/*">' +
            (n && n.cover_image
              ? '<p class="kv-note mt-0">Current: <a href="' + App.esc(n.cover_image) + '">' +
                App.esc(n.cover_image) + '</a> — upload a new file to replace it.</p>'
              : '') +
          '</div>' +
        '</div>' +
        '<p class="form-error" id="nf-err" hidden></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" id="nf-cancel">Cancel</button>' +
          '<button class="btn" type="button" id="nf-save">' + (isNew ? 'Create' : 'Save') + '</button>' +
        '</div>', { wide: true });

      App.on(box.querySelector('#nf-cancel'), 'click', App.closeModal);
      App.on(box.querySelector('#nf-save'), 'click', function () {
        const err = box.querySelector('#nf-err');
        err.hidden = true;
        const title = box.querySelector('#nf-title').value.trim();
        const bodyText = box.querySelector('#nf-body').value.trim();
        if (!title || !bodyText) {
          err.hidden = false;
          err.textContent = !title ? 'A headline is required.' : 'The article body cannot be empty.';
          return;
        }

        /* Uploads go through FormData, so every field rides along with it. */
        const fd = new FormData();
        fd.append('title', title);
        fd.append('body', bodyText);
        fd.append('summary', box.querySelector('#nf-summary').value.trim());
        fd.append('category', box.querySelector('#nf-category').value.trim() || 'General');
        fd.append('status', box.querySelector('#nf-status').value);
        const cover = box.querySelector('#nf-cover').files[0];
        if (cover) fd.append('cover', cover);

        App.busy(this, function () {
          return App.apiForm(isNew ? '/api/news' : '/api/news/' + n.id, fd,
            isNew ? 'POST' : 'PUT');
        }).then(function () {
          App.closeModal();
          App.toast(isNew ? 'Article created.' : 'Article saved.', 'ok');
          renderNewsRows();
        }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
      });
    }).catch(failed);
  }
  /* --------------------------------------------------------------------- *
   * Circulars (document uploads)                                           *
   * --------------------------------------------------------------------- */
  const circFilters = { q: '', category: '' };

  function loadCirculars() {
    section('circulars', 'Circulars & official documents',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="ci-q">Search</label>' +
          '<input type="search" id="ci-q" placeholder="Title or description…" value="' + App.esc(circFilters.q) + '"></div>' +
        '<div class="field"><label for="ci-cat">Category</label><select id="ci-cat"><option value="">All</option></select></div>' +
        '<button class="btn" type="button" id="ci-new">+ Upload circular</button>' +
      '</div>' +
      '<div id="ci-rows"><div class="empty-state"><strong>Loading…</strong></div></div>');

    App.on(document.getElementById('ci-new'), 'click', function () { circularEditor(null); });
    App.on(document.getElementById('ci-q'), 'input', App.debounce(function () {
      circFilters.q = document.getElementById('ci-q').value.trim();
      renderCircularRows();
    }, 300));
    App.on(document.getElementById('ci-cat'), 'change', function () {
      circFilters.category = this.value; renderCircularRows();
    });
    renderCircularRows();
  }

  function renderCircularRows() {
    const host = document.getElementById('ci-rows');
    if (!host) return;
    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const parts = ['all=1'];
    if (circFilters.q) parts.push('q=' + encodeURIComponent(circFilters.q));
    if (circFilters.category) parts.push('category=' + encodeURIComponent(circFilters.category));

    App.api('/api/circulars?' + parts.join('&')).then(function (d) {
      const sel = document.getElementById('ci-cat');
      const wanted = [''].concat(d.categories).join('|');
      if (sel.getAttribute('data-filled') !== wanted) {
        sel.innerHTML = '<option value="">All categories</option>' + d.categories.map(function (c) {
          return '<option value="' + App.esc(c) + '">' + App.esc(c) + '</option>';
        }).join('');
        sel.value = circFilters.category;
        sel.setAttribute('data-filled', wanted);
      }

      if (!d.circulars.length) {
        host.innerHTML = App.emptyState('No circulars', 'Upload the official PDF so staff can download it.');
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Title</th><th>Category</th><th>File</th><th>Status</th><th>Uploaded</th><th></th>' +
        '</tr></thead><tbody>' +
        d.circulars.map(function (c) {
          return '<tr>' +
            '<td><strong>' + App.esc(c.title) + '</strong>' +
              (c.description ? '<br><small>' + App.esc(c.description.slice(0, 120)) + '</small>' : '') + '</td>' +
            '<td>' + App.esc(c.category) + '</td>' +
            '<td class="nowrap"><a href="' + App.esc(c.file_path) + '">' + App.esc(c.file_name || 'Download') + '</a>' +
              '<br><small>' + App.fmtSize(c.file_size) + '</small></td>' +
            '<td><span class="badge ' + (c.status === 'published' ? 'ok' : 'warn') + '">' +
              App.esc(c.status) + '</span></td>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(c.created_at)) + '</td>' +
            '<td class="actions">' +
              '<button class="btn btn-sm btn-outline" data-ci-edit="' + c.id + '">Edit</button> ' +
              '<button class="btn btn-sm btn-danger" data-ci-del="' + c.id + '">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      App.qsa('[data-ci-edit]', main).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-ci-edit'));
          circularEditor(d.circulars.find(function (x) { return x.id === id; }) || null);
        });
      });
      App.qsa('[data-ci-del]', main).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = b.getAttribute('data-ci-del');
          confirmDialog('Delete circular',
            'The record and the uploaded file are both removed. This cannot be undone.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.busy(b, function () { return App.api('/api/circulars/' + id, { method: 'DELETE' }); })
                .then(function () { App.toast('Circular deleted.', 'ok'); renderCircularRows(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(failed);
  }
  /* --- circular editor ----------------------------------------------------- */
  function circularEditor(rec) {
    const isNew = !rec;
    const box = App.openModal(
      '<h3>' + (isNew ? 'Upload a circular' : 'Edit circular') + '</h3>' +
      '<div class="form-grid">' +
        '<div class="field span-2"><label for="cf-title">Title *</label>' +
          '<input id="cf-title" maxlength="200" value="' + App.esc(rec ? rec.title : '') + '"></div>' +
        '<div class="field"><label for="cf-category">Category</label>' +
          '<input id="cf-category" maxlength="60" value="' + App.esc(rec ? rec.category : 'Circular') + '"></div>' +
        '<div class="field"><label for="cf-status">Status</label><select id="cf-status">' +
          '<option value="published"' + (!rec || rec.status === 'published' ? ' selected' : '') + '>Published</option>' +
          '<option value="draft"' + (rec && rec.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
        '</select></div>' +
        '<div class="field span-2"><label for="cf-desc">Description</label>' +
          '<textarea id="cf-desc" rows="3" maxlength="1000">' + App.esc(rec ? rec.description : '') + '</textarea></div>' +
        '<div class="field span-2"><label for="cf-file">Document ' + (isNew ? '*' : '(optional — replaces the current file)') + '</label>' +
          '<input id="cf-file" type="file" accept=".pdf,.doc,.docx,image/*">' +
          (rec && rec.file_name
            ? '<p class="kv-note mt-0">Current file: <a href="' + App.esc(rec.file_path) + '">' +
              App.esc(rec.file_name) + '</a> (' + App.fmtSize(rec.file_size) + ')</p>'
            : '<p class="kv-note mt-0">PDF, Word or a scanned image. Up to the configured upload limit.</p>') +
        '</div>' +
      '</div>' +
      '<p class="form-error" id="cf-err" hidden></p>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" id="cf-cancel">Cancel</button>' +
        '<button class="btn" type="button" id="cf-save">' + (isNew ? 'Upload' : 'Save changes') + '</button>' +
      '</div>', { wide: true });

    App.on(box.querySelector('#cf-cancel'), 'click', App.closeModal);
    App.on(box.querySelector('#cf-save'), 'click', function () {
      const err = box.querySelector('#cf-err');
      err.hidden = true;
      const title = box.querySelector('#cf-title').value.trim();
      const file = box.querySelector('#cf-file').files[0];
      if (!title) { err.hidden = false; err.textContent = 'A title is required.'; return; }
      if (isNew && !file) { err.hidden = false; err.textContent = 'Attach the document to upload.'; return; }

      const fd = new FormData();
      fd.append('title', title);
      fd.append('description', box.querySelector('#cf-desc').value.trim());
      fd.append('category', box.querySelector('#cf-category').value.trim() || 'Circular');
      fd.append('status', box.querySelector('#cf-status').value);
      if (file) fd.append('file', file);

      App.busy(this, function () {
        return App.apiForm(isNew ? '/api/circulars' : '/api/circulars/' + rec.id, fd,
          isNew ? 'POST' : 'PUT');
      }).then(function () {
        App.closeModal();
        App.toast(isNew ? 'Circular uploaded.' : 'Circular updated.', 'ok');
        renderCircularRows();
      }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
    });
  }
  /* --------------------------------------------------------------------- *
   * FAQ and the AI knowledge base                                          *
   * --------------------------------------------------------------------- */
  let faqTab = 'faq';

  function loadFaq() {
    section('faq', 'FAQ & knowledge base',
      '<div class="tabs-row">' +
        '<button type="button" id="tab-faq" class="active">FAQ (public)</button>' +
        '<button type="button" id="tab-kb">AI knowledge base</button>' +
      '</div>' +
      '<div id="faq-body"><div class="empty-state"><strong>Loading…</strong></div></div>');

    App.on(document.getElementById('tab-faq'), 'click', function () { faqTab = 'faq'; loadFaq(); });
    App.on(document.getElementById('tab-kb'), 'click', function () { faqTab = 'kb'; loadFaq(); });

    if (faqTab === 'kb') renderKbRows(); else renderFaqRows();
  }

  function renderFaqRows() {
    const host = document.getElementById('faq-body');
    host.innerHTML =
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="fq-q">Search</label>' +
          '<input type="search" id="fq-q" placeholder="Question, answer or keyword…"></div>' +
        '<button class="btn" type="button" id="fq-new">+ Add question</button>' +
      '</div>' +
      '<div id="fq-rows"><div class="empty-state"><strong>Loading…</strong></div></div>';
    const q = (App.qs('#fq-q') || {}).value || '';

    App.on(document.getElementById('fq-new'), 'click', function () { faqEditor(null); });
    App.on(document.getElementById('fq-q'), 'input', App.debounce(function () { renderFaqRows(); }, 300));

    App.api('/api/faqs?all=1' + (q ? '&q=' + encodeURIComponent(q) : '')).then(function (d) {
      const rows = document.getElementById('fq-rows');
      if (!d.faqs.length) {
        rows.innerHTML = App.emptyState('No questions yet',
          'These answers appear in the public FAQ and guide the chat assistant.');
        return;
      }
      rows.innerHTML = d.faqs.map(function (f) {
        return '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3 style="margin:0;font-size:17px">' + App.esc(f.question) + '</h3>' +
            '<span class="badge ' + (f.status === 'published' ? 'ok' : 'warn') + '">' + App.esc(f.status) + '</span></div>' +
          '<p style="white-space:pre-wrap">' + App.esc(f.answer) + '</p>' +
          '<div class="integ">' +
            '<span class="badge muted">' + App.esc(f.category) + '</span>' +
            (f.keywords ? '<span class="badge info">' + App.esc(f.keywords) + '</span>' : '') +
            '<span class="badge muted">order ' + Number(f.sort_order || 0) + '</span>' +
          '</div>' +
          '<div class="form-actions">' +
            '<button class="btn btn-sm btn-outline" data-fq-edit="' + f.id + '">Edit</button>' +
            '<button class="btn btn-sm btn-danger" data-fq-del="' + f.id + '">Delete</button>' +
          '</div>' +
        '</div>';
      }).join('');

      App.qsa('[data-fq-edit]', host).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-fq-edit'));
          faqEditor(d.faqs.find(function (x) { return x.id === id; }) || null);
        });
      });
      App.qsa('[data-fq-del]', host).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = b.getAttribute('data-fq-del');
          confirmDialog('Delete FAQ entry', 'The question is removed from the public site.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.busy(b, function () { return App.api('/api/faqs/' + id, { method: 'DELETE' }); })
                .then(function () { App.toast('Entry deleted.', 'ok'); renderFaqRows(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(failed);
  }
  /* --- knowledge base list (ADMIN only; editors see a notice) -------------- */
  function renderKbRows() {
    const host = document.getElementById('faq-body');
    if (role === 'EDITOR') {
      host.innerHTML = App.emptyState('Administrator only',
        'Changing what the assistant may answer is restricted to OWNER and ADMIN accounts.');
      return;
    }
    host.innerHTML =
      '<div class="placeholder-note">These entries are the only source the chat assistant answers from. ' +
      'Keep them factual and current; anything not listed here should be answered by a human.</div>' +
      '<div class="filter-bar mt-2">' +
        '<div class="field grow"><label for="kb-q">Search</label>' +
          '<input type="search" id="kb-q" placeholder="Question or keyword…"></div>' +
        '<button class="btn" type="button" id="kb-new">+ Add entry</button>' +
      '</div>' +
      '<div id="kb-rows"><div class="empty-state"><strong>Loading…</strong></div></div>';
    const q = (App.qs('#kb-q') || {}).value || '';

    App.on(document.getElementById('kb-new'), 'click', function () { faqEditor(null, true); });
    App.on(document.getElementById('kb-q'), 'input', App.debounce(function () { renderKbRows(); }, 300));

    App.api('/api/faqs/knowledge-base').then(function (d) {
      const rows = document.getElementById('kb-rows');
      const list = q
        ? d.entries.filter(function (e) {
            return (e.question + ' ' + e.answer + ' ' + (e.keywords || ''))
              .toLowerCase().indexOf(q.toLowerCase()) !== -1;
          })
        : d.entries;
      if (!list.length) {
        rows.innerHTML = App.emptyState('Knowledge base is empty',
          'Add the questions the assistant is allowed to answer.');
        return;
      }
      rows.innerHTML = list.map(function (e) {
        return '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3 style="margin:0;font-size:17px">' + App.esc(e.question) + '</h3>' +
            '<span class="badge ' + (e.status === 'published' ? 'ok' : 'warn') + '">' + App.esc(e.status) + '</span></div>' +
          '<p style="white-space:pre-wrap">' + App.esc(e.answer) + '</p>' +
          (e.keywords ? '<p class="kv-note mb-0">Keywords: ' + App.esc(e.keywords) + '</p>' : '') +
          '<div class="form-actions">' +
            '<button class="btn btn-sm btn-outline" data-kb-edit="' + e.id + '">Edit</button>' +
            '<button class="btn btn-sm btn-danger" data-kb-del="' + e.id + '">Delete</button>' +
          '</div>' +
        '</div>';
      }).join('');

      App.qsa('[data-kb-edit]', rows).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-kb-edit'));
          faqEditor(list.find(function (x) { return x.id === id; }) || null, true);
        });
      });
      App.qsa('[data-kb-del]', rows).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = b.getAttribute('data-kb-del');
          confirmDialog('Delete knowledge base entry', 'The assistant will no longer answer from this entry.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.busy(b, function () {
                return App.api('/api/faqs/knowledge-base/' + id, { method: 'DELETE' });
              }).then(function () { App.toast('Entry deleted.', 'ok'); renderKbRows(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(failed);
  }
  /* --- FAQ / knowledge base editor ----------------------------------------- */
  function faqEditor(rec, isKb) {
    const base = isKb ? '/api/faqs/knowledge-base' : '/api/faqs';
    const isNew = !rec;
    const box = App.openModal(
      '<h3>' + (isKb ? 'Knowledge base' : 'FAQ') + ' — ' + (isNew ? 'new entry' : 'edit') + '</h3>' +
      '<div class="form-grid">' +
        '<div class="field span-2"><label for="ef-question">Question *</label>' +
          '<input id="ef-question" maxlength="300" value="' + App.esc(rec ? rec.question : '') + '"></div>' +
        '<div class="field span-2"><label for="ef-answer">Answer *</label>' +
          '<textarea id="ef-answer" rows="7" maxlength="8000">' + App.esc(rec ? rec.answer : '') + '</textarea></div>' +
        '<div class="field"><label for="ef-category">Category</label>' +
          '<input id="ef-category" maxlength="60" value="' + App.esc(rec ? rec.category : 'General') + '"' +
            (isKb ? ' disabled' : '') + '></div>' +
        '<div class="field"><label for="ef-status">Status</label><select id="ef-status">' +
          '<option value="published"' + (!rec || rec.status === 'published' ? ' selected' : '') + '>Published</option>' +
          '<option value="draft"' + (rec && rec.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
        '</select></div>' +
        '<div class="field span-2"><label for="ef-keywords">Keywords</label>' +
          '<input id="ef-keywords" maxlength="300" value="' + App.esc(rec ? rec.keywords : '') + '">' +
          '<p class="kv-note mt-0">Comma-separated words the assistant matches on, e.g. "result, admission, cap".</p>' +
        '</div>' +
        (isKb ? '' :
          '<div class="field span-2"><label for="ef-order">Sort order</label>' +
            '<input id="ef-order" inputmode="numeric" value="' + App.esc(rec ? rec.sort_order : 0) + '">' +
            '<p class="kv-note mt-0">Lower numbers appear first.</p></div>') +
      '</div>' +
      '<p class="form-error" id="ef-err" hidden></p>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" id="ef-cancel">Cancel</button>' +
        '<button class="btn" type="button" id="ef-save">' + (isNew ? 'Create' : 'Save') + '</button>' +
      '</div>', { wide: true });

    App.on(box.querySelector('#ef-cancel'), 'click', App.closeModal);
    App.on(box.querySelector('#ef-save'), 'click', function () {
      const err = box.querySelector('#ef-err');
      err.hidden = true;
      const payload = {
        question: box.querySelector('#ef-question').value.trim(),
        answer: box.querySelector('#ef-answer').value.trim(),
        keywords: box.querySelector('#ef-keywords').value.trim(),
        status: box.querySelector('#ef-status').value
      };
      if (!isKb) {
        payload.category = box.querySelector('#ef-category').value.trim() || 'General';
        payload.sort_order = Number(box.querySelector('#ef-order').value) || 0;
      }
      if (!payload.question || !payload.answer) {
        err.hidden = false;
        err.textContent = !payload.question ? 'The question is required.' : 'The answer is required.';
        return;
      }

      App.busy(this, function () {
        return App.api(isNew ? base : base + '/' + rec.id,
          { method: isNew ? 'POST' : 'PUT', body: payload });
      }).then(function () {
        App.closeModal();
        App.toast(isNew ? 'Entry created.' : 'Entry saved.', 'ok');
        if (isKb) renderKbRows(); else renderFaqRows();
      }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
    });
  }
  /* --------------------------------------------------------------------- *
   * User accounts (role changes are OWNER-only)                           *
   * --------------------------------------------------------------------- */
  const userFilters = { q: '', role: '', grantable: [] };

  const ROLE_LABEL = {
    OWNER: 'Owner', ADMIN: 'Ministry admin', LGA_OFFICER: 'LGA officer',
    SCHOOL_ADMIN: 'School admin', EDITOR: 'Editor', STAFF: 'Staff'
  };
  const ROLE_BADGE = {
    OWNER: 'ok', ADMIN: 'info', LGA_OFFICER: 'info', SCHOOL_ADMIN: 'info',
    EDITOR: 'muted', STAFF: 'muted'
  };

  function loadUsers() {
    /* OWNER is never offered in the filter: to a non-owner that account does
     * not exist at all, and the owner has their own section. */
    const filterRoles = ['ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR', 'STAFF'];
    section('users', 'User accounts',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="us-q">Search</label>' +
          '<input type="search" id="us-q" placeholder="Name, email or portal address…" value="' + App.esc(userFilters.q) + '"></div>' +
        '<div class="field"><label for="us-role">Role</label><select id="us-role">' +
          '<option value="">All roles</option>' +
          filterRoles.map(function (r) {
            return '<option value="' + r + '">' + App.esc(ROLE_LABEL[r] || r) + '</option>';
          }).join('') +
        '</select></div>' +
        '<button class="btn" type="button" id="us-new" disabled>+ Add account</button>' +
      '</div>' +
      '<p class="kv-note" id="us-hint"></p>' +
      '<div id="us-rows"><div class="empty-state"><strong>Loading…</strong></div></div>');

    document.getElementById('us-role').value = userFilters.role;
    App.on(document.getElementById('us-q'), 'input', App.debounce(function () {
      userFilters.q = document.getElementById('us-q').value.trim();
      renderUserRows();
    }, 300));
    App.on(document.getElementById('us-role'), 'change', function () {
      userFilters.role = this.value; renderUserRows();
    });
    App.on(document.getElementById('us-new'), 'click', function () { createAccountForm(); });
    renderUserRows();
  }

  function renderUserRows() {
    const host = document.getElementById('us-rows');
    if (!host) return;
    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const parts = [];
    if (userFilters.role) parts.push('role=' + userFilters.role);
    if (userFilters.q) parts.push('q=' + encodeURIComponent(userFilters.q));

    App.api('/api/staff/users/list' + (parts.length ? '?' + parts.join('&') : '')).then(function (d) {
      /* The server tells us which roles this person may hand out. */
      userFilters.grantable = d.grantable_roles || [];
      const newBtn = document.getElementById('us-new');
      if (newBtn) newBtn.disabled = userFilters.grantable.length === 0;
      const hint = document.getElementById('us-hint');
      if (hint) {
        hint.textContent = userFilters.grantable.length
          ? ('You can create: ' + userFilters.grantable.map(function (r) {
              return ROLE_LABEL[r] || r;
            }).join(', ') + '.')
          : 'You cannot create accounts. You can still issue password reset tokens.';
      }

      if (!d.users.length) {
        host.innerHTML = App.emptyState('No accounts match', 'Adjust the filters above.');
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Portal address</th><th>Role</th><th>Scope</th><th>Status</th><th>Last sign-in</th><th></th>' +
        '</tr></thead><tbody>' +
        d.users.map(function (u) {
          /* Only offer Edit where the grant rules allow it: never on yourself,
           * never on the owner, never on a peer admin unless you are the owner. */
          const canEdit = u.role !== 'OWNER' && u.id !== App.state.user.id &&
            (role === 'OWNER' || (u.role !== 'ADMIN' && userFilters.grantable.indexOf(u.role) !== -1));
          const scope = u.role === 'LGA_OFFICER' ? ('LGA #' + (u.lga_id || '—'))
            : (u.role === 'SCHOOL_ADMIN' ? ('School #' + (u.school_id || '—')) : '—');
          return '<tr>' +
            '<td><strong>' + App.esc(u.full_name) + '</strong><br><small>' + App.esc(u.email) + '</small></td>' +
            '<td class="nowrap">' + App.esc(u.mail_address || '—') +
              (u.phone ? '<br><small>' + App.esc(u.phone) + '</small>' : '') + '</td>' +
            '<td><span class="badge ' + (ROLE_BADGE[u.role] || 'muted') + '">' +
              App.esc(ROLE_LABEL[u.role] || u.role) + '</span></td>' +
            '<td class="nowrap">' + App.esc(scope) + '</td>' +
            '<td><span class="badge ' + (u.status === 'ACTIVE' ? 'ok' : 'danger') + '">' +
              App.esc(u.status) + '</span></td>' +
            '<td class="nowrap">' + App.esc(u.last_login_at ? App.fmtDate(u.last_login_at, true) : 'Never') + '</td>' +
            '<td class="actions">' +
              (canEdit
                ? '<button class="btn btn-sm btn-outline" data-us-role="' + u.id + '">Edit</button> ' : '') +
              '<button class="btn btn-sm btn-ghost" data-us-tok="' + u.id + '">Reset password</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      App.qsa('[data-us-role]', host).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = Number(b.getAttribute('data-us-role'));
          roleEditor(d.users.find(function (x) { return x.id === id; }) || null);
        });
      });
      App.qsa('[data-us-tok]', host).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = b.getAttribute('data-us-tok');
          App.busy(b, function () {
            return App.api('/api/staff/users/' + id + '/reset-token', { method: 'POST', body: {} });
          }).then(function (res) {
            const box = App.openModal(
              '<h3>Password reset token</h3>' +
              '<p>Hand this to the account holder directly — it is shown only once.</p>' +
              '<div class="token-box">' + App.esc(res.reset_token) + '</div>' +
              '<div class="copy-row">' +
                '<button class="btn btn-sm" type="button" id="u-copy">Copy token</button>' +
                '<a class="btn btn-sm btn-outline" href="/reset-password.html?token=' +
                  encodeURIComponent(res.reset_token) + '">Open reset page</a></div>' +
              '<p class="kv-note mt-2">Expires ' + App.esc(App.fmtDate(res.reset_expires, true)) + '</p>' +
              '<div class="modal-actions"><button class="btn" type="button" id="u-done">Done</button></div>');
            App.on(box.querySelector('#u-copy'), 'click', function () { copyText(res.reset_token, 'Token'); });
            App.on(box.querySelector('#u-done'), 'click', App.closeModal);
          }).catch(function (e) { App.toast(e.message, 'err'); });
        });
      });
    }).catch(failed);
  }
  /* Load the LGA and school pickers used by the scoped roles. */
  function scopePickers() {
    return Promise.all([
      App.api('/api/schools/lgas').catch(function () { return { lgas: [] }; }),
      App.api('/api/schools?limit=100').catch(function () { return { schools: [] }; })
    ]);
  }

  function scopeFieldsHTML(prefix, opts) {
    const o = opts || {};
    const lgaSel = '<div class="field uf-lga"><label for="' + prefix + '-lga">LGA</label>' +
      '<select id="' + prefix + '-lga"><option value="">Select…</option>' +
      (o.lgas || []).map(function (l) {
        return '<option value="' + l.id + '"' +
          ((o.lga_id && Number(o.lga_id) === l.id) ? ' selected' : '') + '>' +
          App.esc(l.name) + '</option>';
      }).join('') + '</select></div>';
    const schSel = '<div class="field uf-school"><label for="' + prefix + '-school">School</label>' +
      '<select id="' + prefix + '-school"><option value="">Select…</option>' +
      (o.schools || []).map(function (s) {
        return '<option value="' + s.id + '"' +
          ((o.school_id && Number(o.school_id) === s.id) ? ' selected' : '') + '>' +
          App.esc(s.name) + ' (' + App.esc(s.lga) + ')</option>';
      }).join('') + '</select></div>';
    return lgaSel + schSel;
  }

  /** Show only the LGA or school picker the chosen role needs. */
  function syncScopeFields(prefix) {
    const roleSel = document.getElementById(prefix + '-role');
    const lgaBox = document.querySelector('.uf-lga');
    const schBox = document.querySelector('.uf-school');
    const r = roleSel ? roleSel.value : '';
    if (lgaBox) lgaBox.style.display = r === 'LGA_OFFICER' ? '' : 'none';
    if (schBox) schBox.style.display = r === 'SCHOOL_ADMIN' ? '' : 'none';
  }

  /* --- create an account ---------------------------------------------------- */
  function createAccountForm() {
    const roles = userFilters.grantable;
    if (!roles.length) { App.toast('You cannot create accounts.', 'err'); return; }

    scopePickers().then(function (both) {
      const box = App.openModal(
        '<h3>Add account</h3>' +
        '<form id="ua-form" class="form"><div class="form-grid">' +
          '<div class="field"><label for="ua-name">Full name</label>' +
            '<input id="ua-name" required></div>' +
          '<div class="field"><label for="ua-email">Email</label>' +
            '<input id="ua-email" type="email" required></div>' +
          '<div class="field"><label for="ua-phone">Phone (optional)</label>' +
            '<input id="ua-phone"></div>' +
          /* Only the roles this administrator may actually hand out. */
          '<div class="field"><label for="ua-role">Role</label><select id="ua-role">' +
            roles.map(function (r) {
              return '<option value="' + r + '">' + App.esc(ROLE_LABEL[r] || r) + '</option>';
            }).join('') +
          '</select></div>' +
          scopeFieldsHTML('ua', { lgas: both[0].lgas, schools: both[1].schools }) +
        '</div>' +
        '<p class="kv-note">A one-time password reset token can be issued for this account ' +
          'straight from the list.</p>' +
        '<p class="form-error" id="ua-err" hidden></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" id="ua-cancel">Cancel</button>' +
          '<button class="btn" type="submit">Create account</button>' +
        '</div></form>');

      App.on(box.querySelector('#ua-cancel'), 'click', App.closeModal);
      App.on(box.querySelector('#ua-role'), 'change', function () { syncScopeFields('ua'); });
      syncScopeFields('ua');

      const form = box.querySelector('#ua-form');
      App.on(form, 'submit', function (ev) {
        ev.preventDefault();
        const err = box.querySelector('#ua-err');
        const lga = box.querySelector('#ua-lga').value;
        const school = box.querySelector('#ua-school').value;
        App.busy(this, function () {
          return App.api('/api/staff/users', {
            method: 'POST',
            body: {
              full_name: box.querySelector('#ua-name').value.trim(),
              email: box.querySelector('#ua-email').value.trim(),
              phone: box.querySelector('#ua-phone').value.trim(),
              role: box.querySelector('#ua-role').value,
              lga_id: lga || null,
              school_id: school || null
            }
          });
        }).then(function (res) {
          App.closeModal();
          App.toast('Account created' + (res.mail_address ? ' — portal address ' + res.mail_address : '') + '.', 'ok');
          renderUserRows();
        }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
      });
    });
  }

  /* --- role / status editor (grant rules applied) ---------------------------- */
  function roleEditor(user) {
    /* Never offer a role this administrator may not hand out, and never offer
     * OWNER (that moves only through the transfer flow). */
    const allowed = userFilters.grantable.slice();
    if (user.role !== 'OWNER' && allowed.indexOf(user.role) === -1) allowed.unshift(user.role);

    scopePickers().then(function (both) {
      const box = App.openModal(
        '<h3>Account settings</h3>' +
        '<p><strong>' + App.esc(user.full_name) + '</strong><br>' +
          '<span class="kv-note">' + App.esc(user.mail_address || user.email) + '</span></p>' +
        '<div class="form-grid">' +
          '<div class="field"><label for="ur-role">Role</label><select id="ur-role">' +
            allowed.map(function (r) {
              return '<option value="' + r + '"' + (user.role === r ? ' selected' : '') + '>' +
                App.esc(ROLE_LABEL[r] || r) + '</option>';
            }).join('') +
          '</select></div>' +
          '<div class="field"><label for="ur-status">Status</label><select id="ur-status">' +
            '<option value="ACTIVE"' + (user.status !== 'SUSPENDED' ? ' selected' : '') + '>Active</option>' +
            '<option value="SUSPENDED"' + (user.status === 'SUSPENDED' ? ' selected' : '') + '>Suspended</option>' +
          '</select></div>' +
          scopeFieldsHTML('ur', {
            lgas: both[0].lgas, schools: both[1].schools,
            lga_id: user.lga_id, school_id: user.school_id
          }) +
        '</div>' +
        '<p class="kv-note">Suspending an account blocks sign-in immediately; the record itself is kept.</p>' +
        '<p class="form-error" id="ur-err" hidden></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" id="ur-cancel">Cancel</button>' +
          '<button class="btn" type="button" id="ur-save">Save</button>' +
        '</div>');

      App.on(box.querySelector('#ur-cancel'), 'click', App.closeModal);
      App.on(box.querySelector('#ur-role'), 'change', function () { syncScopeFields('ur'); });
      syncScopeFields('ur');

      App.on(box.querySelector('#ur-save'), 'click', function () {
        const err = box.querySelector('#ur-err');
        err.hidden = true;
        const lga = box.querySelector('#ur-lga').value;
        const school = box.querySelector('#ur-school').value;
        App.busy(this, function () {
          return App.api('/api/staff/users/' + user.id, {
            method: 'PUT',
            body: {
              role: box.querySelector('#ur-role').value,
              status: box.querySelector('#ur-status').value,
              lga_id: lga || null,
              school_id: school || null
            }
          });
        }).then(function () {
          App.closeModal();
          App.toast('Account updated.', 'ok');
          renderUserRows();
        }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
      });
    });
  }
  /* --------------------------------------------------------------------- *
   * Live chat console                                                      *
   * --------------------------------------------------------------------- */
  let chatOpen = null;

  function loadChats() {
    section('chats', 'Live chat',
      '<div class="filter-bar">' +
        '<div class="field"><label for="ch-state">Staff availability</label>' +
          '<select id="ch-state"><option value="offline">Offline</option>' +
          '<option value="online">Online</option></select></div>' +
        '<div class="field grow"><label for="ch-hours">Working hours</label>' +
          '<input id="ch-hours" type="text" placeholder="Monday - Friday, 8am - 4pm"></div>' +
        '<button class="btn" type="button" id="ch-save-state">Update availability</button>' +
      '</div>' +
      '<div id="ch-meta" class="integ"></div>' +
      '<div class="grid grid-2 mt-2">' +
        '<div><h3>Waiting &amp; live conversations</h3>' +
          '<div id="ch-list"><div class="empty-state"><strong>Loading…</strong></div></div></div>' +
        '<div><h3>Active conversation</h3><div id="ch-thread">' +
          App.emptyState('No conversation selected', 'Pick a conversation from the list.') + '</div></div>' +
      '</div>');

    App.on(document.getElementById('ch-save-state'), 'click', function () {
      App.busy(this, function () {
        return App.api('/api/chat/admin/availability', {
          method: 'POST',
          body: {
            status: document.getElementById('ch-state').value,
            working_hours: document.getElementById('ch-hours').value.trim()
          }
        });
      }).then(function () {
        App.toast('Availability updated.', 'ok');
        renderChatQueue();
      }).catch(function (e) { App.toast(e.message, 'err'); });
    });

    renderChatQueue();
  }

  function renderChatQueue() {
    const host = document.getElementById('ch-list');
    if (!host) return;
    App.api('/api/chat/admin/queue').then(function (d) {
      document.getElementById('ch-state').value = d.admin_status;
      const hours = document.getElementById('ch-hours');
      if (!hours.value) hours.placeholder = App.setting('admin_working_hours', 'not set');

      document.getElementById('ch-meta').innerHTML =
        '<span class="badge ' + (d.admin_status === 'online' ? 'ok' : 'muted') + '">Status: ' +
          App.esc(d.admin_status) + '</span>' +
        '<span class="badge info">' + Number(d.online_admins || 0) + ' admin(s) connected</span>' +
        '<span class="badge ' + (d.open_tickets ? 'warn' : 'muted') + '">' +
          Number(d.open_tickets || 0) + ' open ticket(s)</span>';

      if (!d.sessions.length) {
        host.innerHTML = App.emptyState('Nobody is waiting', 'Live conversations appear here as they arrive.');
        return;
      }
      host.innerHTML = d.sessions.map(function (s) {
        return '<div class="card" style="margin-bottom:12px;cursor:pointer' +
          (chatOpen === s.id ? ';border-color:var(--primary)' : '') + '" data-ch-open="' + s.id + '">' +
          '<div class="card-head"><h3 style="margin:0;font-size:16px">' + App.esc(s.display_name) + '</h3>' +
            '<span class="badge ' + (s.status === 'waiting' ? 'warn' : 'ok') + '">' + App.esc(s.status) + '</span></div>' +
          '<p class="mb-0"><small>' + App.esc((s.last_message || '').slice(0, 140)) + '</small></p>' +
          '<p class="kv-note mb-0">' + Number(s.message_count || 0) + ' message(s) · ' +
            App.esc(App.fmtDate(s.last_message_at || s.created_at, true)) +
            (s.mail_address ? ' · ' + App.esc(s.mail_address) : '') + '</p>' +
        '</div>';
      }).join('');

      App.qsa('[data-ch-open]', host).forEach(function (b) {
        App.on(b, 'click', function () {
          chatOpen = Number(b.getAttribute('data-ch-open'));
          renderChatQueue();
          openChatThread(chatOpen);
        });
      });
      if (chatOpen) openChatThread(chatOpen);
    }).catch(failed);
  }
  /* --- one conversation ----------------------------------------------------- */
  function openChatThread(id) {
    const host = document.getElementById('ch-thread');
    if (!host) return;
    App.api('/api/chat/admin/session/' + id).then(function (d) {
      const s = d.session;
      host.innerHTML =
        '<div class="card">' +
          '<div class="card-head"><h3 style="margin:0;font-size:17px">' + App.esc(s.display_name) + '</h3>' +
            '<span class="badge ' + (s.status === 'waiting' ? 'warn' : 'ok') + '">' + App.esc(s.status) + '</span></div>' +
          '<p class="kv-note">' +
            (d.user ? App.esc(d.user.mail_address || d.user.email) : 'Guest (not signed in)') +
            (d.staff && d.staff.rank ? ' · ' + App.esc(d.staff.rank) : '') +
            (d.staff && d.staff.school_name ? ' · ' + App.esc(d.staff.school_name) : '') +
          '</p>' +
          '<div class="chat-msgs" id="ch-msgs" style="max-height:340px;overflow:auto">' +
            d.messages.map(function (m) {
              return '<div class="chat-msg ' + App.esc(m.role) + '">' + App.esc(m.body) +
                '<div class="kv-note mt-0">' + App.esc(App.fmtDate(m.created_at, true)) + '</div></div>';
            }).join('') +
          '</div>' +
          '<div class="field mt-2"><label for="ch-reply">Reply</label>' +
            '<textarea id="ch-reply" rows="3" maxlength="2000" placeholder="Type your reply…"></textarea></div>' +
          '<div class="form-actions">' +
            '<button class="btn btn-sm" type="button" id="ch-assign">Join</button>' +
            '<button class="btn btn-sm" type="button" id="ch-send">Send reply</button>' +
            '<button class="btn btn-sm btn-danger" type="button" id="ch-close">Close chat</button>' +
          '</div>' +
        '</div>';

      const box = document.getElementById('ch-msgs');
      if (box) box.scrollTop = box.scrollHeight;

      App.on(document.getElementById('ch-assign'), 'click', function () {
        App.busy(this, function () {
          return App.api('/api/chat/admin/session/' + id + '/assign', { method: 'POST', body: {} });
        }).then(function () {
          App.toast('You have joined the conversation.', 'ok');
          openChatThread(id);
          renderChatQueue();
        }).catch(function (e) { App.toast(e.message, 'err'); });
      });

      App.on(document.getElementById('ch-send'), 'click', function () {
        const ta = document.getElementById('ch-reply');
        const text = ta.value.trim();
        if (!text) { App.toast('Type your reply first.', 'err'); return; }
        App.busy(this, function () {
          return App.api('/api/chat/admin/session/' + id + '/reply', {
            method: 'POST', body: { text: text }
          });
        }).then(function () { ta.value = ''; openChatThread(id); })
          .catch(function (e) { App.toast(e.message, 'err'); });
      });

      App.on(document.getElementById('ch-close'), 'click', function () {
        confirmDialog('Close conversation', 'The visitor is told the chat has been closed.', 'Close chat')
          .then(function (ok) {
            if (!ok) return;
            App.busy(this, function () {
              return App.api('/api/chat/admin/session/' + id + '/close', { method: 'POST', body: {} });
            }).then(function () {
              App.toast('Conversation closed.', 'ok');
              chatOpen = null;
              renderChatQueue();
              const t = document.getElementById('ch-thread');
              if (t) t.innerHTML = App.emptyState('No conversation selected', 'Pick a conversation from the list.');
            }).catch(function (e) { App.toast(e.message, 'err'); });
          });
      });
    }).catch(failed);
  }
  /* --------------------------------------------------------------------- *
   * Bulk SMS — preview, confirm, templates and history                      *
   * --------------------------------------------------------------------- */
  const smsDraft = { type: 'all', lga: '', school_id: '', rank: '', phones: '' };

  function loadSms() {
    section('sms', 'Bulk SMS',
      '<div id="sms-status" class="integ"></div>' +
      '<div class="form-grid mt-2">' +
        '<div class="field"><label for="sm-type">Audience</label><select id="sm-type">' +
          '<option value="all">Everyone approved</option><option value="lga">One LGA</option>' +
          '<option value="school">One school</option><option value="rank">One rank</option>' +
          '<option value="custom">Custom numbers</option></select></div>' +
        '<div class="field"><label for="sm-lga">LGA</label><select id="sm-lga"><option value="">Select…</option></select></div>' +
        '<div class="field"><label for="sm-school">School</label>' +
          '<select id="sm-school"><option value="">Select…</option></select></div>' +
        '<div class="field"><label for="sm-rank">Rank</label><select id="sm-rank"><option value="">Select…</option></select></div>' +
        '<div class="field span-2"><label for="sm-phones">Custom numbers (comma, space or newline separated)</label>' +
          '<textarea id="sm-phones" rows="2" placeholder="08012345678, 08098765432"></textarea></div>' +
        '<div class="field span-2"><label for="sm-msg">Message *</label>' +
          '<textarea id="sm-msg" rows="4" maxlength="1000" placeholder="Dear {{rank}}, …"></textarea>' +
          '<p class="kv-note mt-0" id="sm-count">0 characters</p></div>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn" type="button" id="sm-preview">Preview recipients</button>' +
        '<button class="btn btn-outline" type="button" id="sm-tpl">Templates…</button>' +
      '</div>' +
      '<div id="sm-out"></div>' +
      '<hr class="divider"><h3>Send history</h3>' +
      '<div id="sm-logs"><div class="empty-state"><strong>Loading…</strong></div></div>');

    /* Banner target: filled by /api/sms/status. */
    document.getElementById('sms-warn') || function () {
      const n = document.createElement('div');
      n.id = 'sms-warn';
      n.className = 'placeholder-note hidden mb-2';
      n.setAttribute('role', 'status');
      const st = document.getElementById('sms-status');
      if (st && st.parentNode) st.parentNode.insertBefore(n, st.nextSibling);
    }();

    wireSms();
    App.api('/api/sms/status').then(function (d) {
      const p = d.provider;
      document.getElementById('sms-status').innerHTML =
        '<span class="badge ' + (p.dryRun ? 'warn' : 'ok') + '">Provider: ' + App.esc(p.provider) +
          (p.dryRun ? ' — DRY RUN, nothing is actually sent' : ' — live') + '</span>' +
        '<span class="badge info">Max length: ' + Number(d.max_length) + ' characters</span>' +
        '<span class="badge info">Batch size: ' + Number(d.batch_size || 100) + ' per request</span>';
      smsDraft.maxLength = d.max_length;
      document.getElementById('sm-rank').innerHTML = '<option value="">Select…</option>' +
        d.ranks.map(function (r) { return '<option value="' + App.esc(r) + '">' + App.esc(r) + '</option>'; }).join('');

      /* Always-visible banner: an unimplemented provider or dry-run must be
       * obvious before anyone composes a message. */
      const host = document.getElementById('sms-warn');
      if (host && d.warning) {
        host.classList.remove('hidden');
        host.innerHTML = '<strong>' + App.esc(d.warning) + '</strong>' +
          (p.implemented === false
            ? ''
            : ' Every batch is previewed and logged but never delivered. Set TERMII_API_KEY and ' +
              'SMS_DRY_RUN=0 on the server to send for real.');
      } else if (host) {
        host.classList.add('hidden');
      }
    }).catch(function () { /* the form still works */ });

    Promise.all([
      App.api('/api/schools/lgas').catch(function () { return { lgas: [] }; }),
      App.api('/api/schools?limit=100').catch(function () { return { schools: [] }; })
    ]).then(function (both) {
      const lgaSel = document.getElementById('sm-lga');
      lgaSel.innerHTML = '<option value="">Select…</option>' + both[0].lgas.map(function (l) {
        return '<option value="' + App.esc(l.name) + '">' + App.esc(l.name) + '</option>';
      }).join('');
      const scSel = document.getElementById('sm-school');
      scSel.innerHTML = '<option value="">Select…</option>' + both[1].schools.map(function (s) {
        return '<option value="' + s.id + '">' + App.esc(s.name) + '</option>';
      }).join('');
    });

    renderSmsLogs();
  }

  function audienceFromForm() {
    const type = document.getElementById('sm-type').value;
    const spec = { type: type };
    if (type === 'lga') spec.lga = document.getElementById('sm-lga').value;
    if (type === 'school') spec.school_id = document.getElementById('sm-school').value;
    if (type === 'rank') spec.rank = document.getElementById('sm-rank').value;
    if (type === 'custom') spec.phones = document.getElementById('sm-phones').value;
    return spec;
  }
  /* --- compose: character counter, audience gating, preview ----------------- */
  function wireSms() {
    const msg = document.getElementById('sm-msg');
    const counter = document.getElementById('sm-count');
    const max = smsDraft.maxLength || 480;

    /* Mirror the server's segment maths so the admin sees the cost before
     * sending: 160/153 for GSM-7, 70/67 for anything else. */
    const segmentsFor = function (text) {
      if (!text.length) return 0;
      let gsm = true;
      for (const ch of text) { if (ch.codePointAt(0) > 127) { gsm = false; break; } }
      const single = gsm ? 160 : 70;
      const multi = gsm ? 153 : 67;
      return text.length <= single ? 1 : Math.ceil(text.length / multi);
    };
    const countChars = function () {
      const n = msg.value.length;
      const segs = segmentsFor(msg.value);
      counter.textContent = n + ' character' + (n === 1 ? '' : 's') +
        (n > max ? ' — OVER THE LIMIT by ' + (n - max) : ' of ' + max) +
        '  ·  ' + segs + ' SMS part' + (segs === 1 ? '' : 's');
      counter.style.color = n > max ? 'var(--danger)' : '';
    };
    App.on(msg, 'input', countChars);
    countChars();

    /* Only reveal the inputs that matter for the chosen audience. */
    const toggle = function () {
      const type = document.getElementById('sm-type').value;
      document.getElementById('sm-lga').disabled = type !== 'lga';
      document.getElementById('sm-school').disabled = type !== 'school';
      document.getElementById('sm-rank').disabled = type !== 'rank';
      document.getElementById('sm-phones').disabled = type !== 'custom';
    };
    App.on(document.getElementById('sm-type'), 'change', toggle);
    toggle();

    App.on(document.getElementById('sm-preview'), 'click', function () {
      const message = msg.value.trim();
      if (!message) { App.toast('Write the message first.', 'err'); return; }
      App.busy(this, function () {
        const tplSel = document.getElementById('sm-tplsel');
        return App.api('/api/sms/preview', {
          method: 'POST',
          body: {
            audience: audienceFromForm(),
            message: message,
            template_id: tplSel && tplSel.value ? Number(tplSel.value) : null
          }
        });
      }).then(function (d) {
        showSmsPreview(d);
      }).catch(function (e) { App.toast(e.message, 'err'); });
    });

    App.on(document.getElementById('sm-tpl'), 'click', templateDialog);
  }

  function showSmsPreview(d) {
    const out = document.getElementById('sm-out');
    const count = Number(d.recipient_count || 0);

    const list = (d.sample || []).map(function (r) {
      return '<div class="r"><span class="k" style="flex:1;text-align:left">' + App.esc(r.name) +
        (r.rank ? ' <small>(' + App.esc(r.rank) + ')</small>' : '') + '</span>' +
        '<span class="v nowrap">' + App.esc(r.phone) + '</span></div>';
    }).join('');

    const invalid = (d.invalid || []).length
      ? '<p class="form-error">' + Number(d.invalid_count) +
        ' number(s) look unusable and were left out.</p>'
      : '';

    /* A loud, always-visible banner whenever nothing can really be sent. */
    const banner = (d.provider && d.provider.implemented === false)
      ? '<div class="placeholder-note mb-2"><strong>' +
        App.esc('Provider not implemented yet; use Termii.') + '</strong></div>'
      : (d.provider && d.provider.dryRun
        ? '<div class="placeholder-note mb-2"><strong>DRY-RUN: no messages are really sent.</strong> ' +
          'Set TERMII_API_KEY and SMS_DRY_RUN=0 on the server to send for real.</div>'
        : '');

    out.innerHTML =
      '<div class="card mt-2"><div class="card-head"><h3>Preview</h3>' +
        '<span class="badge ' + (count ? 'info' : 'danger') + '">' + count + ' recipient(s)</span></div>' +
        banner +
        '<p class="mb-0"><strong>' + Number(d.characters) + ' characters, ' +
        Number(d.segments) + ' SMS part(s)</strong> (encoding: ' + App.esc(d.encoding || 'GSM-7') + ')' +
        (d.template ? ' · template: ' + App.esc(d.template.name) : '') + '</p>' +
        (d.too_long ? '<p class="form-error">The message is longer than the provider allows.</p>' : '') +
        invalid +
        '<div class="token-box">' + App.esc(d.preview_text || '') + '</div>' +
        (list ? '<div class="pre-scroll detail-list mt-2">' + list + '</div>' : '') +
        '<div class="form-actions">' +
          '<button class="btn btn-danger" type="button" id="sm-send"' + (count ? '' : ' disabled') + '>' +
            (d.provider && d.provider.dryRun ? 'Log dry-run batch' : 'Send to ' + count + ' recipient(s)') +
          '</button>' +
        '</div>' +
        '<p class="kv-note mb-0">Nothing is sent until you press the button above. The recipient list is ' +
        'fixed now and expires in ' + Number(d.expires_in_minutes || 10) + ' minutes.</p>' +
      '</div>';

    App.on(document.getElementById('sm-send'), 'click', function () {
      confirmDialog('Send this SMS',
        'Send to ' + count + ' recipient(s) (' + Number(d.segments) + ' SMS part(s) each)? Continue?',
        'Send now')
        .then(function (ok) {
          if (!ok) return;
          App.busy(this, function () {
            /* Only the token: the server sends exactly what was previewed. */
            return App.api('/api/sms/send', {
              method: 'POST', body: { confirm_token: d.confirm_token }
            });
          }).then(function (res) {
            out.innerHTML = '<div class="placeholder-note mt-2">' + App.esc(res.note) +
              ' (' + Number(res.sent) + ' sent, ' + Number(res.failed) + ' failed, ' +
              Number(res.batches) + ' batch(es).)</div>';
            App.toast(res.dry_run ? 'Dry-run batch logged.' : 'SMS batch sent.', 'ok');
            renderSmsLogs();
          }).catch(function (e) { App.toast(e.message, 'err'); });
        });
    });
  }

  /* --- send history -------------------------------------------------------- */
  function renderSmsLogs() {
    const host = document.getElementById('sm-logs');
    if (!host) return;
    App.api('/api/sms/logs?limit=25').then(function (d) {
      if (!d.logs.length) {
        host.innerHTML = App.emptyState('No batches sent yet', 'Every send is logged here with its result.');
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>When</th><th>Audience</th><th>Recipients</th><th>Status</th><th>Sent by</th><th>Message</th>' +
        '</tr></thead><tbody>' +
        d.logs.map(function (l) {
          const cls = l.status === 'success' ? 'ok' : (l.status === 'partial' ? 'warn' : 'danger');
          return '<tr>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(l.created_at, true)) + '</td>' +
            '<td>' + App.esc(l.audience) + '</td>' +
            '<td>' + Number(l.recipients_count) + '</td>' +
            '<td><span class="badge ' + cls + '">' + App.esc(l.status) +
              (l.dry_run ? ' (dry)' : '') + '</span></td>' +
            '<td>' + App.esc(l.sent_by_name || '') + '</td>' +
            '<td><small>' + App.esc((l.message || '').slice(0, 90)) + '</small></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }).catch(failed);
  }
  /* --- reusable message templates ------------------------------------------ */
  function templateDialog() {
    const box = App.openModal(
      '<h3>SMS templates</h3>' +
      '<div id="tpl-list"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div class="field mt-2"><label for="tpl-name">Template name</label>' +
        '<input id="tpl-name" maxlength="80"></div>' +
      '<div class="field"><label for="tpl-body">Message body</label>' +
        '<textarea id="tpl-body" rows="4" maxlength="1000"></textarea>' +
        '<p class="kv-note mt-0">Placeholders: {{name}} {{rank}} {{school}} {{date}} {{time}} {{venue}}</p></div>' +
      '<p class="form-error" id="tpl-err" hidden></p>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" id="tpl-cancel">Close</button>' +
        '<button class="btn" type="button" id="tpl-save">Save template</button>' +
      '</div>', { wide: true });

    const list = box.querySelector('#tpl-list');
    App.api('/api/sms/templates').then(function (d) {
      if (!d.templates.length) {
        list.innerHTML = App.emptyState('No templates yet', 'Save one to reuse it for every broadcast.');
        return;
      }
      list.innerHTML = d.templates.map(function (t) {
        return '<div class="card" style="margin-bottom:10px">' +
          '<div class="card-head"><h3 style="margin:0;font-size:16px">' + App.esc(t.name) + '</h3>' +
            '<button class="btn btn-sm btn-danger" data-tpl-del="' + t.id + '">Delete</button></div>' +
          '<p class="mb-0"><small>' + App.esc(t.body) + '</small></p>' +
          '<div class="form-actions">' +
            '<button class="btn btn-sm btn-outline" data-tpl-use="' + App.esc(t.body) + '">Use this</button>' +
            '<button class="btn btn-sm" data-tpl-edit="' + t.id + '" data-name="' + App.esc(t.name) +
              '" data-body="' + App.esc(t.body) + '">Edit</button>' +
          '</div>' +
        '</div>';
      }).join('');

      App.qsa('[data-tpl-use]', list).forEach(function (b) {
        App.on(b, 'click', function () {
          const ta = document.getElementById('sm-msg');
          if (ta) { ta.value = this.getAttribute('data-tpl-use'); ta.dispatchEvent(new Event('input')); }
          App.closeModal();
        });
      });
      App.qsa('[data-tpl-edit]', list).forEach(function (b) {
        App.on(b, 'click', function () {
          box.querySelector('#tpl-name').value = this.getAttribute('data-name');
          box.querySelector('#tpl-body').value = this.getAttribute('data-body');
          box.querySelector('#tpl-save').setAttribute('data-edit', this.getAttribute('data-tpl-edit'));
          box.querySelector('#tpl-save').textContent = 'Update template';
        });
      });
      App.qsa('[data-tpl-del]', list).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = this.getAttribute('data-tpl-del');
          confirmDialog('Delete template', 'This message template is removed.', 'Delete')
            .then(function (ok) {
              if (!ok) return;
              App.api('/api/sms/templates/' + id, { method: 'DELETE' })
                .then(function () { App.closeModal(); templateDialog(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(function (e) { list.innerHTML = App.emptyState('Could not load templates', e.message); });

    App.on(box.querySelector('#tpl-cancel'), 'click', App.closeModal);
    App.on(box.querySelector('#tpl-save'), 'click', function () {
      const err = box.querySelector('#tpl-err');
      err.hidden = true;
      const name = box.querySelector('#tpl-name').value.trim();
      const body = box.querySelector('#tpl-body').value.trim();
      if (!name || !body) {
        err.hidden = false;
        err.textContent = 'A template needs both a name and a message body.';
        return;
      }
      const id = this.getAttribute('data-edit');
      App.busy(this, function () {
        return App.api(id ? '/api/sms/templates/' + id : '/api/sms/templates',
          { method: id ? 'PUT' : 'POST', body: { name: name, body: body } });
      }).then(function () {
        App.closeModal();
        App.toast('Template saved.', 'ok');
        templateDialog();
      }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
    });
  }
  /* --------------------------------------------------------------------- *
   * Site settings — every string on the portal is edited here             *
   * --------------------------------------------------------------------- */
  /* Labels and input types for each editable key. Anything not listed here
   * is still editable, it just gets a generic text box. */
  const SETTING_META = {
    ministry_name: ['Ministry name', 'text'],
    ministry_short_name: ['Short name (used in the header)', 'text'],
    site_tagline: ['Tagline', 'text'],
    logo: ['Logo URL', 'text'],
    governor_photo: ['Governor photograph URL', 'text'],
      commissioner_photo: ['Commissioner photograph URL', 'text'],
      commissioner_name: ['Commissioner name', 'text'],
      commissioner_title: ['Commissioner title', 'text'],
      commissioner_message: ['Message from the Commissioner', 'area'],
    primary_color: ['Primary colour', 'color'],
    secondary_color: ['Secondary colour', 'color'],
    accent_color: ['Accent colour', 'color'],
    hero_heading: ['Home page heading', 'text'],
    hero_subheading: ['Home page welcome message', 'area'],
    hero_image: ['Home page image URL', 'text'],
    free_education_banner_title: ['Free education banner — title', 'text'],
    free_education_banner_text: ['Free education banner — text', 'area'],
    girl_child_banner_title: ['Girl-child banner — title', 'text'],
    girl_child_banner_text: ['Girl-child banner — text', 'area'],
    governor_name: ['Governor name', 'text'],
    governor_title: ['Governor title', 'text'],
    governor_vision_free_education: ['Vision — free education', 'area'],
    governor_vision_girl_child: ['Vision — girl-child', 'area'],
    governor_vision_note: ['Note shown under the visions', 'area'],
    about_history: ['About — history', 'area'],
    about_functions: ['About — statutory functions (one per line)', 'area'],
    about_departments: ['About — departments (one per line)', 'area'],
    about_leadership: ['About — leadership (one per line)', 'area'],
    mission: ['Mission statement', 'area'],
    vision: ['Vision statement', 'area'],
    contact_address: ['Contact address', 'text'],
    contact_phone: ['Contact phone', 'text'],
    contact_email: ['Contact email', 'text'],
    contact_map_link: ['Map link', 'text'],
    office_hours: ['Office hours', 'text'],
    footer_credit_text: ['Footer credit text', 'text'],
    footer_credit_link: ['Footer credit link', 'text'],
    sms_sender_id: ['SMS sender ID', 'text'],
    sms_footer: ['SMS footer', 'text'],
    admin_working_hours: ['Chat working hours', 'text'],
    privacy_notice: ['Privacy notice', 'area'],
    faq_notice: ['FAQ / assistant notice', 'area']
  };
  const TOGGLES = {
    public_bot_enabled: ['Public chat assistant', 'Turn the AI assistant off during office hours.'],
    registration_open: ['Staff registration', 'Turn off to stop new registrations.']
  };

  const SETTING_GROUPS = [
    ['Identity & branding', ['ministry_name', 'ministry_short_name', 'site_tagline', 'logo',
      'governor_photo', 'primary_color', 'secondary_color', 'accent_color']],
    ['Home page', ['hero_heading', 'hero_subheading', 'hero_image',
      'free_education_banner_title', 'free_education_banner_text', 'free_education_banner_image',
      'girl_child_banner_title', 'girl_child_banner_text', 'girl_child_banner_image']],
    ['Ministry photographs', ['commissioner_photo', 'commissioner_name', 'commissioner_title',
      'commissioner_message', 'default_news_cover', 'about_gallery_image_1', 'about_gallery_image_2']],
    ['Leadership', ['governor_name', 'governor_title', 'governor_vision_free_education',
      'governor_vision_girl_child', 'governor_vision_note']],
    ['About the ministry', ['about_history', 'about_functions', 'about_departments',
      'about_leadership', 'mission', 'vision']],
    ['Contact & footer', ['contact_address', 'contact_phone', 'contact_email',
      'contact_map_link', 'office_hours', 'footer_credit_text', 'footer_credit_link']],
    ['SMS, chat & registration', ['sms_sender_id', 'sms_footer', 'admin_working_hours',
      'privacy_notice', 'faq_notice']]
  ];
  function loadSettings() {
    section('settings', 'Site settings',
      '<div class="placeholder-note">Nothing on this portal is hardcoded — every heading, contact detail ' +
      'and paragraph comes from these values. Text still showing a <strong>[PLACEHOLDER]</strong> marker ' +
      'has not been written yet.</div>' +
      '<form id="set-form"><div id="set-body"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div class="form-actions"><button class="btn" type="submit">Save all settings</button></div></form>');

    document.getElementById('set-form').addEventListener('submit', function (e) {
      e.preventDefault();
      saveSettings(this.querySelector('button[type="submit"]'));
    });

    App.api('/api/settings').then(function (d) {
      const s = d.settings;
      const keys = d.editable_keys || Object.keys(s);
      const host = document.getElementById('set-body');
      host.innerHTML = SETTING_GROUPS.map(function (g) {
        const mine = g[1].filter(function (k) { return keys.indexOf(k) !== -1; });
        if (!mine.length) return '';
        return '<h3>' + App.esc(g[0]) + '</h3><div class="form-grid">' +
          mine.map(function (k) { return settingField(k, s); }).join('') + '</div><hr class="divider">';
      }).join('') +
        '<h3>Switches</h3>' +
        Object.keys(TOGGLES).filter(function (k) { return keys.indexOf(k) !== -1; }).map(function (k) {
          const on = s[k] === '1' || s[k] === 1 || s[k] === 'true';
          return '<div class="field span-2"><label class="check"><input type="checkbox" id="s-' + k + '"' +
            (on ? ' checked' : '') + '> ' + App.esc(TOGGLES[k][0]) + '</label>' +
            '<p class="kv-note mt-0">' + App.esc(TOGGLES[k][1]) + '</p></div>';
        }).join('') +
        '<hr class="divider">' +
        uploadSlot('logo', 'Upload a logo') +
        uploadSlot('hero_image', 'Upload a home page image') +
        uploadSlot('governor_photo', 'Upload the governor photograph') +
        '<div id="set-integ" class="integ"></div>';

      renderIntegrations(d);
      applySenderIdLock(d.sms_sender_id);
    }).catch(failed);
  }

  /* The SMS sender ID must match what Termii approved.  When the server sets
   * it (TERMII_SENDER_ID), show the field read-only so a typo here cannot
   * silently break every outgoing message. */
  function applySenderIdLock(info) {
    if (!info || info.editable !== false) return;
    const input = document.getElementById('s-sms_sender_id');
    if (input) {
      input.readOnly = true;
      input.setAttribute('aria-readonly', 'true');
      input.value = info.value || '';
      input.style.opacity = '.7';
      input.style.cursor = 'not-allowed';
    }
    const label = document.querySelector('label[for="s-sms_sender_id"]');
    if (label) label.textContent = label.textContent + ' — set by the server';
    const field = input && input.closest ? input.closest('.field') : null;
    if (field && !field.querySelector('.kv-note')) {
      const p = document.createElement('p');
      p.className = 'kv-note mt-0';
      p.textContent = info.note || 'Set by the server.';
      field.appendChild(p);
    }
  }

  /* One labelled input for a setting key. */
  function settingField(key, s) {
    const meta = SETTING_META[key];
    const label = meta ? meta[0] : App.labelise(key);
    const kind = meta ? meta[1] : 'text';
    const val = s[key] === undefined || s[key] === null ? '' : String(s[key]);
    const ph = /\[PLACEHOLDER/.test(val) ? 'Not written yet' : '';

    if (kind === 'area') {
      return '<div class="field span-2"><label for="s-' + key + '">' + App.esc(label) + '</label>' +
        '<textarea id="s-' + key + '" rows="3" placeholder="' + App.esc(ph) + '">' + App.esc(val) + '</textarea></div>';
    }
    if (kind === 'color') {
      return '<div class="field"><label for="s-' + key + '">' + App.esc(label) + '</label>' +
        '<input id="s-' + key + '" type="color" value="' + App.esc(val || '#000000') + '">' +
        '<p class="kv-note mt-0">' + App.esc(val) + '</p></div>';
    }
    return '<div class="field span-2"><label for="s-' + key + '">' + App.esc(label) + '</label>' +
      '<input id="s-' + key + '" type="text" value="' + App.esc(val) + '" placeholder="' +
      App.esc(ph) + '"></div>';
  }

  function uploadSlot(key, label) {
    return '<div class="field span-2"><label for="up-' + key + '">' + App.esc(label) + '</label>' +
      '<input id="up-' + key + '" type="file" accept="image/*">' +
      '<p class="kv-note mt-0">Uploading fills in the <code>' + App.esc(key) + '</code> field above.</p></div>';
  }

  function renderIntegrations(d) {
    const host = document.getElementById('set-integ');
    if (!host) return;
    host.innerHTML =
      '<span class="badge ' + (d.mail.external ? 'ok' : 'info') + '">Mail: ' + App.esc(d.mail.adapter) +
        (d.mail.external ? '' : ' (portal only)') + '</span>' +
      '<span class="badge ' + (d.sms.dryRun ? 'warn' : 'ok') + '">SMS: ' + App.esc(d.sms.provider) +
        (d.sms.dryRun ? ' (dry-run)' : ' (live)') + '</span>' +
      '<span class="badge ' + (d.ai.configured ? 'ok' : 'muted') + '">AI: ' + App.esc(d.ai.model) + '</span>';
  }
  /* --- save: uploads first (they return the URL to store), then the values -- */
  function saveSettings(btn) {
    const host = document.getElementById('set-body');
    const pending = App.qsa('[id^="up-"]', host).map(function (input) {
      const file = input.files[0];
      if (!file) return Promise.resolve(null);
      const key = input.id.slice(3);
      const fd = new FormData();
      fd.append('file', file);
      return App.apiForm('/api/settings/upload', fd).then(function (res) {
        const target = document.getElementById('s-' + key);
        if (target) target.value = res.url;
        return key;
      });
    });

    App.busy(btn, function () {
      return Promise.all(pending);
    }).then(function () {
      /* Collect every editable field that is actually on the page. */
      const body = {};
      App.qsa('#set-body [id^="s-"]').forEach(function (el) {
        const key = el.id.slice(2);
        if (el.type === 'checkbox') body[key] = el.checked ? '1' : '0';
        else body[key] = el.value;
      });
      return App.api('/api/settings', { method: 'PUT', body: body });
    }).then(function (res) {
      const extra = (res.rejected || []).length
        ? ' Ignored: ' + res.rejected.join(', ') + '.'
        : '';
      App.toast('Saved ' + res.updated.length + ' setting(s).' + extra, 'ok');
      /* Colours are applied client-side, so refresh them without a reload. */
      return App.api('/api/auth/me').then(function (me) {
        App.state.settings = me.settings || {};
        App.api('/api/settings/public').then(function (p) {
          App.state.settings = p.settings || {};
        }).catch(function () { /* keep what we have */ });
      }).catch(function () { /* the values are saved regardless */ });
    }).catch(function (e) { App.toast(e.message, 'err'); });
  }

  /* --------------------------------------------------------------------- *
   * Audit log (OWNER only)                                                  *
   * --------------------------------------------------------------------- */
  const auditFilters = { q: '', action: '', page: 1 };

  function loadAudit() {
    section('audit', 'Audit log',
      '<div class="filter-bar">' +
        '<div class="field grow"><label for="au-q">Search</label>' +
          '<input type="search" id="au-q" placeholder="Person, action or details…"></div>' +
        '<div class="field"><label for="au-action">Action contains</label>' +
          '<input type="search" id="au-action" placeholder="e.g. staff"></div>' +
      '</div>' +
      '<div id="au-rows"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div id="au-pager"></div>');

    App.on(document.getElementById('au-q'), 'input', App.debounce(function () {
      auditFilters.q = document.getElementById('au-q').value.trim();
      auditFilters.page = 1;
      renderAuditRows();
    }, 300));
    App.on(document.getElementById('au-action'), 'input', App.debounce(function () {
      auditFilters.action = document.getElementById('au-action').value.trim();
      auditFilters.page = 1;
      renderAuditRows();
    }, 300));
    renderAuditRows();
  }

  function renderAuditRows() {
    const host = document.getElementById('au-rows');
    if (!host) return;
    host.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const parts = ['page=' + auditFilters.page, 'limit=50'];
    if (auditFilters.q) parts.push('q=' + encodeURIComponent(auditFilters.q));
    if (auditFilters.action) parts.push('action=' + encodeURIComponent(auditFilters.action));

    App.api('/api/admin/audit?' + parts.join('&')).then(function (d) {
      if (!d.entries.length) {
        host.innerHTML = App.emptyState('Nothing logged', 'Every administrative action is recorded here.');
        document.getElementById('au-pager').innerHTML = '';
        return;
      }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th>' +
        '</tr></thead><tbody>' +
        d.entries.map(function (a) {
          let details = a.details;
          try {
            const parsed = JSON.parse(details);
            details = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
          } catch (e) { /* keep the raw text */ }
          return '<tr>' +
            '<td class="nowrap">' + App.esc(App.fmtDate(a.created_at, true)) + '</td>' +
            '<td><strong>' + App.esc(a.user_name || '—') + '</strong><br>' +
              '<small>' + App.esc(a.role || '') + '</small></td>' +
            '<td><code>' + App.esc(a.action) + '</code></td>' +
            '<td class="nowrap">' + App.esc(a.entity || '') +
              (a.entity_id ? ' #' + App.esc(a.entity_id) : '') + '</td>' +
            '<td><small>' + App.esc(String(details || '').slice(0, 160)) + '</small></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';

      document.getElementById('au-pager').innerHTML = App.pager(d.page, d.pages, 'data-aupage');
      App.qsa('#au-pager button[data-aupage]').forEach(function (b) {
        App.on(b, 'click', function () {
          auditFilters.page = Number(b.getAttribute('data-aupage')) || 1;
          renderAuditRows();
        });
      });
    }).catch(failed);
  }
  /* --------------------------------------------------------------------- *
   * Backup, restore and transfer of ownership (OWNER only)                *
   * --------------------------------------------------------------------- */
  function loadBackup() {
    section('backup', 'Backup & ownership',
      '<div class="card"><h3>Download a backup</h3>' +
        '<p class="kv-note">The archive contains the whole database and every uploaded file ' +
        '(photos and circulars). Keep it somewhere safe.</p>' +
        '<button class="btn" type="button" id="bk-dl">Download backup (.zip)</button>' +
      '</div>' +

      '<div class="card mt-2"><h3>Restore a backup</h3>' +
        '<div class="placeholder-note">This REPLACES the live database with the contents of the ' +
        'archive. A safety copy of the current database is kept on disk first, but people using the ' +
        'portal right now will be signed out.</div>' +
        '<div class="field"><label for="bk-file">Backup archive</label>' +
          '<input id="bk-file" type="file" accept=".zip,application/zip"></div>' +
        '<div class="field"><label for="bk-pass">Your password (confirmation)</label>' +
          '<input id="bk-pass" type="password" autocomplete="current-password"></div>' +
        '<p class="form-error" id="bk-err" hidden></p>' +
        '<button class="btn btn-danger" type="button" id="bk-restore">Restore from this archive</button>' +
      '</div>' +

      '<div class="card mt-2"><h3>Transfer ownership</h3>' +
        '<p class="kv-note">The new owner receives a one-time link. When they accept it they become the ' +
        'owner and you are demoted to administrator. This cannot be undone.</p>' +
        '<div class="field"><label for="ow-email">New owner’s email address</label>' +
          '<input id="ow-email" type="email" placeholder="name@example.gov.ng"></div>' +
        '<div class="field"><label for="ow-pass">Your password (confirmation)</label>' +
          '<input id="ow-pass" type="password" autocomplete="current-password"></div>' +
        '<p class="form-error" id="ow-err" hidden></p>' +
        '<button class="btn" type="button" id="ow-start">Start transfer</button>' +
        '<div id="ow-pending" class="mt-2"></div>' +
      '</div>');

    wireBackup();
    renderPendingTransfers();
  }
  function wireBackup() {
    App.on(document.getElementById('bk-dl'), 'click', function () {
      App.busy(this, function () { return App.api('/api/admin/backup'); })
        .then(function (res) {
          /* A zip comes back as a blob, not JSON — hand it to the browser. */
          const url = URL.createObjectURL(res);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'taraba-portal-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          App.toast('Backup downloaded.', 'ok');
        }).catch(function (e) { App.toast(e.message, 'err'); });
    });

    App.on(document.getElementById('bk-restore'), 'click', function () {
      const file = document.getElementById('bk-file').files[0];
      const password = document.getElementById('bk-pass').value;
      const err = document.getElementById('bk-err');
      err.hidden = true;
      if (!file || !password) {
        err.hidden = false;
        err.textContent = 'Choose the archive and enter your password.';
        return;
      }
      confirmDialog('Restore this backup',
        'The live database will be replaced by ' + file.name + '. Everyone will be signed out.', 'Restore')
        .then(function (ok) {
          if (!ok) return;
          const fd = new FormData();
          fd.append('file', file);
          fd.append('password', password);
          App.busy(this, function () { return App.apiForm('/api/admin/restore', fd); })
            .then(function (res) {
              App.toast(res.message || 'Backup restored.', 'ok');
              setTimeout(function () { window.location.reload(); }, 1500);
            }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
        });
    });

    App.on(document.getElementById('ow-start'), 'click', function () {
      const email = document.getElementById('ow-email').value.trim();
      const password = document.getElementById('ow-pass').value;
      const err = document.getElementById('ow-err');
      err.hidden = true;
      if (!email || !password) {
        err.hidden = false;
        err.textContent = 'Enter the new owner’s email and your own password.';
        return;
      }
      App.busy(this, function () {
        return App.api('/api/admin/transfer/start', {
          method: 'POST', body: { email: email, password: password }
        });
      }).then(function (res) {
        document.getElementById('ow-pass').value = '';
        const box = App.openModal(
          '<h3>Ownership transfer started</h3>' +
          '<p>' + App.esc(res.note || '') + '</p>' +
          '<div class="token-box">' + App.esc(res.link) + '</div>' +
          '<div class="copy-row">' +
            '<button class="btn btn-sm" type="button" id="ow-copy">Copy link</button>' +
            '<a class="btn btn-sm btn-outline" href="' + App.esc(res.link) + '">Open link</a></div>' +
          '<p class="kv-note mt-2">Expires ' + App.esc(App.fmtDate(res.expires_at, true)) + '</p>' +
          '<div class="modal-actions"><button class="btn" type="button" id="ow-done">Done</button></div>',
          { wide: true });
        App.on(box.querySelector('#ow-copy'), 'click', function () { copyText(res.link, 'Link'); });
        App.on(box.querySelector('#ow-done'), 'click', function () {
          App.closeModal();
          renderPendingTransfers();
        });
        App.toast('Transfer started.', 'ok');
      }).catch(function (e) { err.hidden = false; err.textContent = e.message; });
    });
  }

  function renderPendingTransfers() {
    const host = document.getElementById('ow-pending');
    if (!host) return;
    App.api('/api/admin/transfer/pending').then(function (d) {
      if (!d.pending.length) { host.innerHTML = ''; return; }
      host.innerHTML = '<h3>Pending transfers</h3>' + d.pending.map(function (p) {
        return '<div class="card" style="margin-bottom:10px">' +
          '<div class="card-head"><h3 style="margin:0;font-size:16px">' + App.esc(p.email) + '</h3>' +
            '<button class="btn btn-sm btn-danger" data-ow-cancel="' + p.id + '">Cancel</button></div>' +
          '<p class="kv-note mb-0">Started ' + App.esc(App.fmtDate(p.created_at, true)) +
            ' · expires ' + App.esc(App.fmtDate(p.expires_at, true)) + '</p>' +
        '</div>';
      }).join('');

      App.qsa('[data-ow-cancel]', host).forEach(function (b) {
        App.on(b, 'click', function () {
          const id = this.getAttribute('data-ow-cancel');
          confirmDialog('Cancel transfer',
            'This invalidates the outstanding link — the other person can no longer claim ownership.',
            'Cancel transfer').then(function (ok) {
              if (!ok) return;
              App.api('/api/admin/transfer/cancel', { method: 'POST', body: { id: Number(id) } })
                .then(function () { App.toast('Transfer cancelled.', 'ok'); renderPendingTransfers(); })
                .catch(function (e) { App.toast(e.message, 'err'); });
            });
        });
      });
    }).catch(function () { /* non-critical */ });
  }
  /* --------------------------------------------------------------------- *
   * Router + boot                                                          *
   * --------------------------------------------------------------------- */
  const LOADERS = {
    overview: loadOverview,
    staff: loadStaff,
    schools: loadSchools,
    news: loadNews,
    events: loadEvents,
    circulars: loadCirculars,
    faq: loadFaq,
    users: loadUsers,
    chats: loadChats,
    sms: loadSms,
    settings: loadSettings,
    audit: loadAudit,
    backup: loadBackup
  };

  function route() {
    const id = currentSection();
    chatOpen = null;
    renderNav(id);
    const loader = LOADERS[id] || loadOverview;
    if (id !== 'overview') loading();
    loader();
  }

  App.ready(function (ctx) {
    role = ctx.user.role;
    const sub = document.getElementById('admin-sub');
    if (sub) {
      sub.textContent = 'Signed in as ' + ctx.user.full_name + ' (' + role + '). ' +
        'Manage content, staff, schools and portal settings.';
    }
    App.on(window, 'hashchange', route);
    route();
    refreshPills();
    /* Keep the nav badges fresh while the tab stays open. */
    setInterval(function () {
      if (document.hidden) return;
      refreshPills();
    }, 60000);
  });
})();
