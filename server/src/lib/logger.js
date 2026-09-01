const pino = require('pino');
const config = require('../config');

// Guest submissions carry names, phone numbers, addresses and ID fragments.
// None of it belongs in a log aggregator, so redact aggressively and log
// identifiers rather than payloads.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.fullName',
  'req.body.phone',
  'req.body.email',
  'req.body.address',
  'req.body.idNumber',
  'req.body.dob',
  'res.headers["set-cookie"]',
];

const logger = pino({
  level: config.isTest ? 'silent' : config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'quickcheckin-api' },
  transport: config.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

module.exports = logger;
