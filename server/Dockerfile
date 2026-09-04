# syntax=docker/dockerfile:1

# ---- dependencies ----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` needs the lockfile to match package.json exactly, which is what makes
# an image reproducible rather than "whatever npm resolved on build day".
RUN npm ci --omit=dev

# ---- prisma client ---------------------------------------------------------
FROM node:22-alpine AS prisma
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# dumb-init reaps zombies and forwards SIGTERM, so the graceful shutdown in
# src/index.js actually runs when the orchestrator stops the container.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY --from=prisma /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=prisma /app/node_modules/@prisma ./node_modules/@prisma
COPY package.json ./
COPY prisma ./prisma
COPY src ./src
# `npm run staff -- disable <email>` is how an account is shut off in a hurry.
# It has to be present in the image, or that only works on a developer's laptop.
COPY scripts ./scripts

# The local storage driver writes here. On a platform with an ephemeral disk,
# mount a volume or switch to STORAGE_DRIVER=s3 - otherwise every deploy
# discards ID images that have not yet been reviewed.
RUN mkdir -p /app/uploads && chown -R node:node /app

# Never run the process that handles ID documents as root.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
