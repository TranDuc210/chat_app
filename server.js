const express = require('express');
const http = require('http');
const fs = require('fs');
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

const MAX_HISTORY = 50;       // nho 50 tin gan nhat moi room
const MAX_LEN = 500;          // toi da 500 ky tu moi tin
const DATA_FILE = 'data.json';
const LIMIT = 5, WINDOW_MS = 5000; // chong spam: 5 tin / 5 giay

const rooms = Object.create(null); // { tenRoom: { history: [], users: Map } }
let dirty = false;                 // true = co du lieu moi chua luu
const cidOf = new Map(); // socket.id -> ma nhan dang cua tab trinh duyet
// ---- Doc du lieu cu tu file khi bat server ----
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const name in saved) {
    rooms[name] = { history: saved[name], users: new Map() };
  }
} catch (e) {
  // chua co file -> bo qua, se tao khi co tin nhan dau tien
}

// ---- Luu du lieu ra file ----
function saveNow() {
  const out = {};
  for (const name in rooms) out[name] = rooms[name].history;
  fs.writeFileSync(DATA_FILE, JSON.stringify(out));
  dirty = false;
}
setInterval(() => { if (dirty) saveNow(); }, 5000); // 5 giay kiem tra 1 lan
process.on('SIGINT', () => {                         // khi bam Ctrl + C
  if (dirty) saveNow();
  process.exit();
});

function getRoom(name) {
  if (!rooms[name]) {
    rooms[name] = { history: [], users: new Map() };
    dirty = true;
  }
  return rooms[name];
}

function clean(text, max) {
  return String(text || '').trim().slice(0, max);
}

getRoom('chung'); // dam bao luon co room mac dinh

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = 'Khach';
  let recent = []; // thoi diem cac tin gan day cua nguoi nay (chong spam)

  socket.emit('rooms', Object.keys(rooms));

    socket.on('join', ({ name, room, pass, cid }) => {
    const myCid = clean(cid, 40);
    cidOf.set(socket.id, myCid);
    const newName = clean(name, 20) || 'Khach';
    const roomName = clean(room, 20).toLowerCase() || 'chung';

    // Kiem tra trung ten trong room dich (bo qua chinh minh)
    const existing = rooms[roomName];
    if (existing) {
    for (const [id, n] of [...existing.users]) {
        if (id !== socket.id && n.toLowerCase() === newName.toLowerCase()) {
          // Ket noi cu cua CHINH tab nay (vd sau khi bam F5) -> dong no lai, cho vao
          if (myCid && cidOf.get(id) === myCid) {
            const old = io.sockets.sockets.get(id);
            if (old) old.disconnect(true);
            continue;
          }
          socket.emit('warn', 'Ten "' + newName + '" da co nguoi dung trong phong nay.');
          if (!currentRoom) socket.emit('retry-login');
          return;
        }
      }
    }

    username = newName;
    if (currentRoom) leave();

    currentRoom = roomName;
    const r = getRoom(roomName);
    r.users.set(socket.id, username);
    socket.join(roomName);

    socket.emit('joined', {
      room: roomName,
      history: r.history,
      users: [...r.users.values()]
    });
    socket.to(roomName).emit('users', [...r.users.values()]);
    io.emit('rooms', Object.keys(rooms));
  });

  socket.on('msg', (text) => {
    if (!currentRoom) return;

    // Chong spam
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
    dirty = true; // danh dau can luu

    io.to(currentRoom).emit('msg', m);
  });

  function leave() {
    const r = rooms[currentRoom];
    if (!r) return;
    r.users.delete(socket.id);
    socket.leave(currentRoom);
    io.to(currentRoom).emit('users', [...r.users.values()]);
  }

  socket.on('disconnect', () => {
    cidOf.delete(socket.id);
    if (currentRoom) leave();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server chay tai http://localhost:' + PORT));