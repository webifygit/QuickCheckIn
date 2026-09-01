import { seedStaff } from './support/db.js';

export default async function globalSetup() {
  try {
    await seedStaff();
  } catch (err) {
    throw new Error(
      `Could not reach the database named by server/.env DATABASE_URL.\n` +
        `The end-to-end suite needs a running Postgres with migrations applied ` +
        `(cd server && npx prisma migrate deploy).\n\nOriginal error: ${err.message}`
    );
  }
}
