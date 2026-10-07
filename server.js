/**
 * server.js — Taraba State Ministry of Secondary, Vocational and Technical
 * Education portal.
 */
'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const db = require('./db');
const realtime = require('./lib/realtime');
const csrf = require('./middleware/csrf');
const auth = require('./middleware/auth');
const { globalLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errors');

const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

if (String(process.env.TRUST_PROXY || '0') === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ------------------------------- security ------------------------------ */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'same-origin' },
  hsts: IS_PROD ? { maxAge: 15552000 } : false,
  upgradeInsecureRequests: IS_PROD ? undefined : null
}));

const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, false);
    return callback(null, allowedOrigins.indexOf(origin) !== -1);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization']
}));

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(globalLimiter);

app.use(csrf.issueToken);
app.use('/api', csrf.verify);
app.use(auth.attachUser);

app.get('/api/health', function (req, res) {
  res.json({ ok: true, app: 'taraba-edu-portal', time: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/schools', require('./routes/schools'));
app.use('/api/teachers', require('./routes/teachers'));
app.use('/api/news', require('./routes/news'));
app.use('/api/events', require('./routes/events'));
app.use('/api/faqs', require('./routes/faq'));
app.use('/api/circulars', require('./routes/circulars'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/mail', require('./routes/mail'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', notFound);

/* ------------------------------ static files --------------------------- */
const staticOptions = {
  maxAge: IS_PROD ? '7d' : 0,
  etag: true,
  setHeaders: function (res) { res.setHeader('X-Content-Type-Options', 'nosniff'); }
};
app.use('/uploads/photos', express.static(path.join(db.UPLOAD_DIR, 'photos'), staticOptions));
app.use('/uploads/circulars', express.static(path.join(db.UPLOAD_DIR, 'circulars'), staticOptions));
app.use('/uploads/branding', express.static(path.join(db.UPLOAD_DIR, 'branding'), staticOptions));

app.get('/sw.js', function (req, res) {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: IS_PROD ? '1h' : 0,
  setHeaders: function (res, filePath) {
    if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/school/:id', function (req, res) { res.sendFile(path.join(PUBLIC_DIR, 'school.html')); });
app.get('/news/:slug', function (req, res) { res.sendFile(path.join(PUBLIC_DIR, 'news-detail.html')); });

app.use(notFound);
app.use(errorHandler);

/* -------------------------------- start -------------------------------- */
const server = http.createServer(app);
realtime.attach(server);

// Make the startup callback async to await db.getSetting
server.listen(PORT, async function () {
  const aiStatus = require('./lib/ai').status();
  const smsStatus = require('./lib/sms').providerStatus();
  const mailStatus = require('./lib/mailer').mailStatus();
  const line = '='.repeat(64);
  
  // Await the async function so it prints the actual name, not "[object Promise]"
  const ministryName = await db.getSetting('ministry_name', 'Taraba State Ministry of Secondary, Vocational and Technical Education');
  
  console.log('\n' + line);
  console.log(' ' + ministryName);
  console.log(' Portal running at http://localhost:' + PORT + (IS_PROD ? ' (PRODUCTION)' : ''));
  console.log(line);
  
  if (IS_PROD && db.DB_FILE && db.DB_FILE.endsWith('.db') && !process.env.DATABASE_URL) {
    console.warn('\n⚠️  WARNING: Running in PRODUCTION with a local SQLite database (' + db.DB_FILE + ').');
    console.warn('   Render\'s filesystem is EPHEMERAL. All data will be LOST on restart/deploy.');
    console.warn('   Please set DATABASE_URL in Render.\n');
  }

  console.log(' Database   : ' + (process.env.DATABASE_URL ? 'PostgreSQL (Connected)' : db.DB_FILE));
  console.log(' Uploads    : ' + db.UPLOAD_DIR);
  
  // These are safe to call synchronously as they are just counts, but we can await them to be perfectly safe
  const lgaCount = await db.get('SELECT COUNT(*) AS n FROM lgas');
  const schoolCount = await db.get('SELECT COUNT(*) AS n FROM schools');
  
  console.log(' LGAs seeded: ' + (lgaCount ? lgaCount.n : 0));
  console.log(' Schools    : ' + (schoolCount ? schoolCount.n : 0) + '  (add the real schools from the admin dashboard)');
  console.log(' AI         : ' + aiStatus.model);
  console.log(' SMS        : ' + smsStatus.provider + (smsStatus.dryRun ? ' (DRY-RUN - nothing is sent)' : ' (live)'));
  console.log(' Mail       : ' + mailStatus.adapter + ' (internal portal mail only)');
  if (db.seededOwner && db.seededOwner.created) {
    console.log(' Owner login: ' + db.seededOwner.email + '  (password from OWNER_PASSWORD in .env)');
  }
  console.log(' Stop with CTRL+C\n');
});

function shutdown(signal) {
  console.log('\n[server] ' + signal + ' received - shutting down');
  server.close(function () {
    try { db.close(); } catch (err) { /* already closed */ }
    process.exit(0);
  });
  setTimeout(function () { process.exit(0); }, 8000).unref();
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('uncaughtException', function (err) {
  console.error('[server] uncaught exception:', err && err.message);
});
process.on('unhandledRejection', function (err) {
  console.error('[server] unhandled rejection:', err && err.message ? err.message : err);
});

module.exports = app;