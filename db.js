/**
 * db.js — SQLite schema, seed data and small helpers.
 *
 * Everything the portal knows lives in ONE file (data/portal.db by default),
 * which makes backup and transfer to a new host a simple file copy.
 *
 * Run `node db.js --force-seed` to (re)apply the seed (never deletes content).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

require('dotenv').config();

const ROOT = __dirname;
const DB_FILE = path.resolve(ROOT, process.env.DB_FILE || './data/portal.db');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
['photos', 'news', 'circulars', 'mail', 'branding'].forEach(function (sub) {
  fs.mkdirSync(path.join(UPLOAD_DIR, sub), { recursive: true });
});

/* Opening the database can fail for reasons an administrator can actually act
 * on (missing folder, corrupt file, bad permissions). Say so plainly instead
 * of dumping a raw driver message. */
let db;
try {
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
} catch (err) {
  console.error('\n[db] FATAL: the portal database could not be opened.');
  console.error('  File : ' + DB_FILE);
  console.error('  Reason: ' + err.message);
  console.error('\n  What to check:');
  console.error('   1. Does the file exist and is the folder writable?');
  console.error('   2. If the file is damaged, restore a backup:');
  console.error('        npm run backup            (make a fresh copy first)');
  console.error('        then restore data/portal.db from your backups folder, or');
  console.error('        use Admin -> Backup & restore in the portal.');
  console.error('   3. DB_FILE in .env may point at the wrong location.');
  console.error('\n  The portal has NOT started.\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * The 16 Local Government Areas of Taraba State (official list).
 * NOTHING ELSE is seeded into the schools table — schools are added by
 * the ministry through the admin dashboard or the CSV bulk importer.
 * ------------------------------------------------------------------ */
const LGAS = [
  'Ardo-Kola', 'Bali', 'Donga', 'Gashaka', 'Gassol', 'Ibi', 'Jalingo',
  'Karim Lamido', 'Kurmi', 'Lau', 'Sardauna', 'Takum', 'Ussa', 'Wukari',
  'Yorro', 'Zing'
];

const SCHOOL_TYPES = ['junior_secondary', 'senior_secondary', 'technical', 'vocational'];
const SCHOOL_CATEGORIES = ['boys', 'girls', 'mixed'];
const BOARDING_TYPES = ['boarding', 'day', 'both'];
const TEACHER_STATUSES = ['ACTIVE', 'TRANSFERRED', 'RETIRED', 'LEFT'];
const ROLES = ['OWNER', 'ADMIN', 'LGA_OFFICER', 'SCHOOL_ADMIN', 'EDITOR', 'STAFF'];

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

/* ------------------------------------------------------------------ *
 * PLACEHOLDER CONTENT
 * Every editable string below is deliberately written as a visible
 * placeholder.  No quote, statistic, date or policy claim is invented:
 * the ministry replaces these from Admin -> Site settings.
 * ------------------------------------------------------------------ */
const DEFAULT_SETTINGS = {
  ministry_name: 'Taraba State Ministry of Secondary, Vocational and Technical Education',
  ministry_short_name: 'TSMSVTE',
  site_tagline: '[PLACEHOLDER: short one-line tagline for the ministry portal]',
  logo: '/icons/logo-192.png',
  governor_photo: '/img/photos/governor.svg',
  primary_color: '#0b6b3a',
  secondary_color: '#ffffff',
  accent_color: '#f2b705',

  hero_heading: 'Welcome to the Taraba State Ministry of Secondary, Vocational and Technical Education',
  hero_subheading: '[PLACEHOLDER: short welcome message from the Honourable Commissioner]',
  hero_image: '/img/photos/hero-group.svg',

  /* Ministry photographs. Alt text lives in the markup and describes the
   * scene only — never a person's name. Names and titles are the settings
   * below, which the ministry fills in. */
  commissioner_photo: '/img/photos/commissioner.svg',
  commissioner_name: '[PLACEHOLDER: name of the Commissioner]',
  commissioner_title: '[PLACEHOLDER: title of the Commissioner]',
  commissioner_message: '[PLACEHOLDER: message from the Commissioner. Enter the approved wording from Admin -> Site settings.]',
  default_news_cover: '/img/photos/news-backpacks.svg',
  about_gallery_image_1: '/img/photos/about-classroom.svg',
  about_gallery_image_2: '/img/photos/news-backpacks.svg',

  free_education_banner_title: "The Governor's Free Education Programme",
  free_education_banner_image: '/img/photos/programme-free-education.svg',
  free_education_banner_text: "[PLACEHOLDER: official summary of the Governor's free education programme. Paste the approved policy text here.]",
  girl_child_banner_title: 'Support for the Girl-Child',
  girl_child_banner_image: '/img/photos/programme-girl-child.svg',
  girl_child_banner_text: "[PLACEHOLDER: official summary of the Governor's support programme for the girl-child. Paste the approved policy text here.]",

  governor_name: "[PLACEHOLDER: Governor's full name]",
  governor_title: 'Executive Governor, Taraba State',
  governor_vision_free_education: "[PLACEHOLDER: the Governor's vision for FREE EDUCATION in Taraba State. Replace this text with the approved wording. No quote is published until the ministry enters it here.]",
  governor_vision_girl_child: "[PLACEHOLDER: the Governor's vision for SUPPORT FOR THE GIRL-CHILD. Replace this text with the approved wording.]",
  governor_vision_note: 'Note: the text on this page is a placeholder entered by the portal administrator. It is not an official quote until the ministry publishes the approved wording.',

  about_history: '[PLACEHOLDER: history of the ministry. Enter the approved text from Admin -> Site settings.]',
  about_functions: '[PLACEHOLDER: statutory functions of the ministry. One per line.]',
  about_departments: '[PLACEHOLDER: departments and units of the ministry. One per line.]',
  about_leadership: '[PLACEHOLDER: leadership — Honourable Commissioner, Permanent Secretary, Directors. One per line.]',

  mission: '[PLACEHOLDER: the mission statement of the ministry.]',
  vision: '[PLACEHOLDER: the vision statement of the ministry.]',

  contact_address: '[PLACEHOLDER: ministry office address, Jalingo, Taraba State]',
  contact_phone: '[PLACEHOLDER: +234 ...]',
  contact_email: '[PLACEHOLDER: info@example.gov.ng]',
  contact_map_link: 'https://www.google.com/maps/search/?api=1&query=Jalingo%20Taraba%20State',
  office_hours: '[PLACEHOLDER: Monday - Friday, 8:00am - 4:00pm]',

  footer_credit_text: 'Powered by Flokytechsolution',
  footer_credit_link: 'https://flokytechsolution.com',

  mail_domain: process.env.MAIL_DOMAIN || 'tsmsvte.gov.ng',

  sms_sender_id: process.env.SMS_SENDER_ID || 'TSMSVTE',
  sms_footer: ' - TSMSVTE',

  admin_chat_status: 'offline',
  admin_working_hours: '[PLACEHOLDER: Monday - Friday, 8:00am - 4:00pm]',
  public_bot_enabled: '1',
  registration_open: '1',

  privacy_notice: 'Your personal data (name, phone, email, staff number, rank, school and passport photograph) is collected only to verify your employment and to create your portal account. It is processed in line with the Nigeria Data Protection Act 2023, is visible only to authorised ministry administrators, is never sold or shared with third parties, and is removed when it is no longer required. By registering you consent to this processing.',
  faq_notice: 'This assistant answers only from the ministry knowledge base and cannot change policy, dates or procedures. If it is unsure it will say so and connect you to a member of staff.'
};

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lgas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schools (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  lga              TEXT NOT NULL,
  address          TEXT NOT NULL DEFAULT '',
  principal        TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL DEFAULT 'junior_secondary',
  category         TEXT NOT NULL DEFAULT 'mixed',
  boarding         TEXT NOT NULL DEFAULT 'day',
  year_established INTEGER,
  notes            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, lga)
);
CREATE INDEX IF NOT EXISTS idx_schools_lga ON schools (lga);
CREATE INDEX IF NOT EXISTS idx_schools_type ON schools (type);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'STAFF',
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  phone         TEXT NOT NULL DEFAULT '',
  mail_address  TEXT UNIQUE,
  avatar        TEXT NOT NULL DEFAULT '',
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER REFERENCES users (id) ON DELETE SET NULL,
  full_name        TEXT NOT NULL,
  phone            TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  staff_number     TEXT NOT NULL DEFAULT '',
  rank             TEXT NOT NULL DEFAULT '',
  school_id        INTEGER REFERENCES schools (id) ON DELETE SET NULL,
  school_name      TEXT NOT NULL DEFAULT '',
  lga              TEXT NOT NULL DEFAULT '',
  photo            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'PENDING',
  rejection_reason TEXT NOT NULL DEFAULT '',
  approved_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  approved_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_status ON staff (status);

/* Teachers register (phase 1c).  staff_no is globally unique; school_id is a
 * hard FK — deleting a school with teachers is refused both here (FK) and in
 * routes/schools.js (friendly 409).  status: ACTIVE / TRANSFERRED / RETIRED /
 * LEFT (see TEACHER_STATUSES). */
CREATE TABLE IF NOT EXISTS teachers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id     INTEGER NOT NULL REFERENCES schools (id),
  staff_no      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  sex           TEXT NOT NULL DEFAULT '',
  date_of_birth TEXT NOT NULL DEFAULT '',
  qualification TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  rank          TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teachers_school ON teachers (school_id);
CREATE INDEX IF NOT EXISTS idx_teachers_status ON teachers (status);
CREATE INDEX IF NOT EXISTS idx_teachers_subject ON teachers (subject);

CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  summary      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'General',
  cover_image  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft',
  author_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_date  TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events (event_date);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);

