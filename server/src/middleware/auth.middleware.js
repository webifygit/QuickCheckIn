const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../prismaClient');

// A valid signature is not enough on its own. The account behind the token can
// have been disabled, deleted, or had its sessions ended (a password reset, or
// "sign this person out now") since it was issued, and a bearer token cannot
// know any of that by itself.
//
// So each staff request costs one primary-key lookup. That is the price of
// revocation taking effect now rather than whenever JWT_EXPIRES_IN runs out -
// on a system holding guests' ID documents, a fired employee keeping access for
// another twelve hours is the worse trade.
async function requireStaffAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  let payload;
  try {
    // Pinning the algorithm matters: without it, a token claiming "alg": "none"
    // or an asymmetric algorithm can be made to verify against the shared secret.
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // ver is required, not defaulted: a token minted before revocation existed
  // carries no version, and treating that as version 0 would let it outlive the
  // very bump meant to kill it. Existing sessions end once, at deploy.
  if (!payload || typeof payload.staffId !== 'string' || !Number.isInteger(payload.ver)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  let staff;
  try {
    staff = await prisma.staffUser.findUnique({
      where: { id: payload.staffId },
      select: { id: true, email: true, name: true, isActive: true, tokenVersion: true },
    });
  } catch (err) {
    // The database being unreachable is not the caller's fault, and answering
    // 401 would sign every member of staff out over a blip.
    return next(err);
  }

  if (!staff || staff.isActive === false || staff.tokenVersion !== payload.ver) {
    // One message for all three. Which of them applies is the operator's
    // business, and it is already in the logs.
    return res.status(401).json({ error: 'Session ended. Please sign in again.' });
  }

  // From the row, not from the token: a name or email changed since sign-in
  // should not be stale for the rest of the session.
  req.staff = { staffId: staff.id, email: staff.email, name: staff.name };
  next();
}

module.exports = { requireStaffAuth };
