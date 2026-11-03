const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL chưa được cấu hình!');
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Tạo bảng tài khoản trên Neon nếu chưa có
db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
  .then(() => {
    console.log('Bảng users trên Neon đã sẵn sàng!');
  })
  .catch((err) => {
    console.error('Không thể tạo bảng users:', err);
  });
db.query('SELECT NOW()')
  .then((result) => {
    console.log('Kết nối Neon thành công:', result.rows[0]);
  })
  .catch((err) => {
    console.error('Kết nối Neon thất bại:', err.message);
  });
module.exports = db;