CREATE TABLE IF NOT EXISTS faqs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'General',
  keywords   TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  keywords   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS circulars (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'Circular',
  file_path   TEXT NOT NULL DEFAULT '',
  file_name   TEXT NOT NULL DEFAULT '',
  file_size   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'published',
  created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     INTEGER,
  parent_id     INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  sender_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  audience      TEXT NOT NULL DEFAULT 'users',
  audience_meta TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'sent',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);

CREATE TABLE IF NOT EXISTS message_recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_read    INTEGER NOT NULL DEFAULT 0,
  read_at    TEXT,
  is_trashed INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_recipients_user ON message_recipients (user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER REFERENCES messages (id) ON DELETE CASCADE,
  uploader_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  purpose       TEXT NOT NULL DEFAULT 'mail',
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime          TEXT NOT NULL DEFAULT '',
  size          INTEGER NOT NULL DEFAULT 0,
  rel_path      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  body       TEXT NOT NULL,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_by          INTEGER REFERENCES users (id) ON DELETE SET NULL,
  sent_by_name     TEXT NOT NULL DEFAULT '',
  audience         TEXT NOT NULL DEFAULT '',
  audience_meta    TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  recipients_count INTEGER NOT NULL DEFAULT 0,
  provider         TEXT NOT NULL DEFAULT 'termii',
  status           TEXT NOT NULL DEFAULT 'queued',
  dry_run          INTEGER NOT NULL DEFAULT 0,
  detail           TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER REFERENCES users (id) ON DELETE SET NULL,
  display_name      TEXT NOT NULL DEFAULT 'Guest',
  channel           TEXT NOT NULL DEFAULT 'staff',
  mode              TEXT NOT NULL DEFAULT 'bot',
  status            TEXT NOT NULL DEFAULT 'open',
  assigned_admin_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  unanswered_count  INTEGER NOT NULL DEFAULT 0,
  escalation_offered INTEGER NOT NULL DEFAULT 0,
  ticket_id         INTEGER,
  last_message_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_status ON chat_sessions (status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chatmsg_session ON chat_messages (session_id);

CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES chat_sessions (id) ON DELETE SET NULL,
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',
  handled_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at  TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  user_name  TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  details    TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);

CREATE TABLE IF NOT EXISTS tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  email      TEXT NOT NULL DEFAULT '',
  purpose    TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tokens_purpose ON tokens (purpose);
`);

/* ------------------------------------------------------------------ *
 * Sample-data marker (safe, backward-compatible migration).
 *
 * tools/seed.js tags every row it inserts with is_sample = 1 so that
 * `npm run seed -- --wipe-samples` can delete ONLY those rows and never
 * touch real ministry data.  Existing databases simply gain the column.
 * ------------------------------------------------------------------ */
['schools', 'news', 'circulars'].forEach(function (table) {
  const has = db.pragma('table_info(' + table + ')')
    .some(function (col) { return col.name === 'is_sample'; });
  if (!has) db.exec('ALTER TABLE ' + table + ' ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0');
});

/* ------------------------------------------------------------------ *
 * Per-account login lockout (safe, backward-compatible migration).
 *
 * One row per lower-cased email address. Locks carry an absolute expiry, so
 * an account always unlocks itself — the owner can never be locked out for
 * good. Rows are deleted automatically on a successful sign-in.
 * ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS login_attempts (
  email           TEXT PRIMARY KEY,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT,
  locked_until    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts (locked_until);
`);

