import { createRequire } from 'node:module';
import { vi } from 'vitest';

// The server is CommonJS, so it is loaded with a native require here - that way
// the tests and the controllers share one module registry, and swapping the
// Prisma client below actually reaches the code under test.
const require = createRequire(import.meta.url);

export function createPrismaMock() {
  return {
    staffUser: { findUnique: vi.fn(), create: vi.fn() },
    registration: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
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
