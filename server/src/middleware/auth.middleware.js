const jwt = require('jsonwebtoken');
const config = require('../config');

// Tokens are stateless: verification never touches the database, so a staff
// account disabled mid-session keeps access until its token expires
// (JWT_EXPIRES_IN, 12h by default). Shorten that value if faster revocation
// matters more than avoiding a lookup on every request.
function requireStaffAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    // Pinning the algorithm matters: without it, a token claiming "alg": "none"
    // or an asymmetric algorithm can be made to verify against the shared secret.
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });

    if (!payload || typeof payload.staffId !== 'string') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.staff = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireStaffAuth };
