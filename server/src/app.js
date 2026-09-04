// Patches Express 4 so a rejected promise in an async route reaches the error
// handler instead of hanging the request forever. Must be required before the
// routes are defined.
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const crypto = require('crypto');

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

app.use(
  helmet({
    contentSecurityPolicy: false, // The API serves JSON and images, not HTML.
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);

// Only the origins named in CORS_ORIGINS may call this API. The default `cors()`
// reflects any origin, which would let any site on the internet drive the
// staff API using a signed-in reviewer's browser.
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and non-browser callers (curl, health checks) send no Origin.
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
    maxAge: 86400,
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
