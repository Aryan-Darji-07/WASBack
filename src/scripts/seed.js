require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

async function seed() {
  const username = 'admin';
  const email = 'admin@whatsapp-scheduler.com';
  const password = 'Admin@123';
  const timezone = 'Asia/Kolkata';

  const [existing] = await pool.execute(
    'SELECT id FROM users WHERE email = ?',
    [email]
  );

  if (existing.length > 0) {
    console.log('Admin user already exists. Skipping seed.');
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.execute(
    `INSERT INTO users (username, email, password_hash, role, timezone)
     VALUES (?, ?, ?, 'admin', ?)`,
    [username, email, hash, timezone]
  );

  console.log('');
  console.log('✅ Admin user created successfully!');
  console.log('-----------------------------------');
  console.log(`  Email   : ${email}`);
  console.log(`  Password: ${password}`);
  console.log('-----------------------------------');
  console.log('⚠️  Please change the password after first login.');
  console.log('');

  process.exit(0);
}

seed().catch(err => {
  console.error('Seed error:', err.message);
  process.exit(1);
});
