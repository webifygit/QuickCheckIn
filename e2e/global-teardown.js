import { cleanUp } from './support/db.js';

export default async function globalTeardown() {
  await cleanUp();
}
