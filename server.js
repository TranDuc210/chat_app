const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');
const PgSession = require('connect-pg-simple')(session);
const app = express();
const server = http.createServer(app);

// Một lời hứa (async) bị lỗi mà không ai bắt thì Node tắt luôn server.
// Ghi lại lỗi và chạy tiếp cho an toàn.
process.on('unhandledRejection', (err) => {
  console.error('Lỗi chưa được xử lý (unhandledRejection):', err);
});

// ===== AUTHENTICATION =====
app.use(express.json());

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET chưa được cấu hình!');
}

// Render chạy sau HTTPS proxy
app.set('trust proxy', 1);

// File tĩnh (html/css/js) đặt TRƯỚC session: tải trang không cần hỏi database
app.use(express.static('public'));

const sessionMiddleware = session({
  store: new PgSession({
    pool: db,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),

  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,

  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // 'auto' = có HTTPS (Render) thì cookie "secure", chạy http://localhost thì vẫn đăng nhập được
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

// ===== KHÓA ĐĂNG NHẬP: mỗi tài khoản chỉ có 1 phiên; đăng nhập mới ĐÁ phiên cũ =====

async function acquireLoginLock(userId, sessionId, clientId) {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Hai lần đăng nhập cùng lúc của một tài khoản phải xếp hàng
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [String(userId)]
    );

    // Xóa phiên cũ khỏi bảng session -> trình duyệt cũ hết quyền ngay
    await client.query(`
      DELETE FROM user_sessions
      WHERE sid IN (
        SELECT session_id FROM account_login_locks
        WHERE user_id = $1 AND session_id <> $2
      )
    `, [userId, sessionId]);

    await client.query(
      'DELETE FROM account_login_locks WHERE user_id = $1',
      [userId]
    );

    await client.query(`
      INSERT INTO account_login_locks (user_id, session_id, client_id)
      VALUES ($1, $2, $3)
    `, [userId, sessionId, clientId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Trả về username nếu (tài khoản + phiên + tab) khớp khóa đang giữ, ngược lại trả null
async function findLockedUsername(userId, sessionId, clientId) {
  const result = await db.query(
    `SELECT u.username
     FROM account_login_locks l
     JOIN users u ON u.id = l.user_id
     WHERE l.user_id = $1
       AND l.session_id = $2
       AND l.client_id = $3`,
    [userId, sessionId, clientId]
  );

  return result.rows.length > 0 ? result.rows[0].username : null;
}

// ===== DANH SÁCH SOCKET ĐANG KẾT NỐI THEO TÀI KHOẢN =====
const socketsByUser = new Map(); // userId -> Set<socket>

function trackSocket(socket) {
  const key = String(socket.data.userId);

  // Cùng tab mở kết nối mới (vd bấm F5): đóng kết nối cũ, không thông báo
  for (const old of [...(socketsByUser.get(key) || [])]) {
    old.data.silent = true;
    old.disconnect(true);
  }

  // Lấy lại Set SAU khi đóng kết nối cũ: lúc đó untrackSocket có thể đã xóa Set rỗng khỏi Map
  let set = socketsByUser.get(key);
  if (!set) {
    set = new Set();
    socketsByUser.set(key, set);
  }
  set.add(socket);
}

function untrackSocket(socket) {
  const key = String(socket.data.userId);
  const set = socketsByUser.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) socketsByUser.delete(key);
}

// Ngắt các kết nối của một tài khoản.
// reason: câu thông báo hiện ở màn hình đăng nhập (null = chỉ báo "đăng nhập lại").
// keep(socket) = true thì giữ lại, không ngắt.
function kickUserSockets(userId, reason, keep) {
  const set = socketsByUser.get(String(userId));
  if (!set) return;

  for (const s of [...set]) {
    if (keep && keep(s)) continue;
    if (reason) s.emit('kicked', reason);
    else s.emit('retry-login');
    s.disconnect(true);
  }
}

// Tiet kiem bang thong: chi dung websocket, bat nen du lieu
// maxHttpBufferSize = 20000: du cho cac goi "thuong luong" voice (SDP) di qua server
const io = new Server(server, {
  transports: ['websocket'],
  perMessageDeflate: { threshold: 256 },
  maxHttpBufferSize: 20000
});

// Cho Socket.IO truy cập session đăng nhập
io.engine.use(sessionMiddleware);

// Kiểm tra đăng nhập ĐÚNG 1 LẦN lúc bắt tay. Sau đó, nếu có người đăng nhập
// chỗ khác thì server chủ động ngắt (kickUserSockets), không cần kiểm tra mỗi tin nhắn.
io.use(async (socket, next) => {
  try {
    const sess = socket.request.session;
    const sessionId = socket.request.sessionID;

    if (!sess || !sess.userId || !sessionId) {
      return next(new Error('Chưa đăng nhập.'));
    }

    const clientId = clean(socket.handshake.auth && socket.handshake.auth.cid, 40);
    if (!clientId) {
      return next(new Error('Không xác định được tab. Vui lòng tải lại trang.'));
    }

    const username = await findLockedUsername(sess.userId, sessionId, clientId);
    if (!username) {
      return next(new Error('Phiên đăng nhập không còn hợp lệ.'));
    }

    socket.data.userId = String(sess.userId);
    socket.data.sid = sessionId;
    socket.data.cid = clientId;
    socket.data.username = username;

    next();
  } catch (err) {
    console.error('Lỗi kiểm tra phiên Socket.IO:', err);
    next(new Error('Không thể xác thực phiên đăng nhập.'));
  }
});

// ===== API TAI KHOAN =====

const promisifySession = {
  regenerate: (req) => new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve()))),
  save: (req) => new Promise((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve()))),
  destroy: (req) => new Promise((resolve) =>
    req.session.destroy(() => resolve()))
};

