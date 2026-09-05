# QuickCheckIn — Hotel Guest Self-Registration

Guests fill out their own hotel registration via a shared link. Uploading a photo
of their Aadhaar card auto-fills the form by decoding the card's QR code. Hotel
staff review and approve submissions from a dashboard.

- `client/` — React + Vite. Guest form and staff dashboard.
- `server/` — Node/Express, Prisma ORM, Aadhaar QR decoding (`jsqr` + `jimp`).

## How auto-fill works

Aadhaar cards carry a QR code with the holder's name, date of birth, gender, and
address. The server decodes it locally — **no third-party OCR service, no API
keys, no per-scan cost, and the ID image never leaves your infrastructure.**

Two QR formats are supported:

- **Secure QR** (cards issued 2018 onwards): gzip-compressed, `0xFF`-delimited fields
- **Legacy XML QR** (older cards): `<PrintLetterBarcodeData .../>`

Reading the symbol is the hard part. A secure QR runs to about 1.5KB once the
card's photo blob is included, which puts it at roughly 137 modules across — so
on a photo of a whole card there are only three or four pixels per module to
work with, and holding the card at an angle eats what is left. Two decoders run
in order: ZXing (WebAssembly), which does perspective correction and answers in
around 100ms, then a jsQR sweep over enhanced variants as a fallback if the wasm
module is unavailable or declines the image.

To check the decoder against real cards before launch, without storing anything:

```bash
cd server
npm run scan:check -- path/to/card.jpg     # or a whole directory of them
```

It prints exactly what would have been auto-filled, and the masked ID number
rather than the full one. If the QR can't be read (old card, blurry photo,
non-Aadhaar ID), the guest simply fills the form in by hand — nothing breaks.

## How personal data is handled

This is the part that matters most, because the app holds Indian ID data.

| | |
| --- | --- |
| **Aadhaar numbers** | Stored masked to the last 4 digits (`XXXX XXXX 1234`). The full number is never written to the database or returned to a browser — masking happens on the server for every path a number arrives by: read from the card's QR, typed into the guest form, or corrected later by staff. Private entities in India generally may not store full Aadhaar numbers, and the secure QR only exposes the last 4 anyway. |
| **ID photos** | Never served from a public path. There is no static `/uploads` route. The image is streamed through `GET /api/registrations/:id/document`, which requires a staff token. |
| **Deletion** | The photo is **permanently deleted** the moment a reviewer approves, checks in, or rejects the registration. Only `idDocumentDeletedAt` remains, so an audit can see that an image existed and was disposed of. |
| **Abandoned uploads** | A guest who uploads a photo and then closes the tab leaves an image referenced by nothing. A sweeper deletes unreferenced objects older than `ORPHAN_UPLOAD_TTL_MINUTES` (default 2 hours). |
| **Logs** | Names, phone numbers, addresses, dates of birth, ID numbers and auth headers are redacted before anything is written. |

## Security posture

- **Passwords** — bcrypt, cost 12. Login runs a comparison even when the email
  does not exist, so response timing does not reveal which staff emails are real.