/* ------------------------------------------------------------------ *
 * Scoped accounts (safe, additive).
 *
 * LGA_OFFICER and SCHOOL_ADMIN are limited to one LGA or one school.  The two
 * nullable columns are added rather than a new table so every existing
 * account (owner, admin, editor, staff) keeps working untouched.
 * ------------------------------------------------------------------ */
(function addUserScopeColumns() {
  ['lga_id', 'school_id'].forEach(function (col) {
    const has = db.pragma('table_info(users)').some(function (c) { return c.name === col; });
    if (!has) db.exec('ALTER TABLE users ADD COLUMN ' + col + ' INTEGER');
  });
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_lga ON users (lga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_school ON users (school_id)');
})();

/* ------------------------------------------------------------------ *
 * schools.lga_id (safe, additive migration).
 *
 * `schools.lga` keeps the canonical LGA NAME: that is what the directory,
 * the CSV export and every public page display, and what a ministry CSV
 * written before the "Karim-Lamido" rename still contains.  `schools.lga_id`
 * is the real FK to lgas(id) and is the ONLY thing the isolation rules in
 * middleware/scope.js match on, so a spelling can never widen or shrink
 * somebody's scope.
 *
 * Existing rows are filled once from the text, case-, hyphen- and space-
 * tolerant ("karim lamido" == "Karim-Lamido" == "KARIM_LAMIDO").  A row whose
 * LGA text matches none of the 16 real LGAs is left NULL and logged — never
 * guessed at — so it stays visible to the statewide roles and invisible to
 * the scoped ones until a human corrects it.  Only NULL rows are touched, so
 * running it again is harmless (tools/seed.js calls it after seeding).
 * ------------------------------------------------------------------ */
(function addSchoolLgaIdColumn() {
  const has = db.pragma('table_info(schools)').some(function (c) { return c.name === 'lga_id'; });
  if (!has) db.exec('ALTER TABLE schools ADD COLUMN lga_id INTEGER REFERENCES lgas (id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_schools_lga_id ON schools (lga_id)');
})();

/** Case/space/hyphen/punctuation-tolerant key: "Karim-Lamido" == "karim lamido". */
function normLgaKey(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fill schools.lga_id from the schools.lga text for every row that lacks it.
 * Unmatched schools keep NULL and are logged individually — no guessing.
 * @returns {{matched:number, unmatched:number}}
 */
function backfillSchoolLgaIds() {
  const pending = db.prepare('SELECT id, name, lga FROM schools WHERE lga_id IS NULL').all();
  if (!pending.length) return { matched: 0, unmatched: 0 };

  const byKey = Object.create(null);
  db.prepare('SELECT id, name FROM lgas').all().forEach(function (lga) {
    byKey[normLgaKey(lga.name)] = lga.id;
  });
  const setLga = db.prepare('UPDATE schools SET lga_id = ? WHERE id = ? AND lga_id IS NULL');
  const report = { matched: 0, unmatched: 0 };

  const apply = db.transaction(function (rows) {
    rows.forEach(function (school) {
      const lgaId = byKey[normLgaKey(school.lga)];
      if (lgaId) {
        setLga.run(lgaId, school.id);
        report.matched += 1;
        return;
      }
      report.unmatched += 1;
      console.warn('[migrate] schools.lga_id: no LGA matches "' + school.lga +
        '" — school #' + school.id + ' "' + school.name + '" left with a NULL lga_id.');
    });
  });
  apply(pending);
  return report;
}

/* ------------------------------------------------------------------ *
 * Per-recipient SMS log (safe, additive migration).
 *
 * One row per recipient for every bulk send, so a failure is never hidden by
 * a summary count.  Only the LAST FOUR digits of the number are stored: the
 * ministry must not keep a full phone list in the log tables.
 * ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS sms_recipient_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id      INTEGER NOT NULL REFERENCES sms_logs (id) ON DELETE CASCADE,
  phone_masked TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'queued',
  provider_id  TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_recipient_send ON sms_recipient_log (send_id);
CREATE INDEX IF NOT EXISTS idx_sms_recipient_status ON sms_recipient_log (status);
`);

/* Pending send confirmations (one row per preview, single use). */
db.exec(`
CREATE TABLE IF NOT EXISTS sms_send_tokens (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash     TEXT NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipients     TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  invalid_count  INTEGER NOT NULL DEFAULT 0,
  message        TEXT NOT NULL,
  template_id    INTEGER,
  template_name  TEXT NOT NULL DEFAULT '',
  audience       TEXT NOT NULL DEFAULT '',
  segments       INTEGER NOT NULL DEFAULT 1,
  used_at        TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_tokens_expiry ON sms_send_tokens (expires_at);
`);

/* ------------------------------------------------------------------ *
 * LGA spelling correction (safe, idempotent, runs in one transaction).
 *
 * The official spelling of this Local Government Area is "Karim-Lamido".
 * Older databases (and older imports) used "Karim Lamido". Only the LGA
 * NAME changes: the slug stays "karim-lamido" either way, so every
 * /schools.html?lga=... URL keeps working untouched.
 *
 * Guarded on the old name being present, so running it twice does nothing
 * the second time.
 * ------------------------------------------------------------------ */
const LGA_RENAMES = [{ from: 'Karim Lamido', to: 'Karim-Lamido' }];

LGA_RENAMES.forEach(function (change) {
  const target = db.prepare('SELECT id FROM lgas WHERE name = ?').get(change.from);
  if (!target) return;                       /* already renamed (or never present) */

  db.transaction(function () {
    /* Refuse to merge into an existing, differently-spelled LGA row. */
    const clash = db.prepare('SELECT id FROM lgas WHERE name = ? AND id <> ?').get(change.to, target.id);
    if (clash) {
      throw new Error('Cannot rename "' + change.from + '" to "' + change.to +
        '": an LGA with that name already exists.');
    }

    /* slugify() produces the same slug for both spellings, so URLs are stable.
     * Re-assert it anyway, keeping the slug unique. */
    const slug = slugify(change.to);
    const slugClash = db.prepare('SELECT id FROM lgas WHERE slug = ? AND id <> ?').get(slug, target.id);
    db.prepare('UPDATE lgas SET name = ?, slug = ? WHERE id = ?')
      .run(change.to, slugClash ? slug + '-2' : slug, target.id);

    /* Every table that stores the LGA name as text follows it. */
    ['schools', 'staff'].forEach(function (table) {
      const cols = db.pragma('table_info(' + table + ')');
      if (!cols.some(function (c) { return c.name === 'lga'; })) return;
      db.prepare('UPDATE ' + table + " SET lga = ? WHERE lga = ?").run(change.to, change.from);
    });
  })();
});

/* ------------------------------------------------------------------ *
 * Ministry photographs (safe, additive).
 *
 * The keys above only backfill NEW rows (seedSettings uses INSERT OR
 * IGNORE).  hero_image and governor_photo have existed since day one with an
 * empty value, so fill those here — and only when they are still empty, so a
 * photograph the ministry has already uploaded is never overwritten.
 * ------------------------------------------------------------------ */
[['hero_image', '/img/photos/hero-group.svg'],
  ['governor_photo', '/img/photos/governor.svg']].forEach(function (pair) {
  if (!String(getSetting(pair[0], '')).trim()) setSetting(pair[0], pair[1]);
});

/* Earlier drafts pointed these at .jpg files that were never supplied.  Move
 * any still-pointing-at-a-missing-file path to the .svg placeholder that now
 * exists, but never touch a path the ministry has set to something real. */
const PHOTO_SETTINGS = ['hero_image', 'governor_photo', 'free_education_banner_image',
  'girl_child_banner_image', 'commissioner_photo', 'default_news_cover',
  'about_gallery_image_1', 'about_gallery_image_2'];
PHOTO_SETTINGS.forEach(function (key) {
  const value = String(getSetting(key, '')).trim();
  if (value.indexOf('/img/photos/') !== 0 || value.slice(-4) !== '.jpg') return;
  const base = value.slice('/img/photos/'.length, -4);
  const svg = '/img/photos/' + base + '.svg';
  if (fs.existsSync(path.join(ROOT, 'public', svg))) setSetting(key, svg);
});

/* ------------------------------------------------------------------ *
 * Settings helpers — NOTHING about branding is hardcoded in the app;
 * every value flows through this table (see Admin -> Site settings).
 * ------------------------------------------------------------------ */
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value !== null && row.value !== undefined) return row.value;
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return DEFAULT_SETTINGS[key];
  return fallback === undefined ? '' : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value === null || value === undefined ? '' : String(value));
}

