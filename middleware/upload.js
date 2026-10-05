/**
 * middleware/upload.js — multer configuration.
 * Every upload is size checked, type checked (extension + MIME) and stored
 * under a random filename so a hostile name can never reach the filesystem.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || './uploads');
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '5', 10);
const MAX_BYTES = MAX_MB * 1024 * 1024;

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const DOC_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.docx', '.xlsx'];
const DOC_MIME = [
  'application/pdf', 'image/jpeg', 'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.ms-excel'
];
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function ensureDir(sub) {
  const dir = path.join(UPLOAD_DIR, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function randomName(original) {
  const ext = path.extname(String(original || '')).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex') + ext;
}

function makeStorage(sub) {
  return multer.diskStorage({
    destination: function (req, file, cb) { cb(null, ensureDir(sub)); },
    filename: function (req, file, cb) { cb(null, randomName(file.originalname)); }
  });
}

function extFilter(allowedExt, allowedMime, label) {
  return function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExt.indexOf(ext) === -1) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', label + ': .' + ext.replace('.', '') + ' is not allowed'));
    }
    if (allowedMime && file.mimetype && allowedMime.indexOf(file.mimetype) === -1) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', label + ': file type ' + file.mimetype + ' is not allowed'));
    }
    return cb(null, true);
  };
}

function makeUploader(sub, allowedExt, allowedMime, label, maxBytes) {
  return multer({
    storage: makeStorage(sub),
    limits: { fileSize: maxBytes || MAX_BYTES, files: 5 },
    fileFilter: extFilter(allowedExt, allowedMime, label)
  });
}

/** Mail attachments: pdf, jpg, png, docx, xlsx — max 5 MB each. */
const mailAttachments = makeUploader('mail', DOC_EXT, DOC_MIME, 'Attachment', MAX_BYTES);

/** Passport photographs, news covers, logos, governor photo (images only). */
const images = makeUploader('photos', IMAGE_EXT, IMAGE_MIME, 'Image', Math.min(MAX_BYTES, 3 * 1024 * 1024));

/** Circulars and public forms: PDF (plus images for a scanned copy). */
const documents = makeUploader('circulars', ['.pdf', '.jpg', '.jpeg', '.png'],
  ['application/pdf', 'image/jpeg', 'image/png'], 'Document', 10 * 1024 * 1024);

/** CSV bulk import — held in memory, parsed immediately, never written to disk. */
const csvMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: extFilter(['.csv', '.txt'], ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'], 'CSV')
});

/** Relative web path for a stored file. */
function relPath(absOrRel) {
  const abs = path.resolve(absOrRel);
  return '/' + path.relative(path.resolve(__dirname, '..'), abs).replace(/\\/g, '/');
}

/* Backup/restore archives are held in memory: they are validated and
 * unpacked immediately, then written to disk explicitly. */
const backupZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: extFilter(['.zip'], ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], 'Backup')
});

module.exports = {
  UPLOAD_DIR: UPLOAD_DIR,
  MAX_BYTES: MAX_BYTES,
  MAX_MB: MAX_MB,
  mailAttachments: mailAttachments,
  images: images,
  documents: documents,
  csvMemory: csvMemory,
  backupZip: backupZip,
  relPath: relPath,
  randomName: randomName,
  IMAGE_EXT: IMAGE_EXT,
  DOC_EXT: DOC_EXT
};