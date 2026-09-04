import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createRequire } from 'node:module';
import { loadAppWithPrismaMock, mockSignedInStaff, signStaffToken, STAFF_ROW } from './helpers/app.js';

const require = createRequire(import.meta.url);
const { storage } = require('../src/lib/storage');

const { app, prisma } = loadAppWithPrismaMock();

const STAFF = { staffId: STAFF_ROW.id, email: STAFF_ROW.email, name: STAFF_ROW.name };
const token = signStaffToken();
const auth = (req) => req.set('Authorization', `Bearer ${token}`);

const validGuest = { fullName: 'Asha Kulkarni', phone: '9876543210', consentGiven: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockSignedInStaff(prisma);
  prisma.registration.create.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));
  prisma.registration.update.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));
  prisma.registration.findMany.mockResolvedValue([]);
  prisma.registration.count.mockResolvedValue(0);
  prisma.registration.findUnique.mockResolvedValue({ id: 'reg_1', fullName: 'Asha Kulkarni' });
});

describe('ID images are never exposed publicly', () => {
  it('does not serve uploads from a static path', async () => {
    const res = await request(app).get('/uploads/anything.png');
    expect(res.status).toBe(404);
  });

  it('requires a staff token to fetch a registration document', async () => {
    const res = await request(app).get('/api/registrations/reg_1/document');
    expect(res.status).toBe(401);
  });

  it('never returns the storage key in an API response', async () => {
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      fullName: 'Asha Kulkarni',
      idDocumentKey: '1788245002600-7a5fbbc0520ff8dd7a5fbbc0520ff8dd.png',
    });

    const res = await auth(request(app).get('/api/registrations/reg_1'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('7a5fbbc0520ff8dd');
    // Staff still need to know whether there is an image to look at.
    expect(res.body.hasIdDocument).toBe(true);
  });

  it('serves the image to signed-in staff with caching disabled', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    const key = await storage.save(png, 'image/png');
    prisma.registration.findUnique.mockResolvedValue({ id: 'reg_1', idDocumentKey: key });

    const res = await auth(request(app).get('/api/registrations/reg_1/document'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('explains that the image was deleted rather than pretending it never existed', async () => {
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      idDocumentKey: null,
      idDocumentDeletedAt: new Date(),
    });

    const res = await auth(request(app).get('/api/registrations/reg_1/document'));

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/deleted after this registration was reviewed/i);
  });
});

describe('ID images are purged once a reviewer has decided', () => {
  it.each(['APPROVED', 'CHECKED_IN', 'REJECTED'])(
    'deletes the stored image when moved to %s',
    async (status) => {
      const key = await storage.save(Buffer.from('pretend-image'), 'image/png');
      prisma.registration.findUnique.mockResolvedValue({
        id: 'reg_1',
        status: 'PENDING',
        idDocumentKey: key,
      });

      const res = await auth(request(app).patch('/api/registrations/reg_1').send({ status }));

      expect(res.status).toBe(200);
      const { data } = prisma.registration.update.mock.calls[0][0];
      expect(data.idDocumentKey).toBeNull();
      expect(data.idDocumentDeletedAt).toBeInstanceOf(Date);
      // Gone from storage too, not merely unlinked from the row.
      expect(await storage.read(key)).toBeNull();
    }
  );

  it('keeps the image while the registration is still pending', async () => {
    const key = await storage.save(Buffer.from('pretend-image'), 'image/png');
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      status: 'PENDING',
      idDocumentKey: key,
    });

    await auth(request(app).patch('/api/registrations/reg_1').send({ phone: '9000000000' }));

    expect(await storage.read(key)).not.toBeNull();
  });

  it('records who approved it and when, from the token', async () => {
    prisma.registration.findUnique.mockResolvedValue({ id: 'reg_1', status: 'PENDING' });

    await auth(request(app).patch('/api/registrations/reg_1').send({ status: 'APPROVED' }));

    const { data } = prisma.registration.update.mock.calls[0][0];
    expect(data.reviewedByStaffId).toBe(STAFF.staffId);
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });
});

describe('input validation', () => {
  it('refuses a document reference the server did not mint', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, idDocumentKey: '../../../server/.env' });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.idDocumentKey).toMatch(/invalid document reference/i);
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('refuses a stay that ends before it starts', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, checkInDate: '2026-09-10', checkOutDate: '2026-09-01' });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.checkOutDate).toMatch(/before check-in/i);
  });

  it('validates a new check-out date against the stored check-in date', async () => {
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      status: 'PENDING',
      checkInDate: new Date('2026-09-10'),
    });

    const res = await auth(
      request(app).patch('/api/registrations/reg_1').send({ checkOutDate: '2026-09-01' })
    );

    expect(res.status).toBe(400);
  });

  it('rejects an unknown status with a 400 rather than a 500', async () => {
    const res = await auth(
      request(app).patch('/api/registrations/reg_1').send({ status: 'DEFINITELY_NOT_A_STATUS' })
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown status/i);
  });

  it('rejects an unknown status filter on the list endpoint', async () => {
    const res = await auth(request(app).get('/api/registrations?status=NONSENSE'));

    expect(res.status).toBe(400);
    expect(prisma.registration.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['email', 'not-an-email'],
    ['numberOfGuests', '21'],
  ])('rejects an implausible %s', async (field, value) => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, [field]: value });

    expect(res.status).toBe(400);
  });

  it.each(['12', '+91 98765 43210', '(022) 2555-1234'])('accepts %s as a phone number', async (phone) => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, phone });

    // '12' is too short to dial; the other two are real formats guests use.
    expect(res.status).toBe(phone === '12' ? 400 : 201);
  });

  it('returns per-field errors the form can attach to the right input', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ fullName: '', phone: 'abc', consentGiven: true });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toHaveProperty('fullName');
    expect(res.body.fieldErrors).toHaveProperty('phone');
  });
});

describe('error handling', () => {
  it('does not leak internal error detail to the caller', async () => {
    prisma.registration.findUnique.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 db=quickcheckin user=admin')
    );

    const res = await auth(request(app).get('/api/registrations/reg_1'));

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    // A request id the guest can quote when reporting the failure.
    expect(res.body.requestId).toBeTruthy();
  });

  it('answers an async database failure instead of hanging the request', async () => {
    prisma.registration.findMany.mockRejectedValue(new Error('connection lost'));

    const res = await auth(request(app).get('/api/registrations'));

    expect(res.status).toBe(500);
  });

  it('404s an unknown route as JSON', async () => {
    const res = await request(app).get('/api/nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
