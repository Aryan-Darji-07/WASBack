const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

async function login(req, res) {
  const { email, password } = req.body;
  console.log(email+" | "+password);
  

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE email = ? LIMIT 1',
    [email.toLowerCase().trim()]
  );

  if (rows.length === 0) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const user = rows[0];
  console.log(password);
  
  const valid = await bcrypt.compare(password, user.password_hash);
  console.log(valid);
  

  if (!valid) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      timezone: user.timezone,
    },
  });
}

async function getMe(req, res) {
  res.json({ user: req.user });
}

module.exports = { login, getMe };
