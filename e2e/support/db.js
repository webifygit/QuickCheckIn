import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_MARKER, E2E_STAFF } from './constants.js';

// The server is a separate CommonJS package, so Prisma, bcrypt and dotenv are
// resolved out of server/node_modules rather than the workspace root.
const serverDir = path.dirname(fileURLToPath(new URL('../../server/package.json', import.meta.url)));
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));

requireFromServer('dotenv').config({ path: path.join(serverDir, '.env') });

const { PrismaClient } = requireFromServer('@prisma/client');
const bcrypt = requireFromServer('bcryptjs');

let prisma;

export function db() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

export async function seedStaff() {
  const passwordHash = await bcrypt.hash(E2E_STAFF.password, 10);
  await db().staffUser.upsert({
    where: { email: E2E_STAFF.email },
    update: { passwordHash, name: E2E_STAFF.name },
    create: { email: E2E_STAFF.email, passwordHash, name: E2E_STAFF.name },
  });
}

// Removes only rows this suite created - every E2E submission carries the
// marker in its purposeOfVisit field.
export async function cleanUp() {
  await db().registration.deleteMany({ where: { purposeOfVisit: { startsWith: E2E_MARKER } } });
  await db().staffUser.deleteMany({ where: { email: E2E_STAFF.email } });
  await db().$disconnect();
  prisma = undefined;
}
