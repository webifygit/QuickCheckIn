import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  loadAppWithPrismaMock,
  mockSignedInStaff,
  signStaffToken,
  STAFF_ROW,
} from './helpers/app.js';

const { app, prisma } = loadAppWithPrismaMock();

const STAFF = { staffId: STAFF_ROW.id, email: STAFF_ROW.email, name: STAFF_ROW.name };
const token = signStaffToken();
const auth = (req) => req.set('Authorization', `Bearer ${token}`);

const validGuest = {
  fullName: 'Asha Kulkarni',
  phone: '9876543210',
  consentGiven: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSignedInStaff(prisma);
  prisma.registration.create.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));
  prisma.registration.findMany.mockResolvedValue([]);
  prisma.registration.count.mockResolvedValue(0);
  prisma.registration.findUnique.mockResolvedValue({ id: 'reg_1', fullName: 'Asha Kulkarni' });
  prisma.registration.update.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));
});

describe('POST /api/registrations (guest, unauthenticated)', () => {
  it('accepts a complete submission', async () => {
    const res = await request(app).post('/api/registrations').send(validGuest);

    expect(res.status).toBe(201);
    expect(res.body.fullName).toBe('Asha Kulkarni');
    expect(prisma.registration.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fullName', { ...validGuest, fullName: undefined }],
    ['phone', { ...validGuest, phone: undefined }],
    ['fullName (empty string)', { ...validGuest, fullName: '' }],
  ])('rejects a submission missing %s', async (_label, body) => {
    const res = await request(app).post('/api/registrations').send(body);

    expect(res.status).toBe(400);
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('rejects a submission without guest consent', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, consentGiven: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/consent/i);
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('ignores fields a guest must not be able to set', async () => {
    await request(app)
      .post('/api/registrations')
      .send({
        ...validGuest,
        id: 'chosen-by-guest',
        status: 'APPROVED',
        reviewedByStaffId: 'staff_1',
        createdAt: '2020-01-01T00:00:00.000Z',
      });

    const { data } = prisma.registration.create.mock.calls[0][0];
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('reviewedByStaffId');
    expect(data).not.toHaveProperty('createdAt');
  });

  it('accepts a submission that leaves the optional dates blank', async () => {
    // The form posts every field, so blanks arrive as empty strings. Prisma
    // rejects those outright, which used to fail the whole submission.
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, checkInDate: '', checkOutDate: '', numberOfGuests: '' });

    expect(res.status).toBe(201);
    const { data } = prisma.registration.create.mock.calls[0][0];
    expect(data.checkInDate).toBeNull();
    expect(data.checkOutDate).toBeNull();
    expect(data).not.toHaveProperty('numberOfGuests');
  });

  it.each([
    ['checkInDate', 'not-a-date'],
    ['checkOutDate', 'yesterday'],
    ['numberOfGuests', 'three'],
    ['numberOfGuests', '0'],
  ])('rejects an unusable %s (%s) with a 400', async (field, value) => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...validGuest, [field]: value });

    expect(res.status).toBe(400);
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('coerces dates and guest count to the types Prisma expects', async () => {
    await request(app)
      .post('/api/registrations')
      .send({
        ...validGuest,
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-04',
        numberOfGuests: '3',
      });

    const { data } = prisma.registration.create.mock.calls[0][0];
    expect(data.checkInDate).toBeInstanceOf(Date);
    expect(data.checkOutDate).toBeInstanceOf(Date);
    expect(data.numberOfGuests).toBe(3);
  });
});

describe('staff-only routes reject unauthenticated callers', () => {
  const staffRoutes = [
    ['get', '/api/registrations'],
    ['get', '/api/registrations/reg_1'],
    ['patch', '/api/registrations/reg_1'],
  ];

  it.each(staffRoutes)('%s %s requires a token', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  it.each(staffRoutes)('%s %s rejects a malformed header', async (method, path) => {
    const res = await request(app)[method](path).set('Authorization', token);
    expect(res.status).toBe(401);
  });

  it.each(staffRoutes)('%s %s rejects a garbage token', async (method, path) => {
    const res = await request(app)[method](path).set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it.each(staffRoutes)('%s %s rejects an expired token', async (method, path) => {
    const expired = signStaffToken({}, { expiresIn: '-1s' });
    const res = await request(app)[method](path).set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('never touches the database when the caller is unauthenticated', async () => {
    await request(app).get('/api/registrations');
    expect(prisma.registration.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/registrations', () => {
  it('lists newest first for an authenticated staff member', async () => {
    const res = await auth(request(app).get('/api/registrations'));

    expect(res.status).toBe(200);
    expect(res.body.registrations).toEqual([]);
    expect(prisma.registration.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      skip: 0,
    });
  });

  it('filters by status when asked', async () => {
    await auth(request(app).get('/api/registrations?status=PENDING'));

    expect(prisma.registration.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      skip: 0,
    });
  });
});

describe('GET /api/registrations/:id', () => {
  it('returns the registration', async () => {
    const res = await auth(request(app).get('/api/registrations/reg_1'));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('reg_1');
  });

  it('404s for an unknown id', async () => {
    prisma.registration.findUnique.mockResolvedValue(null);
    const res = await auth(request(app).get('/api/registrations/nope'));

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/registrations/:id', () => {
  it('records the reviewer from the token, not from the request body', async () => {
    await auth(
      request(app)
        .patch('/api/registrations/reg_1')
        .send({ status: 'APPROVED', reviewedByStaffId: 'someone-else' })
    );

    const { data } = prisma.registration.update.mock.calls[0][0];
    expect(data.status).toBe('APPROVED');
    expect(data.reviewedByStaffId).toBe(STAFF.staffId);
  });

  it('never takes the reviewer id from the request body', async () => {
    await auth(
      request(app)
        .patch('/api/registrations/reg_1')
        .send({ phone: '9000000000', reviewedByStaffId: 'someone-else' })
    );

    const { data } = prisma.registration.update.mock.calls[0][0];
    // No status change, so no reviewer is recorded - and certainly not the
    // one the caller asked for.
    expect(data).not.toHaveProperty('reviewedByStaffId');
  });

  it('drops fields that are not editable', async () => {
    await auth(
      request(app).patch('/api/registrations/reg_1').send({ id: 'other', createdAt: '2020-01-01' })
    );

    const { data } = prisma.registration.update.mock.calls[0][0];
    expect(data).toEqual({});
  });

  it('lets staff clear a date they entered by mistake', async () => {
    await auth(request(app).patch('/api/registrations/reg_1').send({ checkOutDate: '' }));

    const { data } = prisma.registration.update.mock.calls[0][0];
    expect(data.checkOutDate).toBeNull();
  });

  it('404s when the row does not exist', async () => {
    const notFound = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    prisma.registration.update.mockRejectedValue(notFound);
    prisma.registration.findUnique.mockResolvedValue({ id: 'nope', fullName: 'Asha Kulkarni' });
    const res = await auth(
      request(app).patch('/api/registrations/nope').send({ phone: '9000000000' })
    );

    expect(res.status).toBe(404);
  });

  it('does not disguise an unexpected database failure as a 404', async () => {
    prisma.registration.update.mockRejectedValue(new Error('connection lost'));
    const res = await auth(
      request(app).patch('/api/registrations/reg_1').send({ phone: '9000000000' })
    );

    expect(res.status).toBe(500);
  });
});
