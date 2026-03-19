const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'whatsapp_scheduler',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z', // UTC
  // Aiven requires SSL
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Test connection on startup
pool.getConnection()
  .then(conn => {
    conn.release();
    console.log('[DB] MySQL connected successfully');
  })
  .catch(err => {
    console.error('[DB] MySQL connection failed:', err.message);
    process.exit(1);
  });

module.exports = pool;