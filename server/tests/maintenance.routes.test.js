// Set before the app loads: config is read once at module load, and the
// maintenance route is only mounted when a secret exists.
process.env.CRON_SECRET = 'cron-secret-long-enough-to-pass-validation';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { loadAppWithPrismaMock } from './helpers/app.js';

const require = createRequire(import.meta.url);
const { storage } = require('../src/lib/storage');

const { app, prisma } = loadAppWithPrismaMock();

const SECRET = process.env.CRON_SECRET;
const OLD = new Date(Date.now() - 48 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(storage, 'list').mockResolvedValue([
    { key: 'orphan.png', modifiedAt: OLD },
    { key: 'attached.png', modifiedAt: OLD },
  ]);
  vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
  // Only one of the two is pointed at by a registration.
  prisma.registration.findMany.mockResolvedValue([{ idDocumentKey: 'attached.png' }]);
});

describe('the scheduled orphan sweep', () => {
  it('deletes an unreferenced upload and leaves an attached one alone', async () => {
    const res = await request(app)
      .post('/api/maintenance/sweep-orphans')
      .set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: 1 });
    expect(storage.remove).toHaveBeenCalledWith('orphan.png');
    expect(storage.remove).not.toHaveBeenCalledWith('attached.png');
  });

  // An image referenced only as a registration's back side is still referenced.
  // Sweeping it would delete a guest's address page out from under a reviewer,
  // silently, hours after they submitted it.
  it('leaves an image alone when a registration holds it as its back side', async () => {
    storage.list.mockResolvedValue([
      { key: 'orphan.png', modifiedAt: OLD },
      { key: 'back-only.png', modifiedAt: OLD },
    ]);
    prisma.registration.findMany.mockResolvedValue([
      { idDocumentKey: 'some-front.png', idDocumentBackKey: 'back-only.png' },
    ]);

    const res = await request(app)
      .post('/api/maintenance/sweep-orphans')
      .set('Authorization', `Bearer ${SECRET}`);

    expect(res.body).toMatchObject({ ok: true, deleted: 1 });
    expect(storage.remove).toHaveBeenCalledWith('orphan.png');
    expect(storage.remove).not.toHaveBeenCalledWith('back-only.png');
  });

  // Vercel Cron issues GET, so the endpoint has to answer one.
  it('runs from a GET, which is what the scheduler sends', async () => {
    const res = await request(app)
      .get('/api/maintenance/sweep-orphans')
      .set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith('orphan.png');
  });

  // This endpoint deletes stored objects. An unauthenticated caller should not
  // be able to drive it, nor learn that the path exists.
  it.each([
    ['no header at all', undefined],
    ['the wrong secret', 'Bearer not-the-cron-secret-but-same-ish-length'],
    ['a bare token with no scheme', 'cron-secret-long-enough-to-pass-validation'],
    ['an empty bearer', 'Bearer '],
  ])('answers 404 and sweeps nothing given %s', async (_label, header) => {
    const req = request(app).post('/api/maintenance/sweep-orphans');
    if (header !== undefined) req.set('Authorization', header);

    const res = await req;

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