- **Tokens** — HS256 JWTs with a pinned algorithm (an `alg: none` token cannot
  verify). Every staff request re-reads the account, so disabling someone ends
  the session they are already in rather than waiting for `JWT_EXPIRES_IN`. Each
  token also carries the account's session generation; raising it invalidates
  every token issued before it — see [Ending a staff session](#ending-a-staff-session).
- **CORS** — locked to the origins in `CORS_ORIGINS`. A wildcard is *refused* at
  boot in production.
- **Rate limiting** — separate budgets for form submission, image scanning,
  login, and signed-in staff. The two public budgets are per-IP and sized for a
  whole property's arrivals rather than one guest, because everyone on the hotel
  wifi shares an address. The staff budget is counted per account instead, so
  one busy reviewer cannot lock out the rest of the front desk. Login is the one
  deliberately tight limit: it exists to slow password guessing, and a
  successful sign-in does not count against it.
- **Uploads** — 8MB cap, and the file's real magic bytes are checked; a renamed
  `.pdf` or script claiming `image/png` is rejected.
- **Decoding limits** — images are downscaled before decoding and gzip payloads
  are bounded, so one crafted upload cannot exhaust memory.
- **Errors** — internal messages are logged in full but never returned. Callers
  get a generic message plus a request id to quote.
- **Config** — validated at boot. A short `JWT_SECRET` or a missing `S3_BUCKET`
  stops the process with a readable message rather than failing under load.

## Setup

### 1. Database

Any Postgres works — [Neon](https://neon.tech), RDS, or the container in
`docker-compose.yml`.

### 2. Environment

```bash
cd server
cp .env.example .env
```

Every variable is documented in [`server/.env.example`](server/.env.example).
The ones you must set:

- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — at least 32 characters (`openssl rand -base64 48`)
- `SEED_STAFF_PASSWORD` — the first staff password; seeding refuses to run without it

```bash
cd ../client
cp .env.example .env
```

`VITE_API_BASE_URL=http://localhost:4000` works for local dev as-is.

### 3. Install and run

```bash
# server
cd server
npm install
npx prisma migrate deploy   # or `migrate dev` while developing
npm run seed                # creates the first staff login
npm run dev                 # http://localhost:4000

# client (separate terminal)
cd client
npm install
npm run dev                 # http://localhost:5173
```

- Guest form: `http://localhost:5173/register`
- Staff login: `http://localhost:5173/login`

## Deploying

Two shapes, and the first is the one to reach for.

### One service (recommended)

The root `Dockerfile` builds the client and the API into a single image. That
process serves both, from one origin, which removes three things that otherwise
have to be got right and each of which fails as a blank page: `CORS_ORIGINS`
does not need to name the web app, `VITE_API_BASE_URL` is not baked into the
bundle (so the same image runs on localhost, a preview URL and the real domain),
and there is one service to deploy rather than two.

```bash
docker build -t quickcheckin .
docker run -p 4000:4000 --env-file server/.env quickcheckin
```

It runs `prisma migrate deploy` before accepting traffic, serves the app at `/`
and the API under `/api/`, and answers health checks at `/api/health`
(liveness — never touches the database) and `/api/ready` (readiness — does).

On a platform that builds from a Dockerfile (Render, Railway, Fly, or a VPS),
point it at this file and set the environment below. Nothing else is needed.

### Two services

`docker-compose.yml` runs the API, a Postgres, and the client behind nginx:

```bash
docker compose up --build     # API on :4000, web on :8080
```

Use this when the client is served by a CDN or a separate static host. Here
`CORS_ORIGINS` **must** name the web origin, and `VITE_API_BASE_URL` is a build
argument, because Vite inlines it at build time.

### Vercel

`vercel.json` builds the client to the CDN and routes `/api/*` to a single
serverless function wrapping the same Express app, so it is still one origin and
`VITE_API_BASE_URL` stays empty. Two things differ from the shapes above, and
both are the platform's, not the app's:

- **Uploads are capped at 4MB.** A Vercel function cannot receive a request body
  over 4.5MB, and the scan endpoint needs the card photo at full resolution -
  the QR is around 137 modules across, so downscaling to fit is what stops it
  decoding. Set `MAX_UPLOAD_BYTES=4194304`. A guest whose photo is larger gets
  the "fill it in yourself" path rather than an error, but they do lose
  auto-fill. The Docker shape above has no such limit.
- **The orphan sweeper needs a scheduler.** There is no process to hold an
  interval, so `vercel.json` schedules an hourly request to
  `/api/maintenance/sweep-orphans`, which runs the same job. Set `CRON_SECRET`
  or that route is not mounted, and the sweep never runs.

`STORAGE_DRIVER=s3` is required here, for the reason in the table below.

### Running it for a demo, without deploying anything

One command builds the client and runs the whole app as a single process, the
same shape the container runs:

```bash
npm run demo        # http://localhost:4000 - app and API on one port
```

This is production mode: a real build, one origin, no Vite dev server and no
CORS in the picture. Use it rather than `npm run dev` when showing the app to
anyone, because it is what a deployment actually does - a bug that only appears
in the built bundle appears here too.

It occupies port 4000, so stop it before running `npm run test:e2e`, which
starts its own servers on 4000 and 5173.

### Deploy checklist

Set these, whichever shape you chose:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your Postgres connection string |
| `JWT_SECRET` | 32+ characters, `openssl rand -base64 48` |
| `TRUST_PROXY_HOPS` | `1` behind a platform router or a single nginx |
| `STORAGE_DRIVER` | see the table below — this is the decision not to skip |
| `CORS_ORIGINS` | only needed for the two-service shape |
| `CLIENT_DIST_DIR` | set by the root image already; leave it alone |

Then seed the first staff login, once, with `SEED_STAFF_PASSWORD` set in the
environment:

```bash
npm --prefix server run seed
```

Config is validated at boot, so a short `JWT_SECRET`, a wildcard `CORS_ORIGINS`
in production, or `STORAGE_DRIVER=s3` without a bucket stops the process with a
readable message instead of failing later under load.

Afterwards, three checks worth doing before you trust it:

```bash
curl -s https://your-host/api/health            # {"ok":true,...}
curl -s https://your-host/api/ready             # {"ok":true,"database":"up"}
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Origin: https://evil.example' https://your-host/api/health   # 403
```

Then open `/register` in a browser, submit one guest, and approve it from
`/login` — the whole path, on the real host, before anyone else uses it.

**The one decision you cannot skip is where ID images live.**

| Platform | Setting |
| --- | --- |
| VPS / bare metal with a persistent disk | `STORAGE_DRIVER=local` and mount a volume at `/app/uploads` |
| Render, Railway, Fly, Heroku, or anything with ephemeral disks | `STORAGE_DRIVER=s3` — **required.** Local files are discarded on every deploy, which would silently destroy ID images that have not yet been reviewed |

For `s3`, set `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY`. Any S3-compatible store works (AWS, Cloudflare R2,
Backblaze, MinIO) — set `S3_ENDPOINT` for the non-AWS ones. **Keep the bucket
private.** The app streams objects through an authenticated route and never
hands out object URLs.

Also set, in production:

- `NODE_ENV=production`
- `CORS_ORIGINS` — your real web origin, comma-separated for more than one
- `TRUST_PROXY_HOPS` — how many proxies sit in front (1 behind a single nginx or
  load balancer). Rate limiting is only as honest as this number: set it too high
  and any client can forge its own IP for a fresh quota.

Migrations run with `npx prisma migrate deploy`, which only applies committed
migrations and never resets anything. The compose file does this before the
server starts.

### Ending a staff session

Someone leaves, or a laptop goes missing, and their token is still valid for
another twelve hours. From the `server` directory:

```bash
npm run staff -- list                        # who exists, active or not
npm run staff -- disable alex@hotel.local    # blocks sign-in AND ends open sessions
npm run staff -- enable  alex@hotel.local    # lets them sign in again
npm run staff -- signout alex@hotel.local    # keeps the account, ends its sessions
npm run staff -- signout --all               # after rotating JWT_SECRET, say
```

`disable` takes effect on their next request — seconds, not hours. `signout` is
the one to use after a password reset: the account stays active, but every token
issued before it stops working.

Doing it straight in the database works too, which is the point of keeping it a
column rather than a server-side session store: `UPDATE "StaffUser" SET
"isActive" = false, "tokenVersion" = "tokenVersion" + 1 WHERE email = '...'`.

**On the deploy that first adds this**, run the migration before (or with) the
new server code — `npm run start:migrate` does both in order. New code against a
database without the `tokenVersion` column fails every staff request. Everyone
signed in at that moment has to sign in again once, because tokens issued before
the upgrade carry no session generation and are refused rather than assumed to
be generation 0.

### Health checks

- `GET /api/health` — liveness. Does not touch the database, so a database blip
  will not make an orchestrator kill a healthy container.
- `GET /api/ready` — readiness. Runs `SELECT 1`; returns 503 if the database is
  unreachable.

## Tests

```bash
npm test          # server + client suites (no database needed)
npm run test:e2e  # end-to-end in a real browser (needs the database)
npm run test:all  # everything
```

| Layer | Where | Tech | Needs a DB? |
| --- | --- | --- | --- |
| Server unit + API | `server/tests/` | Vitest, supertest, stand-in Prisma client | no |
| Client components | `client/src/**/*.test.jsx` | Vitest, Testing Library, MSW | no |
| End-to-end | `e2e/` | Playwright (Chromium) | yes |

The server tests render **real QR images** and decode them through the whole
`jimp` + `jsqr` pipeline, so the auto-fill path is covered without any fixture
photos of real Aadhaar cards. The client tests intercept HTTP with MSW rather
than stubbing modules, so the axios client and its auth interceptor run for real.

### End-to-end runs

`npm run test:e2e` starts the API and the Vite dev server itself, then drives
Chromium through the real flows. It uses the database named by
`server/.env` → `DATABASE_URL`, seeds its own staff account
(`e2e-staff@test.local`), tags every row it creates, and deletes both on
teardown — but point it at a scratch database or a Neon branch if you would
rather it never touch your working data.

First run only:

```bash
npx playwright install chromium
```

What the suites lock down:

- Both QR formats map onto the right form fields, and **Aadhaar numbers are
  never returned in full** — only `XXXX XXXX 1234`, asserted at every layer
- Unreadable, non-Aadhaar and corrupt QR codes degrade to manual entry, never a 500
- ID images are unreachable without a staff token, and the old static path is gone
- Approving deletes the image from storage, not just from the row
- Staff routes reject missing, malformed, forged and expired tokens
- Guests cannot set `status`, `id`, `reviewedByStaffId`, or point a record at a
  storage key the server did not mint
- A stay cannot end before it starts, and an unknown status is a 400, not a 500
- A database failure returns an error instead of hanging the request

## Known limitations

Worth saying plainly before this goes in front of guests:

1. **Auto-fill depends on the quality of the printed QR, and some cards will not
   read.** A genuine UIDAI secure QR has now been decoded end to end — 124ms,
   first pass, fields extracted and the Aadhaar number masked before storage.
   But the same card photographed as a whole card did *not* decode, and no
   amount of processing rescued it.

   The reason is physical. An Aadhaar secure QR is roughly 137-177 modules
   across. A photo of the whole card gives about four pixels per module, and on
   a PVC card whose ink has bled, neighbouring modules merge at that scale.
   Measured on a bench fixture, a symbol spanning 600px reads even with
   simulated bleed and 400px does not; a real card that bleeds worse failed at
   730px.

   What works, in order:

   - A **screenshot of the QR from the e-Aadhaar PDF** or the mAadhaar app. No
     camera, no lighting, no ink — perfect module edges. This is the reliable
     route and the one to tell guests about.
   - A **close-up photo of the QR alone**, filling the frame, at full camera
     resolution, no flash reflection across the code.
   - A photo of the whole card. Works on well-printed cards, fails on worn ones.

   Two traps worth knowing: sending the photo through a chat app first silently
   shrinks it (a 3MP close-up arrived as 0.6MP), and flash on a laminated card
   puts a specular highlight across the code that exceeds what its error
   correction can recover.

   Measure your own hit rate with the bundled diagnostic, which stores and
   uploads nothing and never prints a full Aadhaar number:

   ```bash
   cd server
   npm run scan:check -- ~/cards/*.jpg
   ```

2. **Revocation costs a database read per staff request.** Ending a session
   immediately means auth re-reads the account on every authenticated call — one
   primary-key lookup. Fine at front-desk traffic; if that ever becomes the
   bottleneck, cache the row for a few seconds and accept that much delay on a
   revocation. A database outage returns 500 rather than signing everyone out.
3. **Check-in and check-out are stored as timestamps**, not dates. They are
   handled consistently, but a deployment spanning timezones should move them to
   a `date` column.
4. **No audit log of staff edits.** You can see who last reviewed a registration
   and when, but not the history of what they changed.
5. **A WebP upload is stored and reviewable, but never auto-fills.** Neither
   decoder reads WebP - ZXing decodes images with stb_image, and Jimp ships
   JPEG, PNG, BMP, GIF and TIFF only. Phone cameras produce JPEG, so this is
   rare in practice, and the guest simply fills the form in. Dropping WebP from
   the accepted types would be worse: the photo is still useful to the front
   desk even when nothing can be read from it.
