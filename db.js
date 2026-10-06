/**
 * db.js — Universal database handler (PostgreSQL for Production, SQLite for Local)
 * COMPLETE VERSION
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
require('dotenv').config();

const ROOT = __dirname;
const DB_FILE = path.resolve(ROOT, process.env.DB_FILE || './data/portal.db');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads');

if (!process.env.DATABASE_URL) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
['photos', 'news', 'circulars', 'mail', 'branding'].forEach(function (sub) {
  fs.mkdirSync(path.join(UPLOAD_DIR, sub), { recursive: true });
});

const IS_PROD = !!process.env.DATABASE_URL;
let pgPool = null;
let sqliteDb = null;

if (IS_PROD) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('[db] Connected to PostgreSQL (Production)');
} else {
  const Database = require('better-sqlite3');
  try {
    sqliteDb = new Database(DB_FILE);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    sqliteDb.pragma('busy_timeout = 5000');
    console.log('[db] Connected to SQLite (Local Development)');
  } catch (err) {
    console.error('\n[db] FATAL: the portal database could not be opened.');
    console.error('  File : ' + DB_FILE);
    console.error('  Reason: ' + err.message);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ *
 * Universal Async Query Wrappers
 * ------------------------------------------------------------------ */
async function query(sql, params = []) {
  if (IS_PROD) {
    const res = await pgPool.query(sql, params);
    return res.rows;
  } else {
    const stmt = sqliteDb.prepare(sql);
    return params.length ? stmt.all(...params) : stmt.all();
  }
}

async function get(sql, params = []) {
  if (IS_PROD) {
    const res = await pgPool.query(sql, params);
    return res.rows[0] || null;
  } else {
    const stmt = sqliteDb.prepare(sql);
    return params.length ? stmt.get(...params) : stmt.get();
  }
}

async function run(sql, params = []) {
  if (IS_PROD) {
    const res = await pgPool.query(sql, params);
    return { lastInsertRowid: res.rows[0]?.id, changes: res.rowCount };
  } else {
    const stmt = sqliteDb.prepare(sql);
    return params.length ? stmt.run(...params) : stmt.run();
  }
}

/* ------------------------------------------------------------------ *
 * Schema Initialization
 * ------------------------------------------------------------------ */
