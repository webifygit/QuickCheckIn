require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./prismaClient');

async function main() {
  const email = process.env.SEED_STAFF_EMAIL || 'admin@hotel.local';
  const password = process.env.SEED_STAFF_PASSWORD || 'ChangeMe123!';
  const name = process.env.SEED_STAFF_NAME || 'Front Desk Admin';

  const passwordHash = await bcrypt.hash(password, 10);

  const staff = await prisma.staffUser.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash, name },
  });

  console.log(`Seeded staff user: ${staff.email} (password: ${password})`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
