
const Database = require('better-sqlite3');

// Tạo hoặc mở database
const db = new Database('chat.db');

// Bật foreign keys
db.pragma('foreign_keys = ON');

// Tạo bảng tài khoản
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log('Database đã sẵn sàng!');

module.exports = db;
