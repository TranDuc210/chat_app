const $ = (id) => document.getElementById(id);
let socket, myName = '', currentRoom = 'chung';

// 1. Dang nhap
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = $('nameInput').value.trim();
  if (!myName) return;

  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  socket = io({ transports: ['websocket'] }); // chi dung websocket
  setupSocket();
  socket.emit('join', { name: myName, room: currentRoom });
});

// 2. Lang nghe su kien tu server
function setupSocket() {
  socket.on('rooms', (list) => {
    $('roomList').innerHTML = '';
    list.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = '# ' + r;
      if (r === currentRoom) li.classList.add('active');
      li.onclick = () => joinRoom(r);
      $('roomList').appendChild(li);
    });
  });
 
  socket.on('joined', ({ room, history, users }) => {
    currentRoom = room;
    $('roomTitle').textContent = '# ' + room;
    $('messages').innerHTML = '';
    history.forEach(addMessage);
    renderUsers(users);
    // to sang phong dang active
    [...$('roomList').children].forEach((li) =>
      li.classList.toggle('active', li.textContent === '# ' + room));
  });
  socket.on('warn', (text) => alert(text));
  socket.on('msg', addMessage);
  socket.on('users', renderUsers);
  socket.on('retry-login', () => {
    socket.disconnect();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  });
}

function joinRoom(room) {
  if (room === currentRoom) return;
  socket.emit('join', { name: myName, room });
}

// 3. Hien thi tin nhan
function addMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = m.u[0].toUpperCase();

  const body = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = m.u;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(m.ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = m.t; // textContent chong chen ma doc hai (XSS)

  const head = document.createElement('div');
  head.append(name, time);
  body.append(head, text);
  div.append(avatar, body);

  const box = $('messages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderUsers(users) {
  $('userList').innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.textContent = u;
    $('userList').appendChild(li);
  });
}

// 4. Gui tin nhan
$('msgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text) return;
  socket.emit('msg', text);
  $('msgInput').value = '';
});

// 5. Tao phong moi
$('newRoomForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('newRoomInput').value.trim().toLowerCase();
  if (!name) return;
  $('newRoomInput').value = '';
  socket.emit('join', { name: myName, room: name });
});