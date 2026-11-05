const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL chưa được cấu hình!');
}

// Database trên máy bạn (localhost) thường không có SSL, còn Neon thì bắt buộc có.
// Muốn ép tay: đặt biến DB_SSL=true hoặc DB_SSL=false.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(process.env.DATABASE_URL);
const useSsl = process.env.DB_SSL
  ? process.env.DB_SSL !== 'false'
  : !isLocal;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

// Nếu một kết nối rảnh bị Neon cắt, pg bắn lỗi 'error'.
// Không có dòng này thì lỗi đó làm sập cả server.
db.on('error', (err) => {
  console.error('Lỗi kết nối Postgres (đã bỏ qua):', err.message);
});

// Tạo toàn bộ bảng cần thiết (chạy 1 lần lúc khởi động, an toàn khi chạy lại)
db.initSchema = async function initSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      room_name TEXT PRIMARY KEY,
      history JSONB NOT NULL DEFAULT '[]',
      salt TEXT,
      password_hash TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS account_login_locks (
      user_id BIGINT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      client_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE account_login_locks
    ADD COLUMN IF NOT EXISTS client_id TEXT
  `);

  console.log('Database đã sẵn sàng.');
};

module.exports = db;