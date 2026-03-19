const bcrypt = require('bcryptjs');
const pool = require('../config/db');

async function listUsers(req, res) {
  const [rows] = await pool.execute(
    'SELECT id, username, email, full_name, mobile, role, timezone, created_at FROM users ORDER BY created_at DESC'
  );
  res.json({ users: rows });
}

async function createUser(req, res) {
  const { username, email, password, role, timezone, full_name, mobile } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'username, email, and password are required' });
  }

  const [existing] = await pool.execute(
    'SELECT id FROM users WHERE email = ? OR username = ?',
    [email.toLowerCase().trim(), username.trim()]
  );

  if (existing.length > 0) {
    return res.status(409).json({ message: 'Email or username already exists' });
  }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    `INSERT INTO users (username, email, password_hash, role, timezone, full_name, mobile)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      username.trim(),
      email.toLowerCase().trim(),
      hash,
      role === 'admin' ? 'admin' : 'user',
      timezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
      full_name?.trim() || null,
      mobile?.trim() || null,
    ]
  );

  res.status(201).json({ message: 'User created', id: result.insertId });
}

async function updateUser(req, res) {
  const { id } = req.params;
  const { username, email, role, timezone, full_name, mobile } = req.body;

  // Non-admin users can only update their own profile
  if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const fields = [];
  const values = [];

  if (username)   { fields.push('username = ?');  values.push(username.trim()); }
  if (email)      { fields.push('email = ?');      values.push(email.toLowerCase().trim()); }
  if (timezone)   { fields.push('timezone = ?');   values.push(timezone); }
  if (full_name !== undefined) { fields.push('full_name = ?'); values.push(full_name?.trim() || null); }
  if (mobile !== undefined)    { fields.push('mobile = ?');    values.push(mobile?.trim() || null); }
  if (role && req.user.role === 'admin') { fields.push('role = ?'); values.push(role); }

  if (fields.length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  values.push(id);
  await pool.execute(
    `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
    values
  );

  res.json({ message: 'User updated' });
}

async function changePassword(req, res) {
  const { id } = req.params;
  const { current_password, new_password } = req.body;

  const targetId = parseInt(id);
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' });
  }

  const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [targetId]);
  if (rows.length === 0) return res.status(404).json({ message: 'User not found' });

  if (req.user.role !== 'admin') {
    if (!current_password) {
      return res.status(400).json({ message: 'Current password is required' });
    }
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(new_password, 10);
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetId]);

  res.json({ message: 'Password changed' });
}

async function deleteUser(req, res) {
  const { id } = req.params;

  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ message: 'Cannot delete your own account' });
  }

  const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [id]);

  if (result.affectedRows === 0) {
    return res.status(404).json({ message: 'User not found' });
  }

  res.json({ message: 'User deleted' });
}

async function updateTimezone(req, res) {
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ message: 'timezone is required' });

  await pool.execute('UPDATE users SET timezone = ? WHERE id = ?', [timezone, req.user.id]);
  res.json({ message: 'Timezone updated', timezone });
}

module.exports = {
  listUsers,
  createUser,
  updateUser,
  changePassword,
  deleteUser,
  updateTimezone,
};