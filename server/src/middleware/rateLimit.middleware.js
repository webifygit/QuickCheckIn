const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const config = require('../config');

// Four separate budgets, because the endpoints differ in both cost and who can
// reach them. Sharing one budget across all of them is what turns "someone is
// hammering the public form" into "the front desk cannot review anything".

const windowMs = config.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;

const base = {
  windowMs,
  standardHeaders: true,
  legacyHeaders: false,
  // Rate limits exist to protect the service, not to police the test suite.
  skip: () => config.isTest,
};

// The guest form is public by design - anyone with the link can post to it - so
// this is one of the two endpoints actually exposed to the internet.
const submitLimiter = rateLimit({
  ...base,
  max: config.RATE_LIMIT_PUBLIC_MAX,
  message: { error: 'Too many submissions from this network. Please try again shortly.' },
});

// Scanning decodes an image, which is by far the most expensive thing the
// server does. It gets a tighter budget than plain form submission.
const scanLimiter = rateLimit({
  ...base,
  max: config.RATE_LIMIT_SCAN_MAX,
  message: { error: 'Too many uploads from this network. Please try again shortly.' },
});

const loginLimiter = rateLimit({
  ...base,
  max: config.RATE_LIMIT_LOGIN_MAX,
  skipSuccessfulRequests: true,
  message: { error: 'Too many sign-in attempts. Please wait and try again.' },
});

// Staff traffic is keyed by account, not by IP: a hotel's front desk sits behind
// one NAT address, so an IP budget would have the whole team share a quota and
// the busiest reviewer lock out everyone else. Keying on the verified staff id
// still bounds a stolen token, which is the threat this limit is actually for.
//
// Must be mounted after requireStaffAuth - req.staff is what it keys on.
const staffLimiter = rateLimit({
  ...base,
  max: config.RATE_LIMIT_STAFF_MAX,
  // ipKeyGenerator normalises IPv6 into a /64 subnet key. Only reached if this
  // limiter is ever mounted without auth in front of it.
  keyGenerator: (req) => req.staff?.staffId || ipKeyGenerator(req.ip),
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

module.exports = { submitLimiter, scanLimiter, loginLimiter, staffLimiter };
