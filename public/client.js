const $ = (id) => document.getElementById(id);
let socket, myName = '';
let currentRoom = 'chung', currentPass = ''; // phong va mat khau dang o
let tryPass = '';                             // mat khau dang thu

// Ma nhan dang cua tab nay (giu nguyen khi bam F5, moi tab mot ma)
let cid = sessionStorage.getItem('cid');
if (!cid) {
  cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('cid', cid);
}

// 1. Dang nhap
function login(name) {
  myName = name;
  sessionStorage.setItem('name', name); // nho ten de F5 tu vao lai
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  socket = io({ transports: ['websocket'] });
  setupSocket();
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  if (name) login(name);
});

// Gui yeu cau vao phong (kem mat khau neu co)
function requestJoin(room, pass) {
  tryPass = pass || '';
  socket.emit('join', { name: myName, room, pass: tryPass, cid });
}

// 2. Lang nghe su kien tu server
function setupSocket() {
  // Chay MOI LAN ket noi duoc (ke ca ket noi lai)
  socket.on('connect', () => requestJoin(currentRoom, currentPass));

  socket.on('disconnect', (reason) => {
    const note = reason === 'io server disconnect'
      ? '(bi ngat ket noi, hay tai lai trang)'
      : '(mat ket noi, dang thu lai...)';
    $('roomTitle').textContent = '# ' + currentRoom + '  ' + note;
  });

  socket.on('rooms', (list) => {
    $('roomList').innerHTML = '';
    list.forEach(([r, locked]) => {
      const li = document.createElement('li');
      li.textContent = (locked ? '🔒 ' : '# ') + r;
      li.dataset.room = r;
      if (r === currentRoom) li.classList.add('active');
      li.onclick = () => joinRoom(r, locked);
      $('roomList').appendChild(li);
    });
  });

  socket.on('joined', ({ room, history, users }) => {
    currentRoom = room;
    currentPass = tryPass; // nho mat khau de tu vao lai khi mat ket noi
    $('roomTitle').textContent = '# ' + room;
    $('messages').innerHTML = '';
    history.forEach(addMessage);
    renderUsers(users);
    [...$('roomList').children].forEach((li) =>
      li.classList.toggle('active', li.dataset.room === room));
  });

  socket.on('msg', addMessage);
  socket.on('users', renderUsers);
  socket.on('warn', (text) => alert(text));
  socket.on('retry-login', () => {
    currentRoom = 'chung';
    currentPass = '';
    sessionStorage.removeItem('name'); // quen ten de khong bi lap vo han
    socket.disconnect();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  });
}

function joinRoom(room, locked) {
  if (room === currentRoom) return;
  let pass = '';
  if (locked) {
    pass = prompt('Nhap mat khau cua phong "' + room + '":');
    if (pass === null) return; // bam Huy
  }
  requestJoin(room, pass);
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

// 5. Tao phong moi (hoac vao phong da co)
$('newRoomForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('newRoomInput').value.trim().toLowerCase();
  const pass = $('newRoomPass').value;
  if (!name) return;
  $('newRoomInput').value = '';
  $('newRoomPass').value = '';
  requestJoin(name, pass);
});

// 6. Neu tab nay da dang nhap truoc do (vd vua bam F5) thi tu vao lai
// (dong nay PHAI nam o cuoi file)
const savedName = sessionStorage.getItem('name');
if (savedName) login(savedName);