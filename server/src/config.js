require('dotenv').config();
const { z } = require('zod');

// Configuration is validated once, at boot. A missing or nonsensical value
// should stop the process immediately with a readable message - not surface
// hours later as a 500 on a guest's submission.

const isProduction = process.env.NODE_ENV === 'production';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // A short secret is worse than no secret at all, because it looks fine.
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('12h'),

    // Comma-separated list of origins allowed to call the API. In production a
    // wildcard is refused outright: this API serves personal ID data.
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    // Where uploaded ID images live. 'local' keeps them on disk (fine for a
    // single VPS with a persistent volume); 's3' works anywhere.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().optional(),

    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

    // Uploads that never got attached to a submission are swept after this long.
    ORPHAN_UPLOAD_TTL_MINUTES: z.coerce.number().int().positive().default(120),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // Path to the client's built assets. When set, this process serves the app
    // as well as the API, from one origin - which means no CORS to configure,
    // no API URL baked into the bundle at build time, and one service to deploy
    // instead of two. Leave it unset to serve the API alone behind nginx or a
    // separate static host, which is what docker-compose.yml does.
    CLIENT_DIST_DIR: z.string().optional(),

    // Set only on a serverless deployment, where the orphan sweep is driven by
    // a scheduled request rather than an interval. Without it the maintenance
    // route is not mounted. Must be long enough not to be guessable.
    CRON_SECRET: z.string().min(24, 'CRON_SECRET must be at least 24 characters').optional(),

    RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

    // Both public budgets are per-IP, and guests fill the form on the hotel's
    // wifi - so one budget covers everyone checking in at once, not one guest.
    // At the old 30 and 15 an afternoon's arrivals would lock each other out.
    //
    // The scan budget could afford to be tight when a decode cost a second or
    // more of CPU. It now costs about a tenth of that (see qrDecoder.service),
    // so 120 scans per window is less work than the old 15 ever was.
    RATE_LIMIT_PUBLIC_MAX: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_SCAN_MAX: z.coerce.number().int().positive().default(120),

    // Deliberately not raised. This one is a credential-guessing control, and
    // a successful sign-in does not count against it, so real staff never meet it.
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),

    // Signed-in staff, counted per account rather than per IP. A reviewer opens
    // a registration, loads its ID image and saves it - three calls per guest -
    // so this needs headroom a public budget does not.
    RATE_LIMIT_STAFF_MAX: z.coerce.number().int().positive().default(600),

    // Trust N proxy hops for client IPs. Rate limiting is only as honest as
    // this value: too high and any client can spoof its own address.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=s3`,
          });
        }
      }
    }

    // Serverless platforms give a function a read-only filesystem with one
    // writable directory, /tmp, whose contents do not survive to the next
    // invocation. The local driver would fail creating its upload directory at
    // boot, which surfaces as every request 500ing with no obvious cause. Say
    // so here instead, while the message can still name the fix.
    if (env.STORAGE_DRIVER === 'local' && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)) {
      const uploadDir = env.UPLOAD_DIR || '';
      if (!uploadDir.startsWith('/tmp')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_DRIVER'],
          message:
            'STORAGE_DRIVER=local cannot work on a serverless platform: the filesystem is read-only apart from /tmp, and /tmp is not shared between invocations. Set STORAGE_DRIVER=s3, or UPLOAD_DIR=/tmp/uploads for a throwaway demo where a guest\'s ID photo may be gone by the time staff open it.',
        });
      }
    }

    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.trim() === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS may not be "*" in production - list the real origins',
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${details}\n`);
  process.exit(1);
}

const env = parsed.data;

const config = {
  ...env,
  isProduction,
  isTest: env.NODE_ENV === 'test',
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

module.exports = config;
