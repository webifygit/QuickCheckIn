# syntax=docker/dockerfile:1
#
# One image, one service: the API and the built client from a single process on
# a single origin. This is the image to deploy on Render, Railway, Fly or a VPS.
#
#   docker build -t quickcheckin .
#   docker run -p 4000:4000 --env-file server/.env quickcheckin
#
# The two-service split (server/Dockerfile + client/Dockerfile behind nginx) is
# still there and still supported - see docker-compose.yml. Use that when the
# client is served by a CDN or a separate static host. Use this one when you
# want the smallest number of moving parts, which for a single property is
# almost always the right trade.

# ---- client bundle ---------------------------------------------------------
FROM node:22-alpine AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
# Empty on purpose. Vite inlines this at build time, and an empty value means
# "same origin" - the app calls /api/... on whatever host served the page, so
# one image works on localhost, a preview URL and the real domain without a
# rebuild. Setting it to a URL here would pin the bundle to that one host.
ENV VITE_API_BASE_URL=""
RUN npm run build

# ---- server dependencies ---------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
# `npm ci` needs the lockfile to match package.json exactly, which is what makes
# an image reproducible rather than "whatever npm resolved on build day".
#
# The prisma CLI is a runtime dependency rather than a dev one precisely so that
# it survives --omit=dev: the container runs `prisma migrate deploy` before it
# serves traffic, and without the CLI in the image npx would fetch it from the
# registry on every single boot - slow at best, and a failed start on a platform
# with no outbound network.
RUN npm ci --omit=dev

# ---- prisma client ---------------------------------------------------------
FROM node:22-alpine AS prisma
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/prisma ./prisma
RUN npx prisma generate

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
# Where the runtime looks for the client build. Serving it from this process is
# what removes CORS configuration and a second deployment from the picture.
ENV CLIENT_DIST_DIR=/app/client-dist

# dumb-init reaps zombies and forwards SIGTERM, so the graceful shutdown in
# src/index.js actually runs when the orchestrator stops the container.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY --from=prisma /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=prisma /app/node_modules/@prisma ./node_modules/@prisma
COPY server/package.json ./
COPY server/prisma ./prisma
COPY server/src ./src
# `npm run staff -- disable <email>` is how an account is shut off in a hurry.
# It has to be present in the image, or that only works on a developer's laptop.
COPY server/scripts ./scripts
COPY --from=client /client/dist ./client-dist

# The local storage driver writes here. On a platform with an ephemeral disk,
# mount a volume or switch to STORAGE_DRIVER=s3 - otherwise every deploy
# discards ID images that have not yet been reviewed.
RUN mkdir -p /app/uploads && chown -R node:node /app

# Never run the process that handles ID documents as root.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# Migrations run before the server accepts traffic. `migrate deploy` only applies
# committed migrations - it never generates or resets anything.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
