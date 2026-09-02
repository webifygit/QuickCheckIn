const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');
const config = require('../config');
const logger = require('../lib/logger');
const { loginSchema, formatZodError } = require('../lib/validation');

// A bcrypt hash of a value nobody can supply. When the email does not exist we
// still run a comparison against it, so a missing account and a wrong password
// take the same time - otherwise the response time itself reveals which staff
// emails are real.
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-for-timing-safety', 10);

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(formatZodError(parsed.error));
  }

  const { email, password } = parsed.data;
  const staff = await prisma.staffUser.findUnique({ where: { email: email.toLowerCase() } });

  const passwordMatches = await bcrypt.compare(password, staff?.passwordHash || DUMMY_HASH);

  // One message for every failure mode. Telling the caller which part was wrong
  // hands them half the credential.
  if (!staff || !passwordMatches || staff.isActive === false) {
    logger.warn({ email }, 'Failed staff login');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // ver pins the token to the account's current session generation. Raising
  // StaffUser.tokenVersion invalidates every token issued before it - see
  // requireStaffAuth and `npm run staff -- signout`.
  const token = jwt.sign(
    { staffId: staff.id, email: staff.email, name: staff.name, ver: staff.tokenVersion ?? 0 },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  );

  logger.info({ staffId: staff.id }, 'Staff signed in');
  res.json({ token, staff: { id: staff.id, email: staff.email, name: staff.name } });
}

module.exports = { login };
