const express = require('express');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');
const PgSession = require('connect-pg-simple')(session);
const app = express();
const server = http.createServer(app);

// ===== AUTHENTICATION =====
app.use(express.json());

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET chưa được cấu hình!');
}

// Render chạy sau HTTPS proxy
app.set('trust proxy', 1);

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
    secure: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
// Tiet kiem bang thong: chi dung websocket, bat nen du lieu
// maxHttpBufferSize = 20000: du cho cac goi "thuong luong" voice (SDP) di qua server
const io = new Server(server, {
  transports: ['websocket'],
  perMessageDeflate: { threshold: 256 },
  maxHttpBufferSize: 20000
});

// Cho Socket.IO truy cập session đăng nhập
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const session = socket.request.session;

  if (!session || !session.userId) {
    return next(new Error('Chưa đăng nhập.'));
  }

  next();
});
// ===== API TAI KHOAN =====

// Dang ky
// Dang ky
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

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

    req.session.userId = userId;

    req.session.save((err) => {
  if (err) {
    console.error('Lỗi lưu phiên đăng ký:', err);
    return res.status(500).json({ error: 'Không thể lưu phiên đăng ký.' });
  }

  res.json({
    message: 'Đăng ký thành công!',
    user: {
      id: userId,
      username,
      email
    }
  });
});
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Tên tài khoản hoặc email đã được sử dụng.'
      });
    }

    console.error(err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// Dang nhap
app.post('/api/login', async (req, res) => {
  try {
    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '');

    const result = await db.query(`
  SELECT * FROM users
  WHERE username = $1 OR email = $2
`, [login, login.toLowerCase()]);

const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: 'Tên tài khoản/email hoặc mật khẩu không đúng.'
      });
    }

    req.session.userId = user.id;

req.session.save((err) => {
  if (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Không thể lưu phiên đăng nhập.'
    });
  }

  res.json({
    message: 'Đăng nhập thành công!',
    user: {
      id: user.id,
      username: user.username,
      email: user.email
    }
  });
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// Kiem tra tai khoan dang dang nhap
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Chưa đăng nhập.' });
  }

  const result = await db.query(`
  SELECT id, username, email
  FROM users
  WHERE id = $1
`, [req.session.userId]);

const user = result.rows[0];

  if (!user) {
    return res.status(401).json({ error: 'Tài khoản không tồn tại.' });
  }

  res.json({ user });
});

// Dang xuat

app.post('/api/logout', (req, res) => {
  if (!req.session) {
    return res.json({ message: 'Đã đăng xuất.' });
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Lỗi đăng xuất:', err);
      return res.status(500).json({
        error: 'Không thể đăng xuất.'
      });
    }

    res.clearCookie('connect.sid');
    res.json({ message: 'Đã đăng xuất.' });
  });
});


app.use(express.static('public'));

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
const ROOM_NAME_RE = /^[\p{L}\p{N}_-]+$/u; // chu cai, so, gach ngang, gach duoi
const DATA_FILE = 'data.json';

// rooms = { tenRoom: { history: [], users: Map, voice: Set, salt, hash, emptySince } }
// salt + hash chi co khi room co mat khau
const rooms = Object.create(null);
let dirty = false;
const DEFAULT_ROOMS = [
  'chung',
  'game',
  'music',
  'hoc-tap',
  'tam-su'
];
const cidOf = new Map(); // socket.id -> ma nhan dang cua tab trinh duyet

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

// ---- Doc du lieu cu tu file khi bat server ----
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const name in saved) {
    const s = saved[name];
    if (Array.isArray(s)) {
      // dinh dang cu (chi co lich su)
      rooms[name] = { history: s, users: new Map(), voice: new Set(), emptySince: Date.now() };
    } else {
      rooms[name] = {
        history: s.history || [], salt: s.salt, hash: s.hash,
        users: new Map(), voice: new Set(), emptySince: Date.now()
      };
    }
  }
} catch (e) {
  // chua co file -> bo qua
}

// ---- Luu du lieu ra file ----
async function saveNow() {
  try {
    for (const name in rooms) {
      const r = rooms[name];

      await db.query(
        `INSERT INTO chat_rooms (room_name, history, salt, password_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_name)
         DO UPDATE SET
           history = EXCLUDED.history,
           salt = EXCLUDED.salt,
           password_hash = EXCLUDED.password_hash,
           updated_at = NOW()`,
        [name, JSON.stringify(r.history), r.salt || null, r.hash || null]
      );
    }

    dirty = false;
  } catch (err) {
    console.error('Lỗi lưu phòng chat vào Neon:', err);
  }
}
let saving = false;

setInterval(async () => {
  if (!dirty || saving) return;

  saving = true;
  try {
    await saveNow();
  } finally {
    saving = false;
  }
}, 5000);
process.on('SIGINT', async () => {
  if (dirty) {
    await saveNow();
  }

  await db.end();
  process.exit(0);
});

