# Hotel Guest Self-Registration

Guests fill out their own hotel registration via a shared link. Uploading a photo
of their Aadhaar card auto-fills the form by decoding the card's QR code. Hotel
staff review and approve submissions from a dashboard.

## Stack

- `client/` — React + Vite, guest-facing form + staff dashboard
- `server/` — Node/Express API, Prisma ORM, Aadhaar QR decoding (`jsqr` + `jimp`)

## How auto-fill works

Aadhaar cards carry a QR code with the holder's name, date of birth, gender, and
address. The server decodes it locally — **no third-party OCR service, no API
keys, no per-scan cost, and the ID image never leaves your server.**

Two QR formats are supported:
- **Secure QR** (cards issued 2018 onwards): gzip-compressed, `0xFF`-delimited fields
- **Legacy XML QR** (older cards): `<PrintLetterBarcodeData .../>`

If the QR can't be read (old card, blurry photo, non-Aadhaar ID), the guest
simply fills the form in by hand — nothing breaks.

**Aadhaar numbers are masked to the last 4 digits** (`XXXX XXXX 1234`) before
storage. Private entities in India generally may not store full Aadhaar numbers,
and the secure QR only exposes the last 4 anyway.

## One-time setup

### 1. Database (Postgres via Neon)

1. Create a free project at [neon.tech](https://neon.tech).
2. Copy the connection string it gives you (starts with `postgresql://...`).

### 2. Environment variables

```
cd server
cp .env.example .env
```

Edit `server/.env`:
- `DATABASE_URL` → your Neon connection string
- `JWT_SECRET` → any long random string
- `SEED_STAFF_EMAIL` / `SEED_STAFF_PASSWORD` → the first staff login you want seeded

```
cd ../client
cp .env.example .env
```

The default `VITE_API_BASE_URL=http://localhost:4000` works for local dev as-is.

## Install & run

```
# server
cd server
npm install
npx prisma migrate dev --name init
npm run seed          # creates the first staff login from .env
npm run dev            # http://localhost:4000

# client (separate terminal)
cd client
npm install
npm run dev            # http://localhost:5173
```

- Guest registration form: `http://localhost:5173/register`
- Staff login: `http://localhost:5173/login` (use the credentials from `npm run seed`)
- Staff dashboard: `http://localhost:5173/dashboard`

## Tests

Three layers, each runnable on its own:

```
npm test          # server + client unit/integration suites (no database needed)
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
Chromium through the real flows: guest scans a card and submits, staff sign in,
correct a detail, approve, and filter the dashboard.

It uses the database named by `server/.env` → `DATABASE_URL`. It seeds its own
staff account (`e2e-staff@test.local`), tags every row it creates, and deletes
both on teardown — but point it at a scratch database or a Neon branch if you
would rather it never touch your working data.

First run only:

```
npx playwright install chromium
```

What the suite locks down:

- Both QR formats map onto the right form fields, and **Aadhaar numbers are
  never returned in full** — only `XXXX XXXX 1234`, asserted at every layer
- Unreadable, non-Aadhaar and corrupt QR codes degrade to manual entry, never a 500
- Optional dates and guest counts may be left blank
- Staff routes reject missing, malformed, forged and expired tokens; a stale
  token drops the user back at the login screen
- Guests cannot set `status`, `id` or `reviewedByStaffId` on their own
  submission; the reviewer is always taken from the staff token

## Notes

- Auto-filled fields are always editable — guests review and correct them before
  submitting, and staff can edit again from the dashboard.
- Uploaded ID images are stored under `server/uploads/`. This is fine for local
  use; swap for S3/GCS storage before any real production deployment, since
  these files contain sensitive personal ID data.
- To view/edit the database directly: `cd server && npx prisma studio`.