function getSettings() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  db.prepare('SELECT key, value FROM settings').all().forEach(function (row) {
    out[row.key] = row.value;
  });
  return out;
}

function setSettings(obj) {
  const tx = db.transaction(function (entries) {
    entries.forEach(function (e) { setSetting(e[0], e[1]); });
  });
  tx(Object.entries(obj));
}

/* Keys that must never be exposed on a public endpoint */
const PRIVATE_SETTING_KEYS = [
  'privacy_notice', 'admin_chat_status', 'admin_working_hours'
];

function getPublicSettings() {
  const all = getSettings();
  const out = {};
  Object.keys(all).forEach(function (k) {
    /* Keys marked private are NEVER part of the public settings blob, even
     * though the settings table holds them. Anything a public page genuinely
     * needs (e.g. the registration privacy notice) is served by its own
     * dedicated endpoint instead. */
    if (PRIVATE_SETTING_KEYS.indexOf(k) !== -1) return;
    if (k.indexOf('sms_') === 0) return;
    if (k === 'registration_open' || k === 'public_bot_enabled') { out[k] = all[k]; return; }
    out[k] = all[k];
  });
  return out;
}

/** The registration privacy notice, served on purpose for the public
 *  registration form. This is the ONLY deliberate exception to the private
 *  keys above, and it exposes this one string and nothing else. */
