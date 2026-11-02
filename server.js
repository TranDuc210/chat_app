const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Tiết kiệm băng thông: chỉ dùng websocket, bật nén dữ liệu
const io = new Server(server, {
  transports: ['websocket'],
  perMessageDeflate: { threshold: 256 },
  maxHttpBufferSize: 2000 // tối đa ~2KB mỗi gói tin
});

app.use(express.static('public'));

const MAX_HISTORY = 50;   // chỉ nhớ 50 tin gần nhất mỗi room
const MAX_LEN = 500;      // tối đa 500 ký tự mỗi tin
const rooms = {};         // { tenRoom: { history: [], users: Map(socketId -> ten) } }

function getRoom(name) {
  if (!rooms[name]) rooms[name] = { history: [], users: new Map() };
  return rooms[name];
}

// Dọn chuỗi: cắt độ dài, bỏ khoảng trắng thừa
function clean(text, max) {
  return String(text || '').trim().slice(0, max);
}

getRoom('chung'); // tạo sẵn 1 room mặc định

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = 'Khach';

  // Gửi danh sách room cho người mới vào
  socket.emit('rooms', Object.keys(rooms));

  socket.on('join', ({ name, room }) => {
    username = clean(name, 20) || 'Khach';
    const roomName = clean(room, 20).toLowerCase() || 'chung';

    // Rời room cũ (nếu có)
    if (currentRoom) leave();

    currentRoom = roomName;
    const r = getRoom(roomName);
    r.users.set(socket.id, username);
    socket.join(roomName);

    // Gửi lịch sử + danh sách người cho người vừa vào
    socket.emit('joined', {
      room: roomName,
      history: r.history,
      users: [...r.users.values()]
    });

    // Báo cho người trong room
    socket.to(roomName).emit('users', [...r.users.values()]);
    // Báo danh sách room mới cho tất cả (nếu có room mới)
    io.emit('rooms', Object.keys(rooms));
  });

  socket.on('msg', (text) => {
    if (!currentRoom) return;
    const content = clean(text, MAX_LEN);
    if (!content) return;

    const m = { u: username, t: content, ts: Date.now() }; // key ngắn cho nhẹ
    const r = getRoom(currentRoom);
    r.history.push(m);
    if (r.history.length > MAX_HISTORY) r.history.shift();

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
    if (currentRoom) leave();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server chay tai http://localhost:' + PORT));