// Tạo phiên đăng nhập mới cho userId và ĐÁ mọi phiên cũ của tài khoản này
async function startSession(req, userId, clientId) {
  const previousUserId = req.session && req.session.userId;
  const previousSid = req.sessionID;

  await promisifySession.regenerate(req);
  req.session.userId = userId;
  await promisifySession.save(req);

  const newSid = req.sessionID;

  await acquireLoginLock(userId, newSid, clientId);

  // Đá các kết nối cũ của tài khoản này (ở tab/thiết bị khác, hoặc cùng tab đăng nhập lại)
  kickUserSockets(
    userId,
    'Tài khoản vừa được đăng nhập ở nơi khác.',
    (s) => s.data.sid === newSid
  );

  // Trình duyệt này đang đăng nhập tài khoản KHÁC rồi chuyển sang tài khoản mới
  if (previousUserId && String(previousUserId) !== String(userId)) {
    await db.query(
      'DELETE FROM account_login_locks WHERE user_id = $1 AND session_id = $2',
      [previousUserId, previousSid]
    );
    kickUserSockets(previousUserId, null, (s) => s.data.sid !== previousSid);
  }
}

// Dang ky
app.post('/api/register', async (req, res) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const clientId = clean(body.cid, 40);

    if (!clientId) {
      return res.status(400).json({
        error: 'Không xác định được tab. Vui lòng tải lại trang.'
      });
    }

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({
        error: 'Tên tài khoản phải từ 3 đến 20 ký tự.'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        error: 'Tên tài khoản chỉ được có chữ, số và dấu _.'
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Email không hợp lệ.'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Mật khẩu phải có ít nhất 8 ký tự.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [username, email, passwordHash]
    );

    const userId = result.rows[0].id;

    try {
      await startSession(req, userId, clientId);
    } catch (sessErr) {
      console.error('Lỗi tạo phiên đăng ký:', sessErr);
      await promisifySession.destroy(req);
      res.clearCookie('connect.sid');
      return res.status(500).json({ error: 'Không thể tạo phiên đăng nhập.' });
    }

    res.json({
      message: 'Đăng ký thành công!',
      user: { id: userId, username, email }
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Tên tài khoản hoặc email đã được sử dụng.'
      });
    }

    console.error('Lỗi API đăng ký:', err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// Dang nhap: dang nhap moi se DA phien cu
app.post('/api/login', async (req, res) => {
  try {
    const body = req.body || {};
    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    const clientId = clean(body.cid, 40);

    if (!clientId) {
      return res.status(400).json({
        error: 'Không xác định được tab. Vui lòng tải lại trang.'
      });
    }

    const result = await db.query(
      `SELECT * FROM users
       WHERE username = $1 OR email = $2`,
      [login, login.toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: 'Tên tài khoản/email hoặc mật khẩu không đúng.'
      });
    }

    try {
      await startSession(req, user.id, clientId);
    } catch (sessErr) {
      console.error('Lỗi tạo phiên đăng nhập:', sessErr);
      await promisifySession.destroy(req);
      res.clearCookie('connect.sid');
      return res.status(500).json({ error: 'Không thể tạo phiên đăng nhập.' });
    }

    res.json({
      message: 'Đăng nhập thành công!',
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Lỗi API đăng nhập:', err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// Kiem tra tai khoan dang dang nhap
app.get('/api/me', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Chưa đăng nhập.' });
    }

    const clientId = clean(req.get('X-Client-ID'), 40);
    const username = await findLockedUsername(
      req.session.userId,
      req.sessionID,
      clientId
    );

    if (!username) {
      return res.status(401).json({
        error: 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.'
      });
    }

    const result = await db.query(
      'SELECT id, username, email FROM users WHERE id = $1',
      [req.session.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Tài khoản không tồn tại.' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Lỗi API /api/me:', err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// Dang xuat
app.post('/api/logout', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ message: 'Đã đăng xuất.' });
  }

  const userId = req.session.userId;
  const sessionId = req.sessionID;

  try {
    // Chỉ xóa khóa nếu đúng tài khoản và đúng phiên hiện tại
    await db.query(
      `DELETE FROM account_login_locks
       WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId]
    );

    // Ngắt các kết nối socket của phiên này
    kickUserSockets(userId, null, (s) => s.data.sid !== sessionId);

    await promisifySession.destroy(req);
    res.clearCookie('connect.sid');
    res.json({ message: 'Đã đăng xuất.' });
  } catch (err) {
    console.error('Lỗi đăng xuất:', err);
    res.status(500).json({ error: 'Không thể đăng xuất.' });
  }
});

// ====== CAC GIOI HAN (muon doi thi sua o day) ======
const SHOW_SYS_MSG = false;             // true = hien dong "X da vao/roi phong" trong khung chat
const MAX_SHOWN = 8;                    // moi phong hien toi da 8 nguoi duoi ten phong
const MAX_VOICE = 4;                    // toi da 4 nguoi trong voice moi phong
const SIGNAL_LIMIT = 200;               // toi da 200 goi thuong luong voice...
const SIGNAL_WINDOW_MS = 10 * 1000;     // ...trong 10 giay
const MAX_HISTORY = 50;                 // nho 50 tin gan nhat moi room
const MAX_LEN = 500;                    // toi da 500 ky tu moi tin
const LIMIT = 5, WINDOW_MS = 5000;      // chong spam: 5 tin / 5 giay
const MAX_PASS_FAILS = 5;               // sai mat khau 5 lan thi ngat ket noi
const MAX_ROOMS = 30;                   // so phong toi da
const CREATE_LIMIT = 3;                 // moi nguoi tao toi da 3 phong...
const CREATE_WINDOW_MS = 60 * 1000;     // ...trong 1 phut
const JOIN_LIMIT = 6;                   // moi nguoi doi phong toi da 6 lan...
const JOIN_WINDOW_MS = 10 * 1000;       // ...trong 10 giay
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // phong trong 6 gio se bi xoa
const SWEEP_MS = 10 * 60 * 1000;        // 10 phut quet phong trong 1 lan
const SAVE_MS = 5000;                   // 5 giay luu cac phong da thay doi 1 lan
const ROOM_NAME_RE = /^[\p{L}\p{N}_-]+$/u; // chu cai, so, gach ngang, gach duoi

// rooms = { tenRoom: { history: [], users: Map, voice: Set, salt, hash, emptySince } }
// salt + hash chi co khi room co mat khau
const rooms = Object.create(null);
const DEFAULT_ROOMS = [
  'chung',
  'game',
  'music',
  'hoc-tap',
  'tam-su'
];

// ---- Mat khau: chi luu ban bam (hash), khong luu chu that ----
function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}
function makeSecret(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPass(pass, salt) };
}
function checkPass(room, pass) {
  if (!room.hash) return true; // room khong co mat khau
  const a = Buffer.from(hashPass(String(pass || ''), room.salt), 'hex');
  const b = Buffer.from(room.hash, 'hex');
  return crypto.timingSafeEqual(a, b);
}

// ---- Luu phong vao Neon: chi luu nhung phong DA THAY DOI ----
const dirtyRooms = new Set();
function markDirty(name) {
  dirtyRooms.add(name);
}

// Moi viec ghi database xep hang noi duoi nhau (khong bao gio chay chong cheo)
let dbQueue = Promise.resolve();
function enqueue(task) {
  dbQueue = dbQueue.then(task).catch((err) => {
    console.error('Lỗi database:', err);
  });
  return dbQueue;
}

function saveNow() {
  return enqueue(async () => {
    if (dirtyRooms.size === 0) return;

    const names = [...dirtyRooms];
    dirtyRooms.clear();

    for (const name of names) {
      const r = rooms[name];
      if (!r) continue; // phong da bi xoa

      try {
        await db.query(
          `INSERT INTO chat_rooms (room_name, history, salt, password_hash)
           VALUES ($1, $2::jsonb, $3, $4)
           ON CONFLICT (room_name)
           DO UPDATE SET
             history = EXCLUDED.history,
             salt = EXCLUDED.salt,
             password_hash = EXCLUDED.password_hash,
             updated_at = NOW()`,
          [name, JSON.stringify(r.history), r.salt || null, r.hash || null]
        );
      } catch (err) {
        console.error('Lỗi lưu phòng "' + name + '" vào Neon:', err);
        dirtyRooms.add(name); // lan sau thu luu lai
      }
    }
  });
}

setInterval(() => {
  if (dirtyRooms.size > 0) saveNow();
}, SAVE_MS);

// ---- Tat server dung cach: Render gui SIGTERM, Ctrl+C gui SIGINT ----
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(signal + ': đang lưu dữ liệu rồi tắt server...');

  // Neu ket thuc cham qua 10 giay thi ep tat
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();

  try {
    io.close();
  } catch (err) {
    console.error('Lỗi đóng Socket.IO:', err);
  }

  try {
    await saveNow();
    await db.end();
  } catch (err) {
    console.error('Lỗi khi tắt server:', err);
  }

  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function getRoom(name, pass) {
  if (!rooms[name]) {
    rooms[name] = { history: [], users: new Map(), voice: new Set(), emptySince: null };
    if (pass) Object.assign(rooms[name], makeSecret(pass));
    markDirty(name);
  }
  return rooms[name];
}

function ensureDefaultRooms() {
  for (const name of DEFAULT_ROOMS) {
    if (!rooms[name]) {
      rooms[name] = {
        history: [],
        users: new Map(),
        voice: new Set(),
        emptySince: null
      };

      markDirty(name);
    }
  }
}

// Danh sach phong gui cho client: [[ten, co khoa (0/1), [ten nguoi...], tong so nguoi], ...]
// Phong co khoa thi KHONG gui ten nguoi ben trong (rieng tu)
function roomList() {
  return Object.keys(rooms).map((n) => {
    const r = rooms[n];
    if (r.hash) return [n, 1, [], 0];
    const names = [...r.users.values()];
    return [n, 0, names.slice(0, MAX_SHOWN), names.length];
  });
}

// Ten nhung nguoi dang trong voice cua mot phong
function voiceNames(r) {
  return [...r.voice].map((id) => r.users.get(id)).filter(Boolean);
}
function voiceMembers(r) {
  return [...r.voice]
    .map((id) => ({ id, name: r.users.get(id) }))
    .filter((member) => member.name);
}

// Gom nhieu thay doi lai, 0,3 giay moi gui 1 lan cho moi nguoi (do ton bang thong)
let roomsTimer = null;
function scheduleRooms() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = null;
    io.emit('rooms', roomList());
  }, 300);
}

function clean(text, max) {
  return String(text || '').trim().slice(0, max);
}

// Du lieu client gui len co the la bat ky thu gi (undefined, so, chuoi...)
function isObj(x) {
  return typeof x === 'object' && x !== null;
}

// Boc moi ham xu ly su kien: loi (ke ca loi async) chi duoc ghi lai, khong lam sap server
function safe(handler) {
  return (...args) => {
    try {
      const out = handler(...args);
      if (out && typeof out.catch === 'function') {
        out.catch((err) => console.error('Lỗi xử lý sự kiện socket:', err));
      }
    } catch (err) {
      console.error('Lỗi xử lý sự kiện socket:', err);
    }
  };
}

// ---- Tu dong xoa phong trong qua lau (tru cac phong mac dinh) ----
setInterval(() => {
  const now = Date.now();
  const removedRooms = [];

  for (const name in rooms) {
    if (DEFAULT_ROOMS.includes(name)) continue;

    const r = rooms[name];

    if (
      r.users.size === 0 &&
      r.emptySince &&
      now - r.emptySince > ROOM_TTL_MS
    ) {
      delete rooms[name];
      dirtyRooms.delete(name);
      removedRooms.push(name);
    }
  }

  if (removedRooms.length > 0) {
    scheduleRooms();

    enqueue(async () => {
      await db.query(
        'DELETE FROM chat_rooms WHERE room_name = ANY($1)',
        [removedRooms]
      );
      console.log('Đã xóa phòng hết hạn khỏi Neon:', removedRooms);
    });
  }
}, SWEEP_MS);

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const username = socket.data.username;

  trackSocket(socket);

  let currentRoom = null; // Phòng đang tham gia, dùng cho danh sách thành viên
  let viewedRoom = null;  // Phòng đang xem tin nhắn
  let voiceRoom = null;   // Phòng đang tham gia voice
  let recent = [];       // chong spam tin nhan
  let failCount = 0;     // so lan sai mat khau
  let createTimes = [];  // thoi diem cac lan tao phong moi
  let joinTimes = [];    // thoi diem cac lan vao/doi phong
  let signalTimes = [];  // thoi diem cac goi thuong luong voice

  socket.emit('rooms', roomList());

  // Vao phong that bai: bao cho nguoi dung. Client tu quyet dinh lam gi tiep (xem 'join-failed')
  function reject(text) {
    socket.emit('warn', text);
    socket.emit('join-failed');
  }

  socket.on('join', safe((payload) => {
    const { room, pass } = isObj(payload) ? payload : {};
    const roomName = clean(room, 20).toLowerCase() || 'chung';
    const passText = clean(pass, 50);
    let replaced = false;

    // Gioi han toc do doi phong
    const t0 = Date.now();
    joinTimes = joinTimes.filter((t) => t0 - t < JOIN_WINDOW_MS);
    if (joinTimes.length >= JOIN_LIMIT) {
      return reject('Ban doi phong qua nhanh, vui long cho chut.');
    }
    joinTimes.push(t0);

    // 0. Kiem tra ten phong hop le
    if (!ROOM_NAME_RE.test(roomName)) {
      return reject('Ten phong chi duoc dung chu cai, so, dau gach ngang (-) va gach duoi (_).');
    }

    const existing = rooms[roomName];

    if (!existing) {
      // Dang tao phong MOI -> kiem tra cac gioi han
      if (Object.keys(rooms).length >= MAX_ROOMS) {
        return reject('May chu da dat so phong toi da (' + MAX_ROOMS + '). Hay vao mot phong co san.');
      }
      const now = Date.now();
      createTimes = createTimes.filter((t) => now - t < CREATE_WINDOW_MS);
      if (createTimes.length >= CREATE_LIMIT) {
        return reject('Ban tao phong qua nhanh, vui long cho chut.');
      }
    } else {
      // Phong da co
      // a. Phong dang mo thi khong the dat mat khau cho no
      if (!existing.hash && passText) {
        return reject('Phong "' + roomName + '" da ton tai va khong co mat khau. Hay dung ten phong khac de tao phong rieng tu.');
      }
      // b. Kiem tra mat khau
      if (existing.hash && !checkPass(existing, passText)) {
        failCount++;
        if (failCount >= MAX_PASS_FAILS) {
          socket.emit('warn', 'Ban nhap sai mat khau qua nhieu lan.');
          socket.disconnect();
          return;
        }
        return reject('Sai mat khau cua phong "' + roomName + '".');
      }
      // c. Kiem tra trung ten (bo qua chinh minh)
      for (const [id, n] of [...existing.users]) {
        if (id !== socket.id && n.toLowerCase() === username.toLowerCase()) {
          const old = io.sockets.sockets.get(id);

          if (!old) {
            // Muc con sot lai cua ket noi da chet -> don di
            existing.users.delete(id);
            existing.voice.delete(id);
            continue;
          }

          // Ket noi cu cua CHINH tai khoan nay (vd sau khi bam F5) -> dong no lai, cho vao
          if (old.data.userId === userId) {
            old.data.silent = true; // ket noi cu roi di thi khong thong bao
            old.disconnect(true);
            replaced = true;
            continue;
          }

          return reject('Ten "' + username + '" da co nguoi dung trong phong nay.');
        }
      }
    }

    // ---- Moi kiem tra deu qua: vao phong ----
    if (!existing) createTimes.push(Date.now()); // tinh vao han muc tao phong

    if (currentRoom) leave(false);

    // Rời kênh tin nhắn cũ nếu có
    if (viewedRoom) {
      socket.leave('chat:' + viewedRoom);

      // Nếu phòng đang xem khác phòng đang tham gia,
      // rời luôn kênh theo dõi danh sách thành viên cũ
      if (viewedRoom !== currentRoom) {
        socket.leave('members:' + viewedRoom);
      }
    }

    currentRoom = roomName;
    viewedRoom = roomName;

    const r = getRoom(roomName, passText);
    r.users.set(socket.id, username);
    r.emptySince = null;

    // Kênh tin nhắn riêng
    socket.join('chat:' + roomName);
    socket.join('members:' + roomName);

    socket.emit('joined', {
      room: roomName,
      history: r.history,
      users: [...r.users.values()],
      voice: voiceNames(r),
      voiceMembers: voiceMembers(r)
    });

    socket.to('members:' + roomName).emit('users', {
      room: roomName,
      users: [...r.users.values()]
    });

    if (SHOW_SYS_MSG && !replaced) {
      socket.to('chat:' + roomName).emit('sys', username + ' da vao phong');
    }

    scheduleRooms(); // cap nhat danh sach phong + nguoi trong phong cho moi nguoi
  }));

  // Chỉ chuyển phòng xem tin nhắn, không đổi phòng thành viên hoặc voice
  socket.on('view-room', safe((payload) => {
    const { room, pass } = isObj(payload) ? payload : {};
    const roomName = clean(room, 20).toLowerCase() || 'chung';
    const passText = clean(pass, 50);

    if (!ROOM_NAME_RE.test(roomName)) return;

    const r = rooms[roomName];

    if (!r) {
      socket.emit('warn', 'Phòng không tồn tại.');
      return;
    }

    if (r.hash && !checkPass(r, passText)) {
      socket.emit('warn', 'Sai mật khẩu của phòng "' + roomName + '".');
      return;
    }

    if (!r.hash && passText) {
      socket.emit('warn', 'Phòng này không có mật khẩu.');
      return;
    }

    if (viewedRoom) {
      socket.leave('chat:' + viewedRoom);

      // Không rời kênh thành viên nếu đó vẫn là phòng đang tham gia
      if (viewedRoom !== currentRoom) {
        socket.leave('members:' + viewedRoom);
      }
    }

    viewedRoom = roomName;

    socket.join('chat:' + roomName);
    socket.join('members:' + roomName);

    socket.emit('viewed', {
      room: roomName,
      history: r.history,
      users: [...r.users.values()]
    });
  }));

  socket.on('msg', safe((text) => {
    if (typeof text !== 'string') return;

    if (!viewedRoom || !currentRoom) {
      socket.emit('warn', 'Bạn chưa vào phòng nào. Hãy chọn một phòng ở danh sách bên trái.');
      return;
    }

    const content = clean(text, MAX_LEN);
    if (!content) return;

    const r = rooms[viewedRoom];
    if (!r) {
      socket.emit('warn', 'Phòng này không còn tồn tại.');
      return;
    }

    const now = Date.now();
    recent = recent.filter((t) => now - t < WINDOW_MS);

    if (recent.length >= LIMIT) {
      socket.emit('warn', 'Ban gui qua nhanh, vui long cho chut.');
      return;
    }

    recent.push(now);

    const m = {
      u: username,
      t: content,
      ts: now
    };

    r.history.push(m);

    if (r.history.length > MAX_HISTORY) {
      r.history.shift();
    }

    markDirty(viewedRoom);

    io.to('chat:' + viewedRoom).emit('msg', m);
  }));

  // ================= VOICE =================

  // Vào voice của phòng đang tham gia, không phải phòng đang xem
  socket.on('voice-join', safe(() => {
    if (!currentRoom || currentRoom === 'chung') {
      socket.emit('voice-denied', MAX_VOICE);
      return;
    }

    const r = rooms[currentRoom];
    if (!r) return;

    if (voiceRoom === currentRoom && r.voice.has(socket.id)) return;

    if (voiceRoom) leaveVoice();

    if (r.voice.size >= MAX_VOICE) {
      socket.emit('voice-denied', MAX_VOICE);
      return;
    }

    voiceRoom = currentRoom;

    const peers = [...r.voice];
    r.voice.add(socket.id);

    socket.join('voice:' + voiceRoom);

    socket.emit('voice-peers', peers);

    io.to('voice:' + voiceRoom).emit('voice-users', voiceNames(r));
    io.to('voice:' + voiceRoom).emit('voice-members', voiceMembers(r));
  }));

  socket.on('voice-leave', safe(() => leaveVoice()));

  socket.on('voice-signal', safe((payload) => {
    const { to, data } = isObj(payload) ? payload : {};

    if (!voiceRoom || typeof to !== 'string' || to === socket.id) return;

    const r = rooms[voiceRoom];
    if (!r || !r.voice.has(socket.id) || !r.voice.has(to)) return;

    const now = Date.now();
    signalTimes = signalTimes.filter((t) => now - t < SIGNAL_WINDOW_MS);

    if (signalTimes.length >= SIGNAL_LIMIT) return;
    signalTimes.push(now);

    if (!data || typeof data !== 'object') return;
    if (JSON.stringify(data).length > 8000) return;

    io.to(to).emit('voice-signal', {
      from: socket.id,
      data
    });
  }));

  function leaveVoice() {
    if (!voiceRoom) return;

    const oldVoiceRoom = voiceRoom;
    const r = rooms[oldVoiceRoom];

    voiceRoom = null;

    if (!r || !r.voice.delete(socket.id)) {
      socket.leave('voice:' + oldVoiceRoom);
      return;
    }

    socket.leave('voice:' + oldVoiceRoom);

    io.to('voice:' + oldVoiceRoom).emit('voice-peer-left', socket.id);
    io.to('voice:' + oldVoiceRoom).emit('voice-users', voiceNames(r));
    io.to('voice:' + oldVoiceRoom).emit('voice-members', voiceMembers(r));
  }

  // =========================================

  // silent = true thi khong gui thong bao "da roi phong"
  function leave(silent) {
    const r = rooms[currentRoom];
    if (!r) return;

    // Rời voice độc lập
    if (voiceRoom === currentRoom) {
      leaveVoice();
    }

    r.users.delete(socket.id);

    if (r.users.size === 0) {
      r.emptySince = Date.now();
    }

    socket.leave('members:' + currentRoom);

    io.to('members:' + currentRoom).emit('users', {
      room: currentRoom,
      users: [...r.users.values()]
    });

    if (SHOW_SYS_MSG && !silent) {
      io.to('chat:' + currentRoom).emit('sys', username + ' da roi phong');
    }

    scheduleRooms();
  }

  socket.on('disconnect', () => {
    untrackSocket(socket);

    try {
      if (currentRoom) leave(!!socket.data.silent);
    } catch (err) {
      console.error('Lỗi khi dọn dẹp lúc ngắt kết nối:', err);
    }
  });
});

async function loadRoomsFromDB() {
  const result = await db.query(
    'SELECT room_name, history, salt, password_hash FROM chat_rooms'
  );

  for (const row of result.rows) {
    let history = row.history;

    // Du lieu cu co the dang la chuoi JSON
    if (typeof history === 'string') {
      try {
        history = JSON.parse(history);
      } catch (e) {
        history = [];
      }
    }

    rooms[row.room_name] = {
      history: Array.isArray(history) ? history : [],
      salt: row.salt,
      hash: row.password_hash,
      users: new Map(),
      voice: new Set(),
      emptySince: Date.now()
    };
  }

  console.log(`Đã tải ${result.rows.length} phòng chat từ Neon.`);
}

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.initSchema();
    await loadRoomsFromDB();

    // Tạo các phòng mặc định nếu chưa có, rồi lưu vào Neon
    ensureDefaultRooms();
    if (dirtyRooms.size > 0) await saveNow();

    server.listen(PORT, () => {
      console.log('Server chay tai http://localhost:' + PORT);
    });
  } catch (err) {
    console.error('Server không thể khởi động:', err);
    process.exit(1);
  }
})();