function getPublicPrivacyNotice() {
  return getSetting('privacy_notice', '');
}

/* ------------------------------------------------------------------ *
 * Small utility helpers
 * ------------------------------------------------------------------ */
function now() {
  return new Date().toISOString();
}

function makeMailAddress(fullName, domain) {
  const parts = String(fullName || 'staff').trim().toLowerCase()
    .replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  const first = parts[0] || 'staff';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  let base = last ? first + '.' + last : first;
  base = base.slice(0, 40);
  const host = domain || getSetting('mail_domain', 'tsmsvte.gov.ng');
  let candidate = base + '@' + host;
  let n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE mail_address = ?').get(candidate)) {
    n += 1;
    candidate = base + n + '@' + host;
  }
  return candidate;
}

function logAudit(actor, action, entity, entityId, details, req) {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, user_name, role, action, entity, entity_id, details, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      (actor && actor.id) || null,
      (actor && actor.full_name) || 'system',
      (actor && actor.role) || 'SYSTEM',
      action,
      entity || '',
      entityId === undefined || entityId === null ? '' : String(entityId),
      typeof details === 'string' ? details : JSON.stringify(details || {}),
      (req && (req.ip || '')) || '',
      (req && req.headers && req.headers['user-agent']) || ''
    );
  } catch (err) {
    console.error('[audit] failed:', err.message);
  }
}