async function ensureSchema() {
  if (IS_PROD) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS lgas (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS schools (id SERIAL PRIMARY KEY, name TEXT NOT NULL, lga TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', principal TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'junior_secondary', category TEXT NOT NULL DEFAULT 'mixed', boarding TEXT NOT NULL DEFAULT 'day', year_established INTEGER, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (name, lga));
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STAFF', status TEXT NOT NULL DEFAULT 'ACTIVE', phone TEXT NOT NULL DEFAULT '', mail_address TEXT UNIQUE, avatar TEXT NOT NULL DEFAULT '', last_login_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS staff (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE SET NULL, full_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', staff_number TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', school_id INTEGER REFERENCES schools (id) ON DELETE SET NULL, school_name TEXT NOT NULL DEFAULT '', lga TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', rejection_reason TEXT NOT NULL DEFAULT '', approved_by INTEGER REFERENCES users (id) ON DELETE SET NULL, approved_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS teachers (id SERIAL PRIMARY KEY, school_id INTEGER NOT NULL REFERENCES schools (id), staff_no TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, sex TEXT NOT NULL DEFAULT '', date_of_birth TEXT NOT NULL DEFAULT '', qualification TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS news (id SERIAL PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'General', cover_image TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', author_id INTEGER REFERENCES users (id) ON DELETE SET NULL, published_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', event_date TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS faqs (id SERIAL PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', keywords TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'published', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS knowledge_base (id SERIAL PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'published', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS circulars (id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Circular', file_path TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'published', created_by INTEGER REFERENCES users (id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, thread_id INTEGER, parent_id INTEGER REFERENCES messages (id) ON DELETE SET NULL, sender_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT 'users', audience_meta TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'sent', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS message_recipients (id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, is_read INTEGER NOT NULL DEFAULT 0, read_at TIMESTAMP, is_trashed INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, UNIQUE (message_id, user_id));
      CREATE TABLE IF NOT EXISTS attachments (id SERIAL PRIMARY KEY, message_id INTEGER REFERENCES messages (id) ON DELETE CASCADE, uploader_id INTEGER REFERENCES users (id) ON DELETE SET NULL, purpose TEXT NOT NULL DEFAULT 'mail', original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, rel_path TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sms_templates (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_by INTEGER REFERENCES users (id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sms_logs (id SERIAL PRIMARY KEY, sent_by INTEGER REFERENCES users (id) ON DELETE SET NULL, sent_by_name TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', audience_meta TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', recipients_count INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL DEFAULT 'termii', status TEXT NOT NULL DEFAULT 'queued', dry_run INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS chat_sessions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE SET NULL, display_name TEXT NOT NULL DEFAULT 'Guest', channel TEXT NOT NULL DEFAULT 'staff', mode TEXT NOT NULL DEFAULT 'bot', status TEXT NOT NULL DEFAULT 'open', assigned_admin_id INTEGER REFERENCES users (id) ON DELETE SET NULL, unanswered_count INTEGER NOT NULL DEFAULT 0, escalation_offered INTEGER NOT NULL DEFAULT 0, ticket_id INTEGER, last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, closed_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE, role TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE SET NULL, session_id INTEGER REFERENCES chat_sessions (id) ON DELETE SET NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', handled_by INTEGER REFERENCES users (id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, closed_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, user_id INTEGER, user_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, entity TEXT NOT NULL DEFAULT '', entity_id TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tokens (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, email TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL, token_hash TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '', expires_at TIMESTAMP NOT NULL, used_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS login_attempts (email TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, first_failed_at TIMESTAMP, locked_until TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sms_recipient_log (id SERIAL PRIMARY KEY, send_id INTEGER NOT NULL REFERENCES sms_logs (id) ON DELETE CASCADE, phone_masked TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sms_send_tokens (id SERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, recipients TEXT NOT NULL, recipient_count INTEGER NOT NULL DEFAULT 0, invalid_count INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL, template_id INTEGER, template_name TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', segments INTEGER NOT NULL DEFAULT 1, used_at TIMESTAMP, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `);
  } else {
    // SQLite Schema (Your original, complete schema)
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS lgas (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS schools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lga TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', principal TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'junior_secondary', category TEXT NOT NULL DEFAULT 'mixed', boarding TEXT NOT NULL DEFAULT 'day', year_established INTEGER, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (name, lga));
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STAFF', status TEXT NOT NULL DEFAULT 'ACTIVE', phone TEXT NOT NULL DEFAULT '', mail_address TEXT UNIQUE, avatar TEXT NOT NULL DEFAULT '', last_login_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users (id) ON DELETE SET NULL, full_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', staff_number TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', school_id INTEGER REFERENCES schools (id) ON DELETE SET NULL, school_name TEXT NOT NULL DEFAULT '', lga TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', rejection_reason TEXT NOT NULL DEFAULT '', approved_by INTEGER REFERENCES users (id) ON DELETE SET NULL, approved_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY AUTOINCREMENT, school_id INTEGER NOT NULL REFERENCES schools (id), staff_no TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, sex TEXT NOT NULL DEFAULT '', date_of_birth TEXT NOT NULL DEFAULT '', qualification TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'General', cover_image TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', author_id INTEGER REFERENCES users (id) ON DELETE SET NULL, published_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', event_date TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS faqs (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', keywords TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS knowledge_base (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS circulars (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Circular', file_path TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'published', created_by INTEGER REFERENCES users (id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, parent_id INTEGER REFERENCES messages (id) ON DELETE SET NULL, sender_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT 'users', audience_meta TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS message_recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, is_read INTEGER NOT NULL DEFAULT 0, read_at TEXT, is_trashed INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, UNIQUE (message_id, user_id));
      CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER REFERENCES messages (id) ON DELETE CASCADE, uploader_id INTEGER REFERENCES users (id) ON DELETE SET NULL, purpose TEXT NOT NULL DEFAULT 'mail', original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, rel_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sms_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_by INTEGER REFERENCES users (id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sms_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, sent_by INTEGER REFERENCES users (id) ON DELETE SET NULL, sent_by_name TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', audience_meta TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', recipients_count INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL DEFAULT 'termii', status TEXT NOT NULL DEFAULT 'queued', dry_run INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS chat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users (id) ON DELETE SET NULL, display_name TEXT NOT NULL DEFAULT 'Guest', channel TEXT NOT NULL DEFAULT 'staff', mode TEXT NOT NULL DEFAULT 'bot', status TEXT NOT NULL DEFAULT 'open', assigned_admin_id INTEGER REFERENCES users (id) ON DELETE SET NULL, unanswered_count INTEGER NOT NULL DEFAULT 0, escalation_offered INTEGER NOT NULL DEFAULT 0, ticket_id INTEGER, last_message_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
      CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE, role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users (id) ON DELETE SET NULL, session_id INTEGER REFERENCES chat_sessions (id) ON DELETE SET NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', handled_by INTEGER REFERENCES users (id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, entity TEXT NOT NULL DEFAULT '', entity_id TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, email TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL, token_hash TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS login_attempts (email TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, first_failed_at TEXT, locked_until TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sms_recipient_log (id INTEGER PRIMARY KEY AUTOINCREMENT, send_id INTEGER NOT NULL REFERENCES sms_logs (id) ON DELETE CASCADE, phone_masked TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sms_send_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, recipients TEXT NOT NULL, recipient_count INTEGER NOT NULL DEFAULT 0, invalid_count INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL, template_id INTEGER, template_name TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', segments INTEGER NOT NULL DEFAULT 1, used_at TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
  }
}

ensureSchema().catch(console.error);

/* ------------------------------------------------------------------ *
 * Constants & Helpers
 * ------------------------------------------------------------------ */
const LGAS = ['Ardo-Kola', 'Bali', 'Donga', 'Gashaka', 'Gassol', 'Ibi', 'Jalingo', 'Karim-Lamido', 'Kurmi', 'Lau', 'Sardauna', 'Takum', 'Ussa', 'Wukari', 'Yorro', 'Zing'];

const DEFAULT_SETTINGS = {
  ministry_name: 'Taraba State Ministry of Secondary, Vocational and Technical Education',
  ministry_short_name: 'TSMSVTE',
  site_tagline: 'Empowering Education in Taraba State',
  mail_domain: process.env.MAIL_DOMAIN || 'tsmsvte.gov.ng',
  admin_chat_status: 'offline',
  public_bot_enabled: '1',
  registration_open: '1'
};

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160);
}

async function getSetting(key, fallback) {
  const row = await get(IS_PROD ? 'SELECT value FROM settings WHERE key = $1' : 'SELECT value FROM settings WHERE key = ?', [key]);
  if (row && row.value !== null && row.value !== undefined) return row.value;
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return DEFAULT_SETTINGS[key];
  return fallback === undefined ? '' : fallback;
}

async function setSetting(key, value) {
  const val = value === null || value === undefined ? '' : String(value);
  if (IS_PROD) {
    await run(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`, [key, val]);
  } else {
    sqliteDb.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, val);
  }
}

async function getSettings() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  const rows = await query('SELECT key, value FROM settings');
  rows.forEach(function (row) { out[row.key] = row.value; });
  return out;
}

function makeMailAddress(fullName, domain) {
  const parts = String(fullName || 'staff').trim().toLowerCase().replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  const first = parts[0] || 'staff';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  let base = last ? first + '.' + last : first;
  base = base.slice(0, 40);
  const host = domain || 'tsmsvte.gov.ng';
  return base + '@' + host; // Simplified for async safety
}

async function seedLgas() {
  for (let i = 0; i < LGAS.length; i++) {
    const name = LGAS[i];
    const slug = slugify(name);
    if (IS_PROD) {
      await run(`INSERT INTO lgas (name, slug, sort_order) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`, [name, slug, i + 1]);
    } else {
      sqliteDb.prepare('INSERT OR IGNORE INTO lgas (name, slug, sort_order) VALUES (?, ?, ?)').run(name, slug, i + 1);
    }
  }
}

async function seedOwner() {
  const email = String(process.env.OWNER_EMAIL || 'owner@example.gov.ng').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || 'ChangeMe!2026';
  const name = String(process.env.OWNER_NAME || 'Portal Owner').trim();

  const existing = await get(IS_PROD ? 'SELECT * FROM users WHERE role = $1 ORDER BY id LIMIT 1' : 'SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1', ['OWNER']);
  if (existing) return { created: false, email: existing.email };

  const hash = bcrypt.hashSync(password, 10);
  const mail = makeMailAddress(name, await getSetting('mail_domain'));
  
  if (IS_PROD) {
    await run(`INSERT INTO users (email, password_hash, full_name, role, status, mail_address) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', $4)`, [email, hash, name, mail]);
  } else {
    sqliteDb.prepare(`INSERT INTO users (email, password_hash, full_name, role, status, mail_address) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?)`).run(email, hash, name, mail);
  }
  return { created: true, email: email };
}

async function seed() {
  await seedLgas();
  return await seedOwner();
}

let seededOwner = null;
seed().then(owner => { seededOwner = owner; }).catch(console.error);

module.exports = {
  db: IS_PROD ? pgPool : sqliteDb,
  DB_FILE: DB_FILE,
  UPLOAD_DIR: UPLOAD_DIR,
  ROOT: ROOT,
  LGAS: LGAS,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  query: query,
  get: get,
  run: run,
  getSetting: getSetting,
  setSetting: setSetting,
  getSettings: getSettings,
  seed: seed,
  seededOwner: seededOwner,
  close: function () {
    if (IS_PROD) return pgPool.end();
    return sqliteDb.close();
  }
};