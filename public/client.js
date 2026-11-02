const $ = (id) => document.getElementById(id);
const MAX_SHOWN = 8; // so nguoi toi da hien duoi moi ten phong
let socket, myName = '';
let currentRoom = 'chung', currentPass = ''; // phong va mat khau dang o
let tryPass = '';                             // mat khau dang thu
let lastRooms = [];                           // danh sach phong moi nhat tu server
let currentUsers = [];                        // nguoi dang o trong phong hien tai

// Ma nhan dang cua tab nay (giu nguyen khi bam F5, moi tab mot ma)
let cid = sessionStorage.getItem('cid');
if (!cid) {
  cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('cid', cid);
}

// ===== Icon dai dien: vong tron mau + chu cai dau (tinh ngay tren may, khong ton bang thong) =====
function colorOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return 'hsl(' + h + ', 55%, 45%)';
}
function initialOf(name) {
  return ([...name][0] || '?').toUpperCase();
}
// Mot "the" gom icon tron + ten
function makeChip(name) {
  const chip = document.createElement('div');
  chip.className = 'chip';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = colorOf(name);
  dot.textContent = initialOf(name);
  const label = document.createElement('span');
  label.className = 'cname';
  label.textContent = name; // textContent: an toan
  chip.append(dot, label);
  return chip;
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
    lastRooms = list;
    renderRooms();
  });

  socket.on('joined', ({ room, history, users }) => {
    currentRoom = room;
    currentPass = tryPass; // nho mat khau de tu vao lai khi mat ket noi
    $('roomTitle').textContent = '# ' + room;
    $('messages').innerHTML = '';
    history.forEach(addMessage);
    renderUsers(users);   // cung cap nhat danh sach phong
    closePanels();        // tren dien thoai: dong ngan keo sau khi vao phong
  });

  socket.on('msg', addMessage);
  socket.on('users', renderUsers);
  socket.on('sys', addSystem);
  socket.on('warn', (text) => alert(text));
  socket.on('retry-login', () => {
    currentRoom = 'chung';
    currentPass = '';
    currentUsers = [];
    sessionStorage.removeItem('name'); // quen ten de khong bi lap vo han
    socket.disconnect();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  });
}

function joinRoom(room, locked) {
  if (room === currentRoom) { closePanels(); return; }
  let pass = '';
  if (locked) {
    pass = prompt('Nhap mat khau cua phong "' + room + '":');
    if (pass === null) return; // bam Huy
  }
  requestJoin(room, pass);
}

// 3. Ve danh sach phong, moi phong co nguoi ben duoi
function renderRooms() {
  const box = $('roomList');
  box.innerHTML = '';
  lastRooms.forEach(([r, locked, names, total]) => {
    const li = document.createElement('li');
    li.dataset.room = r;
    if (r === currentRoom) li.classList.add('active');
    li.onclick = () => joinRoom(r, locked);

    const title = document.createElement('div');
    title.className = 'rname';
    title.textContent = (locked ? '🔒 ' : '# ') + r;
    li.appendChild(title);

    // Phong hien tai: dung danh sach moi nhat; phong khac: dung du lieu server gui
    const isCur = r === currentRoom;
    const list = isCur ? currentUsers : names;
    const count = isCur ? currentUsers.length : total;
    if (list.length) {
      const members = document.createElement('div');
      members.className = 'members';
      list.slice(0, MAX_SHOWN).forEach((n) => members.appendChild(makeChip(n)));
      if (count > MAX_SHOWN) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = '+' + (count - MAX_SHOWN) + ' nguoi nua';
        members.appendChild(more);
      }
      li.appendChild(members);
    }
    box.appendChild(li);
  });
}

// 4. Hien thi tin nhan
function addMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.style.background = colorOf(m.u);
  avatar.textContent = initialOf(m.u);

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

  pushToBox(div);
}

// Thong bao he thong (chi hien neu server bat SHOW_SYS_MSG)
function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  pushToBox(div);
}

// Them mot dong vao khung chat, chi giu 200 dong gan nhat cho nhe may
function pushToBox(el) {
  const box = $('messages');
  box.appendChild(el);
  while (box.children.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// Cot ONLINE ben phai + cap nhat nguoi trong phong hien tai
function renderUsers(users) {
  currentUsers = users;
  $('userList').innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.appendChild(makeChip(u));
    $('userList').appendChild(li);
  });
  renderRooms();
}

// 5. Gui tin nhan
$('msgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text) return;
  socket.emit('msg', text);
  $('msgInput').value = '';
});

// 6. Tao phong moi (hoac vao phong da co)
$('newRoomForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('newRoomInput').value.trim().toLowerCase().replace(/\s+/g, '-');
  const pass = $('newRoomPass').value;
  if (!name) return;
  $('newRoomInput').value = '';
  $('newRoomPass').value = '';
  closeRoomModal();
  requestJoin(name, pass);
});

// 7. Hop tao phong: mo / dong
function openRoomModal() {
  $('roomModal').classList.remove('hidden');
  $('newRoomInput').focus();
}
function closeRoomModal() {
  $('roomModal').classList.add('hidden');
}
$('addRoomBtn').onclick = openRoomModal;
$('cancelRoomBtn').onclick = closeRoomModal;
$('roomModal').addEventListener('click', (e) => {
  if (e.target === $('roomModal')) closeRoomModal(); // bam ra vung toi ben ngoai
});

// 8. Giao dien dien thoai: ngan keo phong / online
function closePanels() {
  $('rooms').classList.remove('open');
  $('users').classList.remove('open');
  $('backdrop').classList.add('hidden');
}
function togglePanel(id) {
  const willOpen = !$(id).classList.contains('open');
  closePanels();
  if (willOpen) {
    $(id).classList.add('open');
    $('backdrop').classList.remove('hidden');
  }
}
$('menuBtn').onclick = () => togglePanel('rooms');
$('usersBtn').onclick = () => togglePanel('users');
$('backdrop').onclick = closePanels;

// 9. Neu tab nay da dang nhap truoc do (vd vua bam F5) thi tu vao lai
// (doan nay PHAI nam o cuoi file)
const savedName = sessionStorage.getItem('name');
if (savedName) login(savedName);