function notify(userId, title, body, link) {
  if (!userId) return null;
  const info = db.prepare(
    'INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)'
  ).run(userId, title || '', body || '', link || '');
  return info.lastInsertRowid;
}

function notifyRole(roles, title, body, link) {
  const list = Array.isArray(roles) ? roles : [roles];
  const placeholders = list.map(function () { return '?'; }).join(',');
  const stmt = db.prepare(
    'SELECT id FROM users WHERE role IN (' + placeholders + ") AND status = 'ACTIVE'"
  );
  stmt.all.apply(stmt, list).forEach(function (u) { notify(u.id, title, body, link); });
}

/* ------------------------------------------------------------------ *
 * One-time tokens (password reset, ownership transfer, invitations)
 * Only the SHA-256 hash is stored — the raw token is shown once.
 * ------------------------------------------------------------------ */
function createToken(opts) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const minutes = opts.ttlMinutes || 60 * 24;
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare(
    `INSERT INTO tokens (user_id, email, purpose, token_hash, meta, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    opts.userId || null,
    (opts.email || '').toLowerCase(),
    opts.purpose,
    hash,
    typeof opts.meta === 'string' ? opts.meta : JSON.stringify(opts.meta || {}),
    expires
  );
  return { token: raw, expiresAt: expires };
}

function consumeToken(rawToken, purpose) {
  if (!rawToken) return null;
  const hash = crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  const row = db.prepare(
    `SELECT * FROM tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL
     AND datetime(expires_at) > datetime('now') ORDER BY id DESC LIMIT 1`
  ).get(hash, purpose);
  if (!row) return null;
  db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */
function seedSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(function () {
    Object.entries(DEFAULT_SETTINGS).forEach(function (e) { insert.run(e[0], String(e[1])); });
  });
  tx();
}

function seedLgas() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO lgas (name, slug, sort_order) VALUES (?, ?, ?)'
  );
  const tx = db.transaction(function () {
    LGAS.forEach(function (name, i) { insert.run(name, slugify(name), i + 1); });
  });
  tx();
}

function seedOwner() {
  const email = String(process.env.OWNER_EMAIL || 'owner@example.gov.ng').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || 'ChangeMe!2026';
  const name = String(process.env.OWNER_NAME || 'Portal Owner').trim();

  const existing = db.prepare('SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1').get('OWNER');
  if (existing) return { created: false, email: existing.email };

  const sameEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (sameEmail) {
    db.prepare("UPDATE users SET role = 'OWNER', updated_at = datetime('now') WHERE id = ?")
      .run(sameEmail.id);
    return { created: false, promoted: true, email: sameEmail.email };
  }

  const hash = bcrypt.hashSync(password, 10);
  const mail = makeMailAddress(name, getSetting('mail_domain'));
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, status, mail_address)
     VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?)`
  ).run(email, hash, name, mail);
  return { created: true, id: info.lastInsertRowid, email: email };
}

