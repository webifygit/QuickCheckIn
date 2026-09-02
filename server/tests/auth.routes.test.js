import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { loadAppWithPrismaMock, mockSignedInStaff, signStaffToken, STAFF_ROW } from './helpers/app.js';

const { app, prisma } = loadAppWithPrismaMock();

const PASSWORD = 'CorrectHorse123!';
const staff = {
  id: 'staff_1',
  email: 'admin@hotel.local',
  name: 'Front Desk Admin',
  passwordHash: bcrypt.hashSync(PASSWORD, 4),
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.staffUser.findUnique.mockResolvedValue(staff);
});

describe('POST /api/auth/login', () => {
  it('rejects a request with no credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({});

    expect(res.status).toBe(400);
    expect(prisma.staffUser.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a request missing the password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: staff.email });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown email with the same message as a wrong password', async () => {
    prisma.staffUser.findUnique.mockResolvedValue(null);
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@hotel.local', password: PASSWORD });

    prisma.staffUser.findUnique.mockResolvedValue(staff);
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: 'wrong-password' });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    // Identical responses, so the endpoint does not reveal which emails exist.
    expect(unknown.body).toEqual(wrongPassword.body);
  });

  it('issues a staff token on valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: PASSWORD });

    expect(res.status).toBe(200);

    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(payload.staffId).toBe(staff.id);
    expect(payload.email).toBe(staff.email);
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('mints the token at the account current session generation', async () => {
    prisma.staffUser.findUnique.mockResolvedValue({ ...staff, tokenVersion: 3 });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: PASSWORD });

    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    // Signing in after a bump has to produce a token that survives it -
    // otherwise ending someone's sessions would lock them out for good.
    expect(payload.ver).toBe(3);
  });

  it('never returns the password hash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: PASSWORD });

    expect(res.body.staff).toEqual({ id: staff.id, email: staff.email, name: staff.name });
    expect(JSON.stringify(res.body)).not.toContain(staff.passwordHash);
  });

  it('does not accept a token signed with a different secret', async () => {
    const forged = jwt.sign({ staffId: 'attacker' }, 'some-other-secret');
    const res = await request(app).get('/api/registrations').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });
});

// A signature that still verifies says nothing about whether the account behind
// it is still allowed in. These are about what happens between issuing a token
// and its expiry - see requireStaffAuth.
describe('staff sessions end before the token expires', () => {
  const PROTECTED = '/api/registrations';

  beforeEach(() => {
    prisma.registration.findMany.mockResolvedValue([]);
    prisma.registration.count.mockResolvedValue(0);
  });

  it('lets a current session through', async () => {
    mockSignedInStaff(prisma);

    const res = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${signStaffToken()}`);

    expect(res.status).toBe(200);
  });

  it('locks out an account disabled mid-session, without waiting for expiry', async () => {
    const token = signStaffToken();
    mockSignedInStaff(prisma, { isActive: false });

    const res = await request(app).get(PROTECTED).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    // The point of the whole change: no registration data was read for them.
    expect(prisma.registration.findMany).not.toHaveBeenCalled();
  });

  it('rejects a token from an earlier session generation', async () => {
    const stale = signStaffToken({ ver: 0 });
    mockSignedInStaff(prisma, { tokenVersion: 1 });

    const res = await request(app).get(PROTECTED).set('Authorization', `Bearer ${stale}`);

    expect(res.status).toBe(401);
    expect(prisma.registration.findMany).not.toHaveBeenCalled();
  });

  it('rejects a token whose account no longer exists', async () => {
    prisma.staffUser.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${signStaffToken()}`);

    expect(res.status).toBe(401);
  });

  it('rejects a token minted before session generations existed', async () => {
    // No ver claim. Treating that as generation 0 would let a pre-upgrade token
    // outlive the very bump meant to kill it.
    const legacy = jwt.sign(
      { staffId: STAFF_ROW.id, email: STAFF_ROW.email, name: STAFF_ROW.name },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    mockSignedInStaff(prisma);

    const res = await request(app).get(PROTECTED).set('Authorization', `Bearer ${legacy}`);

    expect(res.status).toBe(401);
  });

  it('does not sign everyone out when the database is unreachable', async () => {
    prisma.staffUser.findUnique.mockRejectedValue(new Error('connection refused'));

    const res = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${signStaffToken()}`);

    // 500, not 401: a database blip is not a revocation, and answering 401
    // would sign every member of staff out of a working session.
    expect(res.status).toBe(500);
  });

  it('trusts the account row over the token for identity', async () => {
    const token = signStaffToken({ name: 'Old Name', email: 'old@hotel.local' });
    mockSignedInStaff(prisma, { name: 'New Name', email: 'new@hotel.local' });
    prisma.registration.findUnique.mockResolvedValue({ id: 'reg_1', status: 'PENDING' });
    prisma.registration.update.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));

    await request(app)
      .patch('/api/registrations/reg_1')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'APPROVED' });

    const { data } = prisma.registration.update.mock.calls[0][0];
    expect(data.reviewedByStaffId).toBe(STAFF_ROW.id);
  });
});
