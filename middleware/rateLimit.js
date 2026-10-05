/**
 * middleware/rateLimit.js — abuse protection.
 * Login, registration, chat and SMS are deliberately stricter than the rest.
 */
'use strict';

const rateLimit = require('express-rate-limit');

const json = function (message) {
  return function (req, res) {
    res.status(429).json({ error: message });
  };
};

function keyFor(req) {
  if (req.user && req.user.id) return 'u:' + req.user.id;
  return 'ip:' + (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown');
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyFor,
  handler: json('Too many requests from this device. Please wait a few minutes and try again.')
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('Too many login attempts. Please wait 15 minutes before trying again.')
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('Too many registration attempts from this device. Please try again later.')
});

const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  keyGenerator: keyFor,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('You are sending messages very quickly. Please slow down.')
});

const smsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  keyGenerator: keyFor,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('SMS sending is limited to 15 batches per hour. Please try again later.')
});

const mailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  keyGenerator: keyFor,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('Too many messages sent. Please wait a moment.')
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  keyGenerator: keyFor,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json('Too many changes at once. Please slow down.')
});

module.exports = {
  globalLimiter: globalLimiter,
  loginLimiter: loginLimiter,
  registerLimiter: registerLimiter,
  chatLimiter: chatLimiter,
  smsLimiter: smsLimiter,
  mailLimiter: mailLimiter,
  writeLimiter: writeLimiter
};