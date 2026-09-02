#!/usr/bin/env node
//
// Staff account access: disable an account, re-enable it, or end its sessions
// right now. Needs DATABASE_URL, the same as the server.
//
//   npm run staff -- list
//   npm run staff -- disable alex@hotel.local     (blocks sign-in AND ends open sessions)
//   npm run staff -- enable   alex@hotel.local
//   npm run staff -- signout  alex@hotel.local    (keeps the account, ends its sessions)
//   npm run staff -- signout --all                (after a secret rotation, say)
//
// disable and signout take effect on the account's next request - within
// seconds - rather than whenever their token would have expired.

const prisma = require('../src/prismaClient');

const USAGE = `Usage:
  npm run staff -- list
  npm run staff -- disable <email>
  npm run staff -- enable <email>
  npm run staff -- signout <email>
  npm run staff -- signout --all`;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function findOrExit(email) {
  const staff = await prisma.staffUser.findUnique({ where: { email } });
  if (!staff) {
    console.error(`No staff account with email ${email}`);
    process.exitCode = 1;
    return null;
  }
  return staff;
}

async function list() {
  const staff = await prisma.staffUser.findMany({
    orderBy: { createdAt: 'asc' },
    select: { email: true, name: true, isActive: true, tokenVersion: true },
  });

  if (staff.length === 0) {
    console.log('No staff accounts. Create the first one with `npm run seed`.');
    return;
  }

  const width = Math.max(...staff.map((s) => s.email.length), 5);
  console.log(`${'EMAIL'.padEnd(width)}  STATUS    SESSIONS  NAME`);
  for (const s of staff) {
    const status = s.isActive ? 'active' : 'DISABLED';
    console.log(
      `${s.email.padEnd(width)}  ${status.padEnd(8)}  gen ${String(s.tokenVersion).padEnd(4)}  ${s.name}`
    );
  }
}

async function disable(email) {
  const staff = await findOrExit(email);
  if (!staff) return;

  // Both, deliberately: isActive stops the next sign-in, the version bump ends
  // the session they are in right now. Doing only the first leaves someone
  // "disabled" and still reading ID documents.
  const updated = await prisma.staffUser.update({
    where: { id: staff.id },
    data: { isActive: false, tokenVersion: { increment: 1 } },
  });

  console.log(`Disabled ${email}. Open sessions ended (session gen ${updated.tokenVersion}).`);
}

async function enable(email) {
  const staff = await findOrExit(email);
  if (!staff) return;

  if (staff.isActive) {
    console.log(`${email} is already active. Nothing changed.`);
    return;
  }

  await prisma.staffUser.update({ where: { id: staff.id }, data: { isActive: true } });
  console.log(`Enabled ${email}. They can sign in again; existing tokens stay dead.`);
}

async function signout(target) {
  if (target === '--all') {
    const { count } = await prisma.staffUser.updateMany({
      data: { tokenVersion: { increment: 1 } },
    });
    console.log(`Ended every session for ${count} staff account(s).`);
    return;
  }

  const email = normalizeEmail(target);
  const staff = await findOrExit(email);
  if (!staff) return;

  const updated = await prisma.staffUser.update({
    where: { id: staff.id },
    data: { tokenVersion: { increment: 1 } },
  });
  console.log(`Ended all sessions for ${email} (session gen ${updated.tokenVersion}).`);
}

async function main() {
  const [command, target] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }

  if (command === 'list') {
    await list();
    return;
  }

  if (!target) {
    console.error(`${command} needs an email address.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'disable':
      await disable(normalizeEmail(target));
      break;
    case 'enable':
      await enable(normalizeEmail(target));
      break;
    case 'signout':
      await signout(target);
      break;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
