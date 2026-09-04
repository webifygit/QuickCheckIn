const express = require('express');
const config = require('../config');
const logger = require('../lib/logger');
const { sweepOrphanedUploads } = require('../lib/orphanSweeper');

// On a long-lived process the orphan sweep runs on an interval from
// src/index.js. A serverless deployment has no process to hold that interval,
// so the same job is driven by a scheduled request instead (vercel.json crons).
//
// The endpoint deletes stored objects, so it is not open. Vercel sends
// `Authorization: Bearer $CRON_SECRET` on cron invocations; without CRON_SECRET
// configured the route is not mounted at all, rather than mounted and
// unguarded.

const router = express.Router();

router.post('/sweep-orphans', async (req, res) => {
  const expected = `Bearer ${config.CRON_SECRET}`;
  const provided = req.get('authorization') || '';

  // Same length for both sides keeps the comparison from leaking the secret's
  // length, and a mismatch answers 404 rather than 403 - an unauthenticated
  // caller learns nothing about whether this path exists.
  if (provided.length !== expected.length || provided !== expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const result = await sweepOrphanedUploads();
  logger.info(result, 'Orphan sweep ran from a scheduled request');
  return res.json({ ok: true, ...result });
});

// Vercel Cron issues GET. Accepting both keeps the endpoint usable by hand
// (curl -X POST) without a second code path.
router.get('/sweep-orphans', (req, res, next) => {
  req.method = 'POST';
  router.handle(req, res, next);
});

module.exports = router;
