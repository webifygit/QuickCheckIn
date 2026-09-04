import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { loadAppWithPrismaMock, mockSignedInStaff, signStaffToken } from './helpers/app.js';

const require = createRequire(import.meta.url);
const { maskAadhaarNumber, looksLikeAadhaar } = require('../src/lib/idNumber');

const { app, prisma } = loadAppWithPrismaMock();
const auth = (req) => req.set('Authorization', `Bearer ${signStaffToken()}`);

const guest = { fullName: 'Asha Kulkarni', phone: '9876543210', consentGiven: true };

// What actually reached Prisma, which is the only thing that matters here - a
// response that looks masked while the row holds twelve digits is the bug.
const written = (mock) => mock.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  mockSignedInStaff(prisma);
  prisma.registration.create.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));
  prisma.registration.update.mockImplementation(async ({ data }) => ({ id: 'reg_1', ...data }));
  prisma.registration.findUnique.mockResolvedValue({
    id: 'reg_1',
    status: 'PENDING',
    idType: 'AADHAAR',
  });
});

describe('maskAadhaarNumber', () => {
  it.each([
    ['123456789012', 'XXXX XXXX 9012'],
    ['1234 5678 9012', 'XXXX XXXX 9012'],
    ['1234-5678-9012', 'XXXX XXXX 9012'],
    ['XXXX XXXX 9012', 'XXXX XXXX 9012'],
  ])('reduces %s to its last four digits', (input, expected) => {
    expect(maskAadhaarNumber(input)).toBe(expected);
  });

  it('returns null when there is not even a last-four to keep', () => {
    expect(maskAadhaarNumber('12')).toBeNull();
    expect(maskAadhaarNumber('')).toBeNull();
  });

  it('accepts the twelve printed digits or the masked form, nothing else', () => {
    expect(looksLikeAadhaar('123456789012')).toBe(true);
    expect(looksLikeAadhaar('XXXX XXXX 9012')).toBe(true);
    expect(looksLikeAadhaar('12345678901')).toBe(false);
    expect(looksLikeAadhaar('A123456789012')).toBe(false);
  });
});

describe('a guest typing their Aadhaar number in by hand', () => {
  it('never lets the full number reach the database', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...guest, idType: 'AADHAAR', idNumber: '1234 5678 9012' });

    expect(res.status).toBe(201);
    expect(written(prisma.registration.create).idNumber).toBe('XXXX XXXX 9012');
    expect(res.body.idNumber).toBe('XXXX XXXX 9012');
  });

  // idType is NOT NULL with an AADHAAR default, so leaving it off must not be a
  // way around the masking.
  it('masks even when idType is left to the default', async () => {
    await request(app).post('/api/registrations').send({ ...guest, idNumber: '123456789012' });

    expect(written(prisma.registration.create).idNumber).toBe('XXXX XXXX 9012');
  });

  it('rejects a number that is not twelve digits rather than truncating it', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...guest, idType: 'AADHAAR', idNumber: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.idNumber).toMatch(/12-digit/i);
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('leaves other kinds of ID alone - a passport number is not an Aadhaar number', async () => {
    await request(app)
      .post('/api/registrations')
      .send({ ...guest, idType: 'PASSPORT', idNumber: 'Z1234567' });

    expect(written(prisma.registration.create).idNumber).toBe('Z1234567');
  });
});

describe('staff correcting a registration', () => {
  it('masks a full number typed into the review form', async () => {
    const res = await auth(
      request(app).patch('/api/registrations/reg_1').send({ idNumber: '123456789012' })
    );

    expect(res.status).toBe(200);
    expect(written(prisma.registration.update).idNumber).toBe('XXXX XXXX 9012');
  });

  it('accepts the stored masked value unchanged on re-save', async () => {
    await auth(
      request(app).patch('/api/registrations/reg_1').send({ idNumber: 'XXXX XXXX 9012' })
    );

    expect(written(prisma.registration.update).idNumber).toBe('XXXX XXXX 9012');
  });

  // The record says AADHAAR even though this request does not mention idType.
  it('uses the stored idType when the payload omits it', async () => {
    await auth(request(app).patch('/api/registrations/reg_1').send({ idNumber: '111122223333' }));

    expect(written(prisma.registration.update).idNumber).toBe('XXXX XXXX 3333');
  });
});

describe('fields staff may not rewrite', () => {
  it('ignores an attempt to re-point the record at another stored image', async () => {
    const key = `${Date.now()}-${'a'.repeat(32)}.jpg`;

    await auth(request(app).patch('/api/registrations/reg_1').send({ idDocumentKey: key }));

    expect(written(prisma.registration.update)).not.toHaveProperty('idDocumentKey');
  });

  it('ignores an attempt to rewrite the guest consent record', async () => {
    await auth(request(app).patch('/api/registrations/reg_1').send({ consentGiven: false }));

    expect(written(prisma.registration.update)).not.toHaveProperty('consentGiven');
  });
});

describe('changing the kind of ID on an existing record', () => {
  // Masking whatever was stored would throw away digits nobody can recover, and
  // leaving it would hold a full number under an Aadhaar label. Neither is
  // acceptable, so the reviewer is asked for the number.
  it('refuses to relabel a passport record as Aadhaar without the number', async () => {
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      status: 'PENDING',
      idType: 'PASSPORT',
      idNumber: 'Z1234567',
    });

    const res = await auth(
      request(app).patch('/api/registrations/reg_1').send({ idType: 'AADHAAR' })
    );

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.idNumber).toMatch(/12-digit/i);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('accepts the relabelling when the Aadhaar number comes with it', async () => {
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      status: 'PENDING',
      idType: 'PASSPORT',
      idNumber: 'Z1234567',
    });

    const res = await auth(
      request(app)
        .patch('/api/registrations/reg_1')
        .send({ idType: 'AADHAAR', idNumber: '999988887777' })
    );

    expect(res.status).toBe(200);
    expect(written(prisma.registration.update).idNumber).toBe('XXXX XXXX 7777');
  });

  // The other direction: a record wrongly marked Aadhaar is relabelled, and the
  // masked value it holds is not an error to be corrected.
  it('leaves an already-masked value alone when moving away from Aadhaar', async () => {
    prisma.registration.findUnique.mockResolvedValue({
      id: 'reg_1',
      status: 'PENDING',
      idType: 'AADHAAR',
      idNumber: 'XXXX XXXX 9012',
    });

    const res = await auth(
      request(app).patch('/api/registrations/reg_1').send({ idType: 'VOTER_ID' })
    );

    expect(res.status).toBe(200);
    expect(written(prisma.registration.update)).not.toHaveProperty('idNumber');
  });
});

describe('IDs that are not Aadhaar', () => {
  // A PAN card carries no Aadhaar QR, so it can never auto-fill - but it is one
  // of the commonest IDs at an Indian front desk and has to be recordable as
  // itself rather than as "Other".
  it('accepts a PAN card and stores its number as given', async () => {
    const res = await request(app)
      .post('/api/registrations')
      .send({ ...guest, idType: 'PAN', idNumber: 'ABCDE1234F' });

    expect(res.status).toBe(201);
    expect(written(prisma.registration.create).idType).toBe('PAN');
    expect(written(prisma.registration.create).idNumber).toBe('ABCDE1234F');
  });
});
