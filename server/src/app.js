// Patches Express 4 so a rejected promise in an async route reaches the error
// handler instead of hanging the request forever. Must be required before the
// routes are defined.
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const logger = require('./lib/logger');
const prisma = require('./prismaClient');
const authRoutes = require('./routes/auth.routes');
const documentRoutes = require('./routes/document.routes');
const registrationsRoutes = require('./routes/registrations.routes');
const { loginLimiter, scanLimiter } = require('./middleware/rateLimit.middleware');

const app = express();

// Rate limiting keys on the client IP, which behind a proxy arrives in
// X-Forwarded-For. Trusting a specific hop count - rather than `true` - stops a
// client from prepending a fake address and getting a fresh quota per request.
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.disable('x-powered-by');

// Set when this process is also serving the built client, which changes what
// the security headers have to say: a policy written for a JSON API is wrong
// for an HTML page, and vice versa.
const clientDist = config.CLIENT_DIST_DIR ? path.resolve(config.CLIENT_DIST_DIR) : null;
const servesClient = Boolean(clientDist && fs.existsSync(path.join(clientDist, 'index.html')));

app.use(
  helmet({
    // A page this process serves gets a real policy. Serving only JSON and
    // images, there is no document for a CSP to protect, and helmet's default
    // would just be noise on every response.
    contentSecurityPolicy: servesClient
      ? {
          directives: {
            defaultSrc: ["'self'"],
            // The bundle is our own file; nothing is loaded from a CDN.
            scriptSrc: ["'self'"],
            // React sets style attributes on elements it renders, which counts
            // as inline style. Scripts stay locked down, which is the half that
            // matters.
            styleSrc: ["'self'", "'unsafe-inline'"],
            // blob: is the guest's own photo, previewed before upload without
            // it ever leaving the browser; data: covers inlined build assets.
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: config.isProduction ? [] : null,
          },
        }
      : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);

// Only the origins named in CORS_ORIGINS may call this API. The default `cors()`
// reflects any origin, which would let any site on the internet drive the
// staff API using a signed-in reviewer's browser.
//
// The delegate form is used rather than a plain origin list so the request's own
// origin can be worked out. When this process serves the client too, the page
// and the API share an origin - but the browser still sends an Origin header for
// the module script and stylesheet, because Vite marks them `crossorigin`. Judge
// those against the host actually being addressed: an origin identical to the
// one serving the page is not a cross-origin request in any meaningful sense,
// and refusing it 403s the app's own JavaScript. That failure looks like a blank
// page with no error anywhere near the cause.
app.use(
  cors((req, callback) => {
    const options = { credentials: true, maxAge: 86400 };
    const origin = req.headers.origin;

    // Non-browser callers - curl, health checks, server-to-server - send none.
    if (!origin) return callback(null, { ...options, origin: true });

    // req.protocol honours X-Forwarded-Proto only as far as TRUST_PROXY_HOPS
    // allows, so this cannot be spoofed into matching by a client claiming https.
    const selfOrigin = `${req.protocol}://${req.get('host')}`;

    if (origin === selfOrigin || config.corsOrigins.includes(origin)) {
      return callback(null, { ...options, origin: true });
    }

    return callback(new Error(`Origin ${origin} is not allowed`));
  })
);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// One id per request, echoed back in the response header, so a guest reporting
// "it failed at 4pm" can be matched to the exact log line.
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

if (!config.isTest) {
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    })
  );
}

app.use('/api/auth', loginLimiter, authRoutes);
app.use('/api/document', scanLimiter, documentRoutes);
// Deliberately no limiter here: the public POST and the staff routes inside
// this router have different callers and different budgets, so each one carries
// its own. A single limiter at the mount point would put a busy front desk on
// the guest form's quota - and behind one NAT address, the whole hotel shares it.
app.use('/api/registrations', registrationsRoutes);

// Only where a scheduler drives the orphan sweep - see maintenance.routes.js.
if (config.CRON_SECRET) {
  app.use('/api/maintenance', require('./routes/maintenance.routes'));
}

// Liveness: is the process up. Deliberately does not touch the database, so a
// database blip does not cause the orchestrator to kill a healthy container.
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Readiness: can this instance actually serve traffic.
app.get('/api/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: 'up' });
  } catch (err) {
    logger.error({ err: err.message }, 'Readiness check failed');
    res.status(503).json({ ok: false, database: 'down' });
  }
});

// The built client, when this process is serving it. Registered after the API
// routes so nothing here can shadow them, and before the JSON 404 so an unknown
// page still reaches the app's router.
if (servesClient) {
  app.use(
    express.static(clientDist, {
      // Asset filenames carry a content hash, so a cached copy can never be
      // stale. index.html has no hash and is handled below.
      maxAge: '1y',
      immutable: true,
      index: false,
    })
  );

  const indexHtml = path.join(clientDist, 'index.html');

  app.get('*', (req, res, next) => {
    // An unknown API path is a client error worth reporting as JSON. Handing it
    // the HTML shell instead would turn a typo in a fetch into a parse error
    // three layers away from the cause.
    if (req.path.startsWith('/api/')) return next();

    // Never cached: index.html names the hashed bundles, so a stale copy points
    // at asset files that no longer exist.
    res.set('Cache-Control', 'no-store');
    res.sendFile(indexHtml, (err) => (err ? next(err) : undefined));
  });

  logger.info({ clientDist }, 'Serving the built client from this process');
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Final error handler. Internal messages are logged in full but never returned:
// a Prisma error string can carry column names, connection details and fragments
// of the offending row.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.message?.startsWith('Origin ')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  logger.error({ err: err.message, stack: err.stack, requestId: req.id }, 'Unhandled request error');

  res.status(err.status || 500).json({
    error: 'Something went wrong on our end. Please try again.',
    requestId: req.id,
  });
});

module.exports = app;
