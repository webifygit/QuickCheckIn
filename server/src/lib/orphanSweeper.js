const config = require('../config');
const logger = require('./logger');
const prisma = require('../prismaClient');
const { storage } = require('./storage');

// A guest can upload their Aadhaar photo, see the form fill itself in, and then
// close the tab. That image is stored but referenced by nothing - it will never
// be reviewed, never be purged by the approval flow, and nobody will ever know
// it is there. Left alone, these accumulate indefinitely.
//
// The sweeper deletes stored objects that no registration points at, once they
// are old enough that an in-progress submission cannot still be relying on one.

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

async function sweepOrphanedUploads() {
  const cutoff = new Date(Date.now() - config.ORPHAN_UPLOAD_TTL_MINUTES * 60 * 1000);

  const stored = await storage.list();
  const candidates = stored.filter((entry) => entry.modifiedAt && entry.modifiedAt < cutoff);
  if (candidates.length === 0) return { scanned: stored.length, deleted: 0 };

  // One query for the whole batch rather than a lookup per file.
  const referenced = await prisma.registration.findMany({
    where: { idDocumentKey: { in: candidates.map((entry) => entry.key) } },
    select: { idDocumentKey: true },
  });
  const referencedKeys = new Set(referenced.map((row) => row.idDocumentKey));

  let deleted = 0;
  for (const entry of candidates) {
    if (referencedKeys.has(entry.key)) continue;
    try {
      await storage.remove(entry.key);
      deleted += 1;
    } catch (err) {
      logger.error({ err: err.message, key: entry.key }, 'Failed to delete orphaned upload');
    }
  }

  if (deleted > 0) {
    logger.info({ deleted, scanned: stored.length }, 'Swept orphaned ID uploads');
  }
  return { scanned: stored.length, deleted };
}

// Returns a stop function so shutdown can clear the timer.
function startOrphanSweeper() {
  const run = () => {
    sweepOrphanedUploads().catch((err) => {
      logger.error({ err: err.message }, 'Orphan sweep failed');
    });
  };

  // Not on boot: a fresh deploy has better things to do than walk the bucket.
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}

module.exports = { sweepOrphanedUploads, startOrphanSweeper };
