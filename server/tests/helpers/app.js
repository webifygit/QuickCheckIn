import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';

// The server is CommonJS, so it is loaded with a native require here - that way
// the tests and the controllers share one module registry, and swapping the
// Prisma client below actually reaches the code under test.
const require = createRequire(import.meta.url);

export function createPrismaMock() {
  return {
    staffUser: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    registration: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
  };
}

// Loads the Express app with a stand-in Prisma client, so route tests exercise
// real routing, middleware and validation without needing a database.
export function loadAppWithPrismaMock() {
  const prisma = createPrismaMock();
  require('../../src/prismaClient').setPrisma(prisma);
  const app = require('../../src/app');
  return { app, prisma };
}

// The account behind an authenticated test request. Auth re-reads it on every
// call, so a test that signs in has to have an account to be found.
export const STAFF_ROW = {
  id: 'staff_1',
  email: 'admin@hotel.local',
  name: 'Front Desk Admin',
  isActive: true,
  tokenVersion: 0,
};

// A token for STAFF_ROW. Pass claim overrides to forge a stale one (`{ ver: 0 }`
// against a bumped account) or a token for an account that no longer exists.
export function signStaffToken(claims = {}, options = {}) {
  return jwt.sign(
    {
      staffId: STAFF_ROW.id,
      email: STAFF_ROW.email,
      name: STAFF_ROW.name,
      ver: STAFF_ROW.tokenVersion,
      ...claims,
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h', ...options }
  );
}

// Makes the staff lookup in requireStaffAuth resolve. Overrides let a test
// disable the account or move its session generation on.
export function mockSignedInStaff(prisma, overrides = {}) {
  prisma.staffUser.findUnique.mockResolvedValue({ ...STAFF_ROW, ...overrides });
}
