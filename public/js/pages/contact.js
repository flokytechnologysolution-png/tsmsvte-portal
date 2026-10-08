/**
 * public/js/pages/contact.js - the public contact page.
 *
 * Shows only details the ministry has really entered. Empty values and any
 * value still containing "[PLACEHOLDER" are hidden, never displayed.
 */
(function () {
  'use strict';

  function real(v) {
    var s = (v === undefined || v === null) ? '' : String(v).trim();
    if (!s || /\[PLACEHOLDER/i.test(s)) return '';
    return s;
  }

  function row(label, valueHtml) {
    return '<div class="contact-row"><dt>' + App.esc(label) + '</dt><dd>' + valueHtml + '</dd></div>';
  }

  App.ready(function () {
    var host = document.getElementById('contact-details');

    App.api('/api/settings/public').then(function (d) {
      var s = (d && d.settings) || {};
      var address = real(s.contact_address);
      var phone = real(s.contact_phone);
      var email = real(s.contact_email);
      var hours = real(s.office_hours);
      var rows = [];

      if (address) rows.push(row('Address', App.esc(address)));
      if (phone) {
        rows.push(row('Phone', '<a href="tel:' + App.esc(phone.replace(/[^+0-9]/g, '')) + '">' +
          App.esc(phone) + '</a>'));
      }
      if (email) {
        rows.push(row('Email', '<a href="mailto:' + App.esc(email) + '">' + App.esc(email) + '</a>'));
      }
      if (hours) rows.push(row('Office hours', App.esc(hours)));

      host.innerHTML = rows.length
        ? '<div class="card"><dl class="contact-list">' + rows.join('') + '</dl></div>'
        : App.emptyState('Contact details are coming soon',
            'The ministry has not published its contact details yet.');
    }).catch(function (err) {
      host.innerHTML = App.emptyState('Could not load contact details', err.message);
    });
  });
})();