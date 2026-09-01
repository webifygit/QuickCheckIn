const bcrypt = require('bcryptjs');
const config = require('./config');
const prisma = require('./prismaClient');

// Creates the first staff login. Safe to run repeatedly: an existing account is
// left exactly as it is, so re-running a deploy never resets a password that
// staff have since changed.

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const email = (process.env.SEED_STAFF_EMAIL || 'admin@hotel.local').trim().toLowerCase();
  const password = process.env.SEED_STAFF_PASSWORD || '';
  const name = process.env.SEED_STAFF_NAME || 'Front Desk Admin';

  if (!password) {
    throw new Error('SEED_STAFF_PASSWORD is not set - refusing to seed a staff account without one');
  }

  // The seeded account is a real credential on a system holding ID documents.
  // A default like "ChangeMe123!" survives to production more often than not.
  if (config.isProduction && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SEED_STAFF_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters in production`);
  }

  const existing = await prisma.staffUser.findUnique({ where: { email } });
  if (existing) {
    console.log(`Staff user already exists, left unchanged: ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const staff = await prisma.staffUser.create({ data: { email, passwordHash, name } });

  console.log(`Seeded staff user: ${staff.email}`);
  // The password is already in the operator's environment; echoing it here only
  // adds it to shell history and CI logs.
  console.log('Sign in with the password from SEED_STAFF_PASSWORD.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