function getRoom(name, pass) {
  if (!rooms[name]) {
    rooms[name] = { history: [], users: new Map(), voice: new Set(), emptySince: null };
    if (pass) Object.assign(rooms[name], makeSecret(pass));
    dirty = true;
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

      dirty = true;
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

getRoom('chung'); // room mac dinh, khong mat khau

// ---- Tu dong xoa phong trong qua lau (tru phong 'chung') ----
// ---- Tu dong xoa phong trong qua lau (tru phong 'chung') ----
// ---- Tu dong xoa phong trong qua lau (tru phong 'chung') ----
setInterval(async () => {
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
      removedRooms.push(name);
    }
  }

  if (removedRooms.length > 0) {
    dirty = true;
    scheduleRooms();

    try {
      await db.query(
        'DELETE FROM chat_rooms WHERE room_name = ANY($1)',
        [removedRooms]
      );

      console.log('Đã xóa phòng hết hạn khỏi Neon:', removedRooms);
    } catch (err) {
      console.error('Lỗi xóa phòng hết hạn khỏi Neon:', err);
    }
  }
}, SWEEP_MS);

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;

  let currentRoom = null; // Phòng đang tham gia, dùng cho danh sách thành viên
  let viewedRoom = null;  // Phòng đang xem tin nhắn
  let voiceRoom = null;   // Phòng đang tham gia voice
  let username = '';
  let recent = [];       // chong spam tin nhan
  let failCount = 0;     // so lan sai mat khau
  let createTimes = [];  // thoi diem cac lan tao phong moi
  let joinTimes = [];    // thoi diem cac lan vao/doi phong
  let signalTimes = [];  // thoi diem cac goi thuong luong voice

  socket.emit('rooms', roomList());

  // Gui canh bao; neu nguoi nay chua vao phong nao thi dua ve man hinh dang nhap
  function reject(text) {
    socket.emit('warn', text);
    if (!currentRoom) socket.emit('retry-login');
  }

    socket.on('join', async ({ room, pass, cid }) => {
  let replaced = false;
  let newName;

  try {
    const result = await db.query(
      'SELECT username FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      socket.emit('retry-login');
      socket.disconnect(true);
      return;
    }

    newName = result.rows[0].username;
  } catch (err) {
    console.error('Lỗi xác thực tài khoản Socket:', err);
    socket.emit('warn', 'Không thể xác thực tài khoản. Vui lòng thử lại.');
    return;
  }

  const myCid = clean(cid, 40);
  cidOf.set(socket.id, myCid);

  const roomName = clean(room, 20).toLowerCase() || 'chung';
  const passText = clean(pass, 50);

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
        if (id !== socket.id && n.toLowerCase() === newName.toLowerCase()) {
          // Ket noi cu cua CHINH tab nay (vd sau khi bam F5) -> dong no lai, cho vao
          if (myCid && cidOf.get(id) === myCid) {
            const old = io.sockets.sockets.get(id);
            if (old) {
              old.data.silent = true; // ket noi cu roi di thi khong thong bao
              old.disconnect(true);
            }
            replaced = true;
            continue;
          }
          return reject('Ten "' + newName + '" da co nguoi dung trong phong nay.');
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

username = newName;
currentRoom = roomName;
viewedRoom = roomName;

const r = getRoom(roomName, passText);
r.users.set(socket.id, newName);
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
  socket.to('chat:' + roomName).emit('sys', newName + ' da vao phong');
}
    scheduleRooms(); // cap nhat danh sach phong + nguoi trong phong cho moi nguoi
  });
// Chỉ chuyển phòng xem tin nhắn, không đổi phòng thành viên hoặc voice
socket.on('view-room', ({ room, pass }) => {
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
});
  socket.on('msg', (text) => {
  if (!viewedRoom || !currentRoom) return;

  const now = Date.now();
  recent = recent.filter((t) => now - t < WINDOW_MS);

  if (recent.length >= LIMIT) {
    socket.emit('warn', 'Ban gui qua nhanh, vui long cho chut.');
    return;
  }

  recent.push(now);

  const content = clean(text, MAX_LEN);
  if (!content) return;

  const m = {
    u: username,
    t: content,
    ts: Date.now()
  };

  const r = getRoom(viewedRoom);
  r.history.push(m);

  if (r.history.length > MAX_HISTORY) {
    r.history.shift();
  }

  dirty = true;

  io.to('chat:' + viewedRoom).emit('msg', m);
});

 // ================= VOICE =================

// Vào voice của phòng đang tham gia, không phải phòng đang xem
socket.on('voice-join', () => {
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
});

socket.on('voice-leave', () => leaveVoice());

socket.on('voice-signal', (payload) => {
  const { to, data } = payload || {};

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
});

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
    cidOf.delete(socket.id);
    if (currentRoom) leave(!!socket.data.silent);
  });
});
async function loadRoomsFromDB() {
  try {
    const result = await db.query(
      'SELECT room_name, history, salt, password_hash FROM chat_rooms'
    );

    for (const row of result.rows) {
      rooms[row.room_name] = {
        history: row.history || [],
        salt: row.salt,
        hash: row.password_hash,
        users: new Map(),
        voice: new Set(),
        emptySince: Date.now()
      };
    }

    console.log(`Đã tải ${result.rows.length} phòng chat từ Neon.`);
  } catch (err) {
    console.error('Lỗi tải phòng chat từ Neon:', err);
    throw err;
  }
}
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await loadRoomsFromDB();

// Tạo các phòng mặc định nếu chưa có
ensureDefaultRooms();

// Lưu các phòng mặc định mới vào Neon
if (dirty) {
  await saveNow();
}
server.listen(PORT, () => {
  console.log('Server chay tai http://localhost:' + PORT);
});
  } catch (err) {
    console.error('Server không thể khởi động:', err);
    process.exit(1);
  }
})();