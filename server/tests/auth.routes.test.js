import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { loadAppWithPrismaMock } from './helpers/app.js';

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
