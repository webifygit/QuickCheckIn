const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const staff = await prisma.staffUser.findUnique({ where: { email } });
  if (!staff) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, staff.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { staffId: staff.id, email: staff.email, name: staff.name },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token, staff: { id: staff.id, email: staff.email, name: staff.name } });
}

module.exports = { login };
