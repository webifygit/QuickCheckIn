// Serverless entry point for Vercel.
//
// src/index.js owns the long-lived process: it listens on a port, runs the
// orphan sweeper on an interval, and handles SIGTERM. None of that applies
// here - Vercel invokes the exported handler and may freeze or discard the
// instance between requests - so this file wires up the same Express app
// without any of it, and the sweeper runs from a scheduled request instead
// (see vercel.json's crons and routes/maintenance.routes.js).
const app = require('../src/app');
const { storage } = require('../src/lib/storage');
const { initQrDecoder } = require('../src/services/qrDecoder.service');

// A cold start pays for both of these once; every later request on the same
// warm instance awaits an already-settled promise. They are deliberately not
// awaited at module load: a rejection there is reported as an opaque
// "function crashed" with no stack, whereas awaiting inside the handler
// surfaces the real error through the app's own error handling.
let ready = null;
function ensureReady() {
  if (!ready) {
    ready = Promise.all([storage.init(), initQrDecoder()]).catch((err) => {
      // Let the next invocation try again rather than caching the failure for
      // the life of the instance.
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = async (req, res) => {
  await ensureReady();
  return app(req, res);
};