/* Only portal-usage FAQ answers are seeded — they describe the portal
 * itself, not ministry policy.  Everything else stays a placeholder. */
function seedFaqs() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM faqs').get().n;
  if (count > 0) return;
  const domain = getSetting('mail_domain', 'example.gov.ng');
  const rows = [
    ['How do I register as a member of staff?',
     'Open the Staff register page and fill in your full name, phone number, email, file/staff number, rank or designation, school, LGA and a passport photograph. Your status stays PENDING until a ministry administrator approves it.',
     'Registration', 'register,sign up,account,staff number,pending', 1],
    ['What happens after my registration is approved?',
     'When an administrator approves you, the portal notifies you and creates an internal portal mail address of the form firstname.lastname@' + domain + ', which gives you access to the staff dashboard.',
     'Registration', 'approved,approval,mail address,portal email,dashboard', 2],
    ['I forgot my password. What do I do?',
     'Password resets are handled by an administrator. Ask an administrator to generate a one-time reset token for you, then open the reset page, paste the token and choose a new password. Tokens expire and can only be used once.',
     'Account', 'password,forgot,reset,login problem,token', 3],
    ['How do I install the portal on my phone?',
     'Open the portal on your phone and tap the "Install app" button on the home page, or use the browser menu and choose "Add to Home Screen". The portal then opens like an app, and pages you have already visited keep working when the network is weak.',
     'Using the portal', 'install,pwa,home screen,offline,app', 4],
    ['Can portal mail send messages to Gmail or Yahoo?',
     'No. Portal mail is INTERNAL mail between portal users only. It does not send to or receive from internet email addresses. External mail would require an SMTP bridge that the ministry has to configure separately.',
     'Using the portal', 'email,gmail,yahoo,external,smtp,internet', 5]
  ];
  const stmt = db.prepare(
    `INSERT INTO faqs (question, answer, category, keywords, sort_order, status)
     VALUES (?, ?, ?, ?, ?, 'published')`
  );
  const tx = db.transaction(function () {
    rows.forEach(function (r) { stmt.run(r[0], r[1], r[2], r[3], r[4]); });
  });
  tx();
}

function seedSmsTemplates() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM sms_templates').get().n;
  if (count > 0) return;
  const rows = [
    ['Emergency meeting',
     'EMERGENCY MEETING: All {{rank}} staff of {{school}} are invited to a meeting on {{date}} at {{time}} at {{venue}}. Signed: Management.'],
    ['Circular notice',
     'NOTICE: {{message}}. Please check the Circulars page on the ministry portal for the full document.'],
    ['Resumption reminder',
     'REMINDER: Schools resume on {{date}}. All staff should report to their duty posts.'],
    ['General announcement',
     '{{message}}']
  ];
  const stmt = db.prepare('INSERT INTO sms_templates (name, body) VALUES (?, ?)');
  const tx = db.transaction(function () { rows.forEach(function (r) { stmt.run(r[0], r[1]); }); });
  tx();
}

