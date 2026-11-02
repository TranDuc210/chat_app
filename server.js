const express = require('express');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Tiet kiem bang thong: chi dung websocket, bat nen du lieu
const io = new Server(server, {
  transports: ['websocket'],
  perMessageDeflate: { threshold: 256 },
  maxHttpBufferSize: 2000
});

app.use(express.static('public'));

// ====== CAC GIOI HAN (muon doi thi sua o day) ======
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

// rooms = { tenRoom: { history: [], users: Map, salt, hash, emptySince } }
// salt + hash chi co khi room co mat khau
const rooms = Object.create(null);
let dirty = false;
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
      rooms[name] = { history: s, users: new Map(), emptySince: Date.now() };
    } else {
      rooms[name] = {
        history: s.history || [], salt: s.salt, hash: s.hash,
        users: new Map(), emptySince: Date.now()
      };
    }
  }
} catch (e) {
  // chua co file -> bo qua
}

// ---- Luu du lieu ra file ----
function saveNow() {
  const out = {};
  for (const name in rooms) {
    const r = rooms[name];
    out[name] = { history: r.history, salt: r.salt, hash: r.hash };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(out));
  dirty = false;
}
setInterval(() => { if (dirty) saveNow(); }, 5000);
process.on('SIGINT', () => {
  if (dirty) saveNow();
  process.exit();
});

function getRoom(name, pass) {
  if (!rooms[name]) {
    rooms[name] = { history: [], users: new Map(), emptySince: null };
    if (pass) Object.assign(rooms[name], makeSecret(pass));
    dirty = true;
  }
  return rooms[name];
}

// Danh sach room gui cho client: [[ten, 1 neu co khoa], ...]
function roomList() {
  return Object.keys(rooms).map((n) => [n, rooms[n].hash ? 1 : 0]);
}

function clean(text, max) {
  return String(text || '').trim().slice(0, max);
}

getRoom('chung'); // room mac dinh, khong mat khau

// ---- Tu dong xoa phong trong qua lau (tru phong 'chung') ----
setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const name in rooms) {
    if (name === 'chung') continue;
    const r = rooms[name];
    if (r.users.size === 0 && r.emptySince && now - r.emptySince > ROOM_TTL_MS) {
      delete rooms[name];
      removed = true;
    }
  }
  if (removed) {
    dirty = true;
    io.emit('rooms', roomList());
  }
}, SWEEP_MS);

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = 'Khach';
  let recent = [];       // chong spam tin nhan
  let failCount = 0;     // so lan sai mat khau
  let createTimes = [];  // thoi diem cac lan tao phong moi
  let joinTimes = [];    // thoi diem cac lan vao/doi phong

  socket.emit('rooms', roomList());

  // Gui canh bao; neu nguoi nay chua vao phong nao thi dua ve man hinh dang nhap
  function reject(text) {
    socket.emit('warn', text);
    if (!currentRoom) socket.emit('retry-login');
  }

  socket.on('join', ({ name, room, pass, cid }) => {
    let replaced = false; // true neu day chi la tab nay vao lai (vd bam F5)

    const myCid = clean(cid, 40);
    cidOf.set(socket.id, myCid);
    const newName = clean(name, 20) || 'Khach';
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

    if (currentRoom) leave(false); // roi phong cu (co thong bao)
    username = newName;

    currentRoom = roomName;
    const r = getRoom(roomName, passText); // neu chua co thi tao, kem mat khau (neu co)
    r.users.set(socket.id, username);
    r.emptySince = null;
    socket.join(roomName);

    socket.emit('joined', {
      room: roomName,
      history: r.history,
      users: [...r.users.values()]
    });
    socket.to(roomName).emit('users', [...r.users.values()]);
    if (!replaced) socket.to(roomName).emit('sys', username + ' da vao phong');
    io.emit('rooms', roomList());
  });

  socket.on('msg', (text) => {
    if (!currentRoom) return;

    const now = Date.now();
    recent = recent.filter((t) => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) {
      socket.emit('warn', 'Ban gui qua nhanh, vui long cho chut.');
      return;
    }
    recent.push(now);

    const content = clean(text, MAX_LEN);
    if (!content) return;

    const m = { u: username, t: content, ts: Date.now() };
    const r = getRoom(currentRoom);
    r.history.push(m);
    if (r.history.length > MAX_HISTORY) r.history.shift();
    dirty = true;

    io.to(currentRoom).emit('msg', m);
  });

  // silent = true thi khong gui thong bao "da roi phong"
  function leave(silent) {
    const r = rooms[currentRoom];
    if (!r) return;
    r.users.delete(socket.id);
    if (r.users.size === 0) r.emptySince = Date.now(); // bat dau dem gio phong trong
    socket.leave(currentRoom);
    io.to(currentRoom).emit('users', [...r.users.values()]);
    if (!silent) io.to(currentRoom).emit('sys', username + ' da roi phong');
  }

  socket.on('disconnect', () => {
    cidOf.delete(socket.id);
    if (currentRoom) leave(!!socket.data.silent);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server chay tai http://localhost:' + PORT));