/**
 * public/js/pages/mail.js — internal portal mail.
 *
 * Folders, list, reading pane, composer with the audience picker
 * (people / school / LGA / role / everyone), drafts and attachments.
 */
(function () {
  'use strict';

  const listView = document.getElementById('mail-view');
  let listHost = document.getElementById('mail-list');
  let pagerHost = document.getElementById('mail-pager');
  let folder = 'inbox';
  let page = 1;

  /* ------------------------------ folders ------------------------------- */
  function loadFolders() {
    App.api('/api/mail/folders').then(function (d) {
      document.getElementById('n-inbox').textContent = d.unread ? d.unread + ' new' : (d.inbox || '');
      document.getElementById('n-sent').textContent = d.sent || '';
      document.getElementById('n-drafts').textContent = d.drafts || '';
      document.getElementById('n-trash').textContent = d.trash || '';
      document.getElementById('mail-sub').textContent =
        (d.my_address ? 'You: ' + d.my_address + ' · ' : '') +
        (d.external && d.external.external ? 'SMTP bridge enabled' : 'Internal portal mail only — nothing leaves this server.');
    }).catch(function () { /* counts are decoration */ });
  }

  App.qsa('#folders button').forEach(function (btn) {
    App.on(btn, 'click', function () {
      App.qsa('#folders button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      folder = btn.getAttribute('data-folder');
      page = 1;
      history.replaceState(null, '', '/mail.html#folder-' + folder);
      loadList();
    });
  });

  /* -------------------------------- list --------------------------------- */
  function loadList() {
    listHost.innerHTML = '<div class="empty-state"><strong>Loading…</strong></div>';
    const q = document.getElementById('q').value.trim();
    let url = '/api/mail/list?folder=' + folder + '&page=' + page + '&limit=25';
    if (q) url += '&q=' + encodeURIComponent(q);

    App.api(url).then(function (data) {
      if (!data.messages.length) {
        listHost.innerHTML = App.emptyState(
          folder === 'inbox' ? 'Your inbox is empty' : 'Nothing here',
          folder === 'inbox' ? 'Messages sent to you inside the portal will appear here.' : '');
        pagerHost.innerHTML = '';
        return;
      }
      listHost.innerHTML = data.messages.map(function (m) {
        const unread = folder === 'inbox' && !m.is_read;
        const who = (folder === 'sent' || folder === 'drafts')
          ? (m.recipients || 0) + ' recipient' + (m.recipients === 1 ? '' : 's')
          : (m.sender_name || '');
        return '<div class="mail-row' + (unread ? ' unread' : '') + '" data-id="' + m.id + '" role="button" tabindex="0">' +
          '<span class="from">' + App.esc(who) + '</span>' +
          '<span class="subject">' + App.esc(m.subject || '(no subject)') +
            (m.attachments ? ' &#128206;' : '') +
            (m.status === 'draft' ? ' <span class="badge warn">draft</span>' : '') +
          '</span>' +
          '<span class="when">' + App.esc(App.fmtDate(m.created_at, true)) + '</span>' +
        '</div>';
      }).join('');
      App.qsa('.mail-row', listHost).forEach(function (rowEl) {
        const open = function () { openMessage(Number(rowEl.getAttribute('data-id'))); };
        App.on(rowEl, 'click', open);
        App.on(rowEl, 'keydown', function (e) { if (e.key === 'Enter') open(); });
      });
      pagerHost.innerHTML = App.pager(data.page, data.pages, 'data-mpage');
      App.qsa('#mail-pager button[data-mpage]').forEach(function (b) {
        App.on(b, 'click', function () {
          page = Number(b.getAttribute('data-mpage')) || 1;
          loadList();
        });
      });
      loadFolders();
    }).catch(function (err) {
      listHost.innerHTML = App.emptyState('Could not load mail', err.message);
    });
  }
    /* --------------------------- reading pane ------------------------------ */
  function openMessage(id) {
    App.api('/api/mail/message/' + id).then(function (data) {
      const m = data.message;
      const canReply = m.status === 'sent';
      const rows = [];
      rows.push(['From', (m.sender ? (m.sender.full_name + (m.sender.mail_address ? ' <' + m.sender.mail_address + '>' : '')) : '—')]);
      rows.push(['To', (m.recipients || []).map(function (r) { return r.full_name; }).join(', ') || '—']);
      rows.push(['Sent', App.fmtDate(m.created_at, true)]);
      if (m.status === 'draft') rows.push(['Status', 'Draft — not sent yet']);

      const atts = (m.attachments || []).length
        ? '<div class="attachments">' + m.attachments.map(function (a) {
            return '<a class="attachment" href="/api/mail/attachment/' + a.id + '">' +
              '&#128196; ' + App.esc(a.original_name) + ' <small>(' + App.esc(App.fmtSize(a.size)) + ')</small></a>';
          }).join('') + '</div>'
        : '';

      listView.innerHTML =
        '<div class="mail-read" id="message-' + m.id + '">' +
          '<div class="spread">' +
            '<h2 class="mb-0">' + App.esc(m.subject || '(no subject)') + '</h2>' +
            '<button class="btn btn-ghost btn-sm" type="button" id="back-btn">&larr; Back</button>' +
          '</div>' +
          '<div class="detail-list mt-2">' +
            rows.map(function (r) {
              return '<div class="r"><span class="k">' + App.esc(r[0]) + '</span><span class="v">' + App.esc(r[1]) + '</span></div>';
            }).join('') +
          '</div>' +
          '<div class="mail-body">' + App.esc(m.body) + '</div>' +
          atts +
          '<hr class="divider">' +
          '<div class="row">' +
            (canReply ? '<button class="btn btn-sm" type="button" id="reply-btn">Reply</button>' : '') +
            (m.status === 'draft' ? '<button class="btn btn-sm" type="button" id="continue-draft">Continue draft</button>' : '') +
            '<button class="btn btn-sm btn-outline" type="button" id="trash-btn">' +
              (folder === 'trash' ? 'Delete forever' : 'Move to trash') + '</button>' +
            (folder === 'trash' ? '<button class="btn btn-sm btn-ghost" type="button" id="restore-btn">Restore</button>' : '') +
          '</div>' +
        '</div>';

      App.on(App.qs('#back-btn'), 'click', showList);
      App.on(App.qs('#reply-btn'), 'click', function () { openCompose(m); });
      App.on(App.qs('#continue-draft'), 'click', function () { openCompose(null, m); });

      App.on(App.qs('#trash-btn'), 'click', function () {
        const btn = this;
        const action = folder === 'trash'
          ? App.api('/api/mail/message/' + m.id, { method: 'DELETE' })
          : App.api('/api/mail/message/' + m.id + '/trash', { method: 'POST', body: {} });
        App.busy(btn, function () { return action; }).then(function () {
          App.toast(folder === 'trash' ? 'Message deleted.' : 'Moved to trash.', 'ok');
          showList();
        }).catch(function (err) { App.toast(err.message, 'err'); });
      });
      App.on(App.qs('#restore-btn'), 'click', function () {
        const btn = this;
        App.busy(btn, function () {
          return App.api('/api/mail/message/' + m.id + '/restore', { method: 'POST', body: {} });
        }).then(function () {
          App.toast('Message restored to your inbox.', 'ok');
          showList();
        }).catch(function (err) { App.toast(err.message, 'err'); });
      });

      /* Deep link support: /mail.html#message-42 (used by notifications). */
      listView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      listView.innerHTML = App.emptyState('Message unavailable', err.message) +
        '<p class="center"><button class="btn btn-outline btn-sm" type="button" id="back-btn2">Back to list</button></p>';
      App.on(App.qs('#back-btn2'), 'click', showList);
    });
  }

  function showList() {
    listView.innerHTML =
      '<div class="mail-list" id="mail-list"><div class="empty-state"><strong>Loading…</strong></div></div>' +
      '<div id="mail-pager"></div>';
    /* Re-bind the module-level references to the fresh nodes. */
    listHost = document.getElementById('mail-list');
    pagerHost = document.getElementById('mail-pager');
    loadList();
  }
    /* ----------------------------- composer -------------------------------- */
  function openCompose(replyTo, draft) {
    const box = App.openModal(
      '<h3>' + (replyTo ? 'Reply' : (draft ? 'Continue draft' : 'Compose message')) + '</h3>' +
      '<div class="form-error hidden" id="c-error"></div>' +
      '<form id="compose-form" novalidate>' +
        '<div class="field">' +
          '<label>Send to</label>' +
          '<div class="chiplist" id="aud-chips">' +
            '<button class="chip on" type="button" data-type="users">People</button>' +
            '<button class="chip" type="button" data-type="school">School</button>' +
            '<button class="chip" type="button" data-type="lga">LGA</button>' +
            '<button class="chip" type="button" data-type="role">Role</button>' +
            '<button class="chip" type="button" data-type="all">Everyone</button>' +
          '</div>' +
        '</div>' +

        '<div class="field" id="aud-users">' +
          '<label for="people-q">Search people</label>' +
          '<input type="search" id="people-q" placeholder="Name, email or mail address…">' +
          '<div class="recip-list mt-1" id="people-list"><div class="notif-empty">Type to search…</div></div>' +
        '</div>' +

        '<div class="field hidden" id="aud-school">' +
          '<label for="school-sel">School</label>' +
          '<select id="school-sel"><option value="">Loading…</option></select>' +
        '</div>' +
        '<div class="field hidden" id="aud-lga">' +
          '<label for="lga-sel">LGA</label>' +
          '<select id="lga-sel"><option value="">Loading…</option></select>' +
        '</div>' +
        '<div class="field hidden" id="aud-role">' +
          '<label for="role-sel">Role</label>' +
          '<select id="role-sel"><option value="">Loading…</option></select>' +
        '</div>' +
        '<div class="field hidden" id="aud-all">' +
          '<p class="kv-note">Every active portal account will receive this message.</p>' +
        '</div>' +

        '<div class="field">' +
          '<label for="c-subject">Subject</label>' +
          '<input type="text" id="c-subject" maxlength="200" required>' +
        '</div>' +
        '<div class="field">' +
          '<label for="c-body">Message</label>' +
          '<textarea id="c-body" rows="8" maxlength="20000" required></textarea>' +
        '</div>' +
        '<div class="field">' +
          '<label for="c-files">Attachments <span class="muted">(PDF, JPG, PNG, DOCX, XLSX — max 5 MB each)</span></label>' +
          '<input type="file" id="c-files" multiple accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx">' +
          '<div class="hint" id="c-attach-status"></div>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" id="c-draft">Save draft</button>' +
          '<button class="btn btn-ghost" type="button" id="c-cancel">Cancel</button>' +
          '<button class="btn" type="submit" id="c-send">Send</button>' +
        '</div>' +
      '</form>'
    );
        let audType = 'users';
    const picked = new Map();   /* id -> display name */
    let draftId = draft ? draft.id : null;

    function setAudience(type) {
      audType = type;
      App.qsa('#aud-chips .chip', box).forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-type') === type);
      });
      ['users', 'school', 'lga', 'role', 'all'].forEach(function (t) {
        const el = document.getElementById('aud-' + t);
        if (el) el.classList.toggle('hidden', t !== type);
      });
    }
    App.qsa('#aud-chips .chip', box).forEach(function (chip) {
      App.on(chip, 'click', function () { setAudience(chip.getAttribute('data-type')); });
    });

    /* ---- people picker ---- */
    function paintPeople(rows) {
      const host = document.getElementById('people-list');
      if (!rows.length) {
        host.innerHTML = '<div class="notif-empty">Nobody matches that search.</div>';
        return;
      }
      host.innerHTML = rows.map(function (p) {
        const id = String(p.id);
        const meta = [p.role, p.mail_address || p.email].filter(Boolean).join(' · ');
        return '<label><input type="checkbox" data-pid="' + id + '"' +
          (picked.has(id) ? ' checked' : '') + '> ' +
          App.esc(p.full_name) + '<span class="meta">' + App.esc(meta) + '</span></label>';
      }).join('');
      App.qsa('#people-list input[data-pid]', box).forEach(function (cb) {
        App.on(cb, 'change', function () {
          const id = cb.getAttribute('data-pid');
          const label = cb.closest('label');
          const name = label ? label.textContent.trim() : id;
          if (cb.checked) picked.set(id, name); else picked.delete(id);
        });
      });
    }

    const searchPeople = App.debounce(function () {
      const q = document.getElementById('people-q').value.trim();
      const host = document.getElementById('people-list');
      host.innerHTML = '<div class="notif-empty">Searching…</div>';
      App.api('/api/mail/recipients?type=users&q=' + encodeURIComponent(q)).then(function (data) {
        paintPeople(data.people || []);
      }).catch(function (err) {
        host.innerHTML = '<div class="notif-empty">' + App.esc(err.message) + '</div>';
      });
    }, 300);
    App.on(document.getElementById('people-q'), 'input', searchPeople);

    /* ---- audience dropdowns ---- */
    App.api('/api/mail/recipients?type=schools').then(function (d) {
      document.getElementById('school-sel').innerHTML = '<option value="">Select a school…</option>' +
        d.schools.map(function (s) {
          return '<option value="' + s.id + '">' + App.esc(s.name) + ' (' + App.esc(s.lga) + ')</option>';
        }).join('');
    }).catch(function () { /* placeholder stays */ });
    App.api('/api/mail/recipients?type=lgas').then(function (d) {
      document.getElementById('lga-sel').innerHTML = '<option value="">Select an LGA…</option>' +
        d.lgas.map(function (l) { return '<option value="' + App.esc(l) + '">' + App.esc(l) + '</option>'; }).join('');
    }).catch(function () { /* placeholder stays */ });
    App.api('/api/mail/recipients?type=roles').then(function (d) {
      document.getElementById('role-sel').innerHTML = '<option value="">Select a role…</option>' +
        d.roles.map(function (r) { return '<option value="' + App.esc(r) + '">' + App.esc(r) + '</option>'; }).join('');
    }).catch(function () { /* placeholder stays */ });
        /* ---- prefill: reply target / draft body ---- */
    if (replyTo) {
      document.getElementById('c-subject').value =
        (/^re:/i.test(replyTo.subject) ? '' : 'Re: ') + replyTo.subject;
      document.getElementById('c-body').value = '\n\n— — —\nOn ' +
        App.fmtDate(replyTo.created_at, true) + ', ' +
        (replyTo.sender ? replyTo.sender.full_name : 'someone') + ' wrote:\n' +
        String(replyTo.body || '').split('\n').slice(0, 12).join('\n');
      if (replyTo.sender && replyTo.sender.id) {
        picked.set(String(replyTo.sender.id), replyTo.sender.full_name);
        const host = document.getElementById('people-list');
        host.innerHTML = '<label><input type="checkbox" checked data-pid="' + replyTo.sender.id + '"> ' +
          App.esc(replyTo.sender.full_name) + '<span class="meta">reply target</span></label>';
        App.on(host.querySelector('input[data-pid]'), 'change', function (e) {
          if (!e.target.checked) picked.delete(String(replyTo.sender.id));
        });
      }
    }
    if (draft) {
      document.getElementById('c-subject').value = draft.subject || '';
      document.getElementById('c-body').value = draft.body || '';
      draftId = draft.id;
    }

    /* ---- attachments ---- */
    function uploadFiles() {
      const files = document.getElementById('c-files').files;
      if (!files.length) return Promise.resolve([]);
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append('files', files[i]);
      const status = document.getElementById('c-attach-status');
      status.textContent = 'Uploading…';
      return App.apiForm('/api/mail/upload', fd).then(function (data) {
        status.textContent = (data.attachments || []).length + ' file(s) attached.';
        return (data.attachments || []).map(function (a) { return a.id; });
      }).catch(function (err) {
        status.textContent = '';
        throw err;
      });
    }

    /* ---- payload + validation ---- */
    function payload(attachmentIds) {
      const body = {
        subject: document.getElementById('c-subject').value.trim(),
        body: document.getElementById('c-body').value,
        to_type: audType,
        to_ids: Array.from(picked.keys()),
        attachment_ids: attachmentIds || []
      };
      if (audType === 'school') body.to_school_id = Number(document.getElementById('school-sel').value) || null;
      if (audType === 'lga') body.to_lga = document.getElementById('lga-sel').value;
      if (audType === 'role') body.to_role = document.getElementById('role-sel').value;
      return body;
    }
    function validate(p) {
      if (!p.subject) return 'Add a subject line.';
      if (!p.body.trim()) return 'Write a message.';
      if (audType === 'users' && !p.to_ids.length) return 'Choose at least one recipient.';
      if (audType === 'school' && !p.to_school_id) return 'Choose a school.';
      if (audType === 'lga' && !p.to_lga) return 'Choose an LGA.';
      if (audType === 'role' && !p.to_role) return 'Choose a role.';
      return '';
    }
    function fail(message) {
      const err = document.getElementById('c-error');
      err.textContent = message;
      err.classList.remove('hidden');
    }
        /* ---- actions ---- */
    App.on(document.getElementById('c-cancel'), 'click', App.closeModal);

    App.on(document.getElementById('c-draft'), 'click', function () {
      const btn = this;
      const p = payload([]);
      if (!p.subject) { fail('Add a subject line before saving a draft.'); return; }
      App.busy(btn, function () {
        if (draftId) return App.api('/api/mail/draft/' + draftId, { method: 'PUT', body: p });
        return App.api('/api/mail/draft', { method: 'POST', body: p }).then(function (d) {
          draftId = d.id;
          return d;
        });
      }).then(function () {
        App.closeModal();
        App.toast('Draft saved.', 'ok');
        showList();
      }).catch(function (err) { fail(err.message); });
    });

    App.on(document.getElementById('compose-form'), 'submit', function (e) {
      e.preventDefault();
      const btn = document.getElementById('c-send');
      const problem = validate(payload([]));
      if (problem) { fail(problem); return; }

      App.busy(btn, function () {
        return uploadFiles().then(function (ids) {
          const full = payload(ids);
          if (draftId) {
            return App.api('/api/mail/draft/' + draftId + '/send', { method: 'POST', body: full });
          }
          return App.api('/api/mail/send', { method: 'POST', body: full });
        });
      }).then(function (data) {
        App.closeModal();
        App.toast('Delivered to ' + (data.delivered || 0) + ' recipient(s).', 'ok');
        folder = 'sent';
        App.qsa('#folders button').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-folder') === 'sent');
        });
        page = 1;
        showList();
      }).catch(function (err) { fail(err.message); });
    });
  }

  /* ------------------------------ start ---------------------------------- */
  App.ready(function () {
    App.on(document.getElementById('compose-btn'), 'click', function () { openCompose(); });

    const search = App.debounce(function () { page = 1; loadList(); }, 300);
    App.on(document.getElementById('q'), 'input', search);
    App.on(document.getElementById('search-btn'), 'click', function () { page = 1; loadList(); });

    /* Deep links from notifications: #message-42 or #folder-sent */
    const hash = window.location.hash.replace('#', '');
    if (hash.indexOf('folder-') === 0) {
      folder = hash.slice(7);
      App.qsa('#folders button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-folder') === folder);
      });
      loadList();
    } else if (hash.indexOf('message-') === 0) {
      loadFolders();
      openMessage(Number(hash.slice(8)));
    } else {
      loadList();
    }
  });
})();