function seedKnowledgeBase() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_base').get().n;
  if (count > 0) return;
  /* The knowledge base is deliberately free of ministry policy: the bot
   * must never invent policy.  Only these portal-mechanics entries are
   * seeded; administrators add the real content themselves. */
  const stmt = db.prepare(
    `INSERT INTO knowledge_base (question, answer, keywords, status)
     VALUES (?, ?, ?, 'published')`
  );
  const tx = db.transaction(function () {
    stmt.run(
      'Where can I see circulars and forms?',
      'Open the Circulars and Downloads page from the main menu. Documents are uploaded by ministry administrators as PDF files.',
      'circular,form,download,pdf,document'
    );
    stmt.run(
      'How do I contact the ministry?',
      'The office address, telephone numbers, email address and map link are on the About Us page. They are maintained by the portal administrator.',
      'contact,phone,address,email,office,location'
    );
    stmt.run(
      'Who can see my personal data?',
      'Only authorised ministry administrators can see staff registration data. The portal collects the minimum needed to verify employment and follows the Nigeria Data Protection Act 2023.',
      'privacy,data,ndpa,personal,consent'
    );
  });
  tx();
}

function seed() {
  seedSettings();
  seedLgas();
  const owner = seedOwner();
  seedFaqs();
  seedSmsTemplates();
  seedKnowledgeBase();
  return owner;
}

const _owner = seed();

/* The 16 LGAs only exist once seed() has run, so the one-time fill of
 * schools.lga_id has to happen after it. */
const _backfill = backfillSchoolLgaIds();
if (_backfill.matched || _backfill.unmatched) {
  console.log('[migrate] schools.lga_id backfill: ' + _backfill.matched + ' matched, ' +
    _backfill.unmatched + ' left NULL (see warnings above).');
}

module.exports = {
  db: db,
  DB_FILE: DB_FILE,
  UPLOAD_DIR: UPLOAD_DIR,
  ROOT: ROOT,
  LGAS: LGAS,
  SCHOOL_TYPES: SCHOOL_TYPES,
  SCHOOL_CATEGORIES: SCHOOL_CATEGORIES,
  BOARDING_TYPES: BOARDING_TYPES,
  TEACHER_STATUSES: TEACHER_STATUSES,
  ROLES: ROLES,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  /* Connection helpers so route modules can use `db.prepare(...)` directly.
   * They go through the `db` variable, so they keep working after a restore
   * swaps the database file and re-opens the connection. */
  prepare: function () { return db.prepare.apply(db, arguments); },
  transaction: function (fn) { return db.transaction(fn); },
  exec: function (sql) { return db.exec(sql); },
  pragma: function (sql, opts) { return db.pragma(sql, opts); },
  backup: function (dest) { return db.backup(dest); },
  close: function () { return db.close(); },
  reload: function () {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    module.exports.db = db;
    return db;
  },
  slugify: slugify,
  getSetting: getSetting,
  setSetting: setSetting,
  getSettings: getSettings,
  setSettings: setSettings,
  getPublicSettings: getPublicSettings,
  getPublicPrivacyNotice: getPublicPrivacyNotice,
  makeMailAddress: makeMailAddress,
  logAudit: logAudit,
  notify: notify,
  notifyRole: notifyRole,
  createToken: createToken,
  consumeToken: consumeToken,
  now: now,
  normLgaKey: normLgaKey,
  backfillSchoolLgaIds: backfillSchoolLgaIds,
  seed: seed,
  seededOwner: _owner
};

if (require.main === module) {
  const result = seed();
  console.log('[db] schema ready:', DB_FILE);
  if (result.created) console.log('[db] OWNER account created:', result.email);
  else if (result.promoted) console.log('[db] existing account promoted to OWNER:', result.email);
  else console.log('[db] OWNER already exists:', result.email);
  console.log('[db] settings rows:', db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,
              '| LGAs:', db.prepare('SELECT COUNT(*) AS n FROM lgas').get().n);
}