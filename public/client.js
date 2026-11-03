const $ = (id) => document.getElementById(id);
const MAX_SHOWN = 8; // so nguoi toi da hien duoi moi ten phong
const GATE_OFF = -80; // thanh nguong o muc nay = tat bo loc tieng on
let socket, myName = '';

let currentRoom = null;
let currentPass = '';

let memberRoom = null;
let memberPass = '';     // Mật khẩu để kết nối lại phòng đang tham gia // phong va mat khau dang o
let tryPass = '';                             // mat khau dang thu
let lastRooms = [];                           // danh sach phong moi nhat tu server
let currentUsers = [];                        // nguoi dang o trong phong hien tai
let voiceNames = [];                          // nguoi dang trong voice cua phong hien tai
let voiceMembers = [];                         // [{ id, name }] socket IDs + ten thanh vien voice
let activeVolumePeerId = null;                 // peer dang mo hop thoai am luong

// Luu cai dat tren may (con nguyen sau khi dong trinh duyet)
const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* bo qua */ }
  }
};
let voiceMode = store.get('voiceMode', 'auto') === 'ptt' ? 'ptt' : 'auto'; // 'auto' | 'ptt'
let pttKey = store.get('pttKey', 'Backquote');                              // phim nhan de noi
let autoVoice = store.get('autoVoice', '1') === '1';                        // tu dong vao voice
let micId = store.get('micId', '');                                         // '' = mac dinh cua may
let spkId = store.get('spkId', '');                                         // '' = mac dinh cua may
let gateDb = Number(store.get('gateDb', String(GATE_OFF)));                 // nguong loc tieng on (dB)
if (!(gateDb >= GATE_OFF && gateDb <= -10)) gateDb = GATE_OFF;

// Dong thong bao nho o cuoi man hinh (thay cho hop thoai)
let toastTimer = null;
let told = {};
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 7000);
}
function toastOnce(key, text) { // moi loai thong bao chi hien 1 lan
  if (told[key]) return;
  told[key] = true;
  toast(text);
}

// Ma nhan dang cua tab nay (giu nguyen khi bam F5, moi tab mot ma)
let cid = sessionStorage.getItem('cid');
if (!cid) {
  cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('cid', cid);
}
const activeCidByUser = new Map();
// ===== Icon dai dien: vong tron mau + chu cai dau (tinh ngay tren may, khong ton bang thong) =====
function colorOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return 'hsl(' + h + ', 55%, 45%)';
}
function initialOf(name) {
  return ([...name][0] || '?').toUpperCase();
}
// Mot "the" gom icon tron + ten (+ bieu tuong micro neu dang trong voice)
function makeChip(name, inVoiceNow) {
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
 if (inVoiceNow) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'vbadge';
  badge.textContent = '🎙';
  badge.title = 'Điều chỉnh âm lượng ' + name;

  badge.addEventListener('click', (e) => {
    e.stopPropagation(); // Không kích hoạt click chọn phòng
    openPeerVolumeForName(name);
  });

  chip.appendChild(badge);
}
  return chip;
}

// 1. Dang nhap

function login(user) {
  myName = user.username;

  // Xóa trạng thái phòng của phiên trước
 currentRoom = null;
currentPass = '';
memberRoom = null;
memberPass = '';
tryPass = '';

  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  socket = io({
  transports: ['websocket'],
  auth: { cid }
});
  setupSocket();
}



// Xử lý đăng nhập tài khoản
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const loginInput = $('loginInput').value.trim();
  const password = $('loginPassword').value;

  $('authError').textContent = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
   body: JSON.stringify({
  login: loginInput,
  password,
  cid
})
    });

    const data = await res.json();

    if (!res.ok) {
      $('authError').textContent = data.error || 'Đăng nhập thất bại.';
      return;
    }

    login(data.user);
  } catch (err) {
    console.error(err);
    $('authError').textContent = 'Không thể kết nối máy chủ.';
  }
});


// Xử lý đăng ký tài khoản
$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = $('registerUsername').value.trim();
  const email = $('registerEmail').value.trim();
  const password = $('registerPassword').value;

  $('authError').textContent = '';

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        email,
        password,
        cid
      })
    });

    const data = await res.json();

    if (!res.ok) {
      $('authError').textContent = data.error || 'Đăng ký thất bại.';
      return;
    }

    login(data.user);
  } catch (err) {
    console.error(err);
    $('authError').textContent = 'Không thể kết nối máy chủ.';
  }
});

// Chuyển sang form đăng ký
$('showRegisterBtn').addEventListener('click', () => {
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('authError').textContent = '';
});

// Chuyển về form đăng nhập
$('showLoginBtn').addEventListener('click', () => {
  $('registerForm').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('authError').textContent = '';
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/logout', {
      method: 'POST'
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Đăng xuất thất bại.');
      return;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    myName = '';

      currentRoom = null;
currentPass = '';

memberRoom = null;
memberPass = '';

tryPass = '';

    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');

    $('loginForm').classList.remove('hidden');
    $('registerForm').classList.add('hidden');

    $('loginInput').value = '';
    $('loginPassword').value = '';
    $('authError').textContent = '';

  } catch (err) {
    console.error(err);
    alert('Không thể kết nối máy chủ.');
  }
});

// Gui yeu cau vao phong (kem mat khau neu co)
function requestJoin(room, pass) {
  tryPass = pass || '';
  socket.emit('join', { room, pass, cid });
}
function requestViewRoom(room, pass) {
  socket.emit('view-room', {
    room,
    pass: pass || ''
  });
}
// 2. Lang nghe su kien tu server
function setupSocket() {
  // Chay MOI LAN ket noi duoc (ke ca ket noi lai)
 socket.on('connect', () => {
  if (memberRoom) {
    requestJoin(memberRoom, memberPass);
  } else {
    console.log('Đã kết nối máy chủ. Chưa tham gia phòng nào.');
  }
});

  socket.on('disconnect', (reason) => {
    leaveVoice(false); // mat ket noi thi tu roi voice (noi lai se tu vao lai)
    const note = reason === 'io server disconnect'
      ? '(bi ngat ket noi, hay tai lai trang)'
      : '(mat ket noi, dang thu lai...)';
    $('roomTitle').textContent = currentRoom
  ? '# ' + currentRoom + '  ' + note
  : 'Chưa tham gia phòng ' + note;
  });

  socket.on('rooms', (list) => {
    lastRooms = list;
    renderRooms();
  });

  socket.on('joined', ({ room, history, users, voice, voiceMembers: members }) => {
    // Moi lan vao/doi phong, server deu xoa ban khoi voice -> client cung phai roi voice
    if (inVoice) leaveVoice(false);
    currentRoom = room;
currentPass = tryPass;

memberRoom = room;
memberPass = tryPass; // nho mat khau de tu vao lai khi mat ket noi
    voiceNames = voice || [];
    voiceMembers = members || [];
    $('roomTitle').textContent = '# ' + room;
    $('messages').innerHTML = '';
    history.forEach(addMessage);
    renderUsers(users);   // cung cap nhat danh sach phong
    closePanels();        // tren dien thoai: dong ngan keo sau khi vao phong
    if (autoVoice && room !== 'chung') joinVoice(); // tu dong vao voice cua phong moi
  });
socket.on('viewed', ({ room, history, users }) => {
  currentRoom = room;

  $('roomTitle').textContent = '# ' + room;
  $('messages').innerHTML = '';

  history.forEach(addMessage);

  voiceNames = [];
  renderUsers(users || []);

  closePanels();
  renderRooms();
});
  socket.on('msg', addMessage);
  socket.on('users', renderUsers);
  socket.on('sys', addSystem);
  socket.on('warn', (text) => alert(text));
  socket.on('retry-login', () => {
  leaveVoice(false);
  currentRoom = null;
  currentPass = '';
  memberRoom = null;
  memberPass = '';
  tryPass = '';
  currentUsers = [];
  voiceNames = [];
  voiceMembers = [];
  socket.disconnect();
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
});

  // ---- Su kien voice tu server ----
  socket.on('voice-users', (names) => {
    voiceNames = names;
    renderUsers(currentUsers);
  });
  socket.on('voice-members', (members) => {
    voiceMembers = Array.isArray(members) ? members : [];
    renderUsers(currentUsers);
  });
  socket.on('voice-peers', (ids) => {
    if (!inVoice) return;
    ids.forEach((id) => createPeer(id, true)); // nguoi moi vao thi chu dong goi cho tung nguoi
  });
  socket.on('voice-signal', onSignal);
  socket.on('voice-peer-left', (id) => closePeer(id));
  socket.on('voice-denied', (max) => {
    leaveVoice(false);
    voiceFull = true;
    updateVoiceUI();
    toast('Voice cua phong nay da day (toi da ' + (max || '') + ' nguoi). Ban van chat chu binh thuong.');
  });
}

function joinRoom(room, locked) {
  if (room === currentRoom) {
    closePanels();
    return;
  }

  let pass = '';

  if (locked) {
    pass = prompt('Nhap mat khau cua phong "' + room + '":');
    if (pass === null) return;
  }

  // Chung chỉ chuyển sang xem tin nhắn
  if (room === 'chung') {
    requestViewRoom(room, pass);
    return;
  }

  // Các phòng khác vẫn tham gia như bình thường
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
      list.slice(0, MAX_SHOWN).forEach((n) =>
        members.appendChild(makeChip(n, isCur && voiceNames.includes(n))));
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
    const inVoiceNow = voiceNames.includes(u);
    li.appendChild(makeChip(u, inVoiceNow));
    
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

// 9. (de trong, giu so thu tu)

// ===================== 10. VOICE (WebRTC) =====================
// May chu STUN giup 2 may tim thay nhau. Neu mang khat khe (4G, hotspot...) co the can them
// may chu TURN: them mot dong { urls: 'turn:...', username: '...', credential: '...' } vao day.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }
];

// Trinh duyet co ho tro chon loa dau ra / bo loc tieng on khong?
const HAS_SINK = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
const HAS_WORKLET = !!(window.AudioContext || window.webkitAudioContext)
  && typeof AudioWorkletNode !== 'undefined' && window.isSecureContext;

const gUM = (constraints) => navigator.mediaDevices.getUserMedia(constraints);

let localStream = null;   // luong micro that (null neu chi nghe)
let rawTrack = null;      // am thanh micro goc
let pipeline = null;      // bo loc tieng on: { ctx, src, node, dest, clone, procTrack }
let building = false;     // dang dung bo loc
let switching = false;    // dang doi micro
let lastSwitchAt = 0;
let inVoice = false;      // da o trong voice cua phong
let joining = false;      // dang xin micro / dang vao voice
let listenOnly = false;   // vao voice nhung khong co micro
let voiceFull = false;    // voice cua phong da day
let muted = false;        // (che do tu dong) dang tat mic
let talking = false;      // (che do nhan de noi) dang giu phim
let capturingKey = false; // dang cho nguoi dung bam phim de doi phim nhan de noi
let meterDb = -100;       // muc mic hien tai (dB) cho thanh do
let devices = { mics: [], spks: [] };
let lastDevSig = '';
const peers = new Map();  // id nguoi khac -> { pc, audio, queue }

// Yeu cau ben kia gui am thanh nhe: mono, ~24 kbps, bat DTX (im lang thi gan nhu khong gui gi)
function tuneOpus(sdp) {
  return sdp.replace('useinbandfec=1', 'useinbandfec=1;usedtx=1;maxaveragebitrate=24000;stereo=0');
}

function micMessage(why) {
  if (why === 'insecure') return 'Khong dung duoc micro vi trang khong phai https hoac localhost. Ban chi nghe duoc.';
  if (why === 'NotAllowedError' || why === 'SecurityError') return 'Ban chua cho phep micro nen chi nghe duoc. Hay cho phep micro (bieu tuong o khoa tren thanh dia chi), roi bam nut "Chi nghe" de thu lai.';
  if (why === 'NotFoundError') return 'Khong tim thay micro, ban chi nghe duoc.';
  return 'Khong mo duoc micro, ban chi nghe duoc.';
}

// ---------- Mo micro theo thiet bi da chon ----------
async function openMic() {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  if (micId) {
    try {
      const s = await gUM({ audio: Object.assign({}, base, { deviceId: { exact: micId } }), video: false });
      return { stream: s, why: '' };
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        return { stream: null, why: e.name };
      }
      toastOnce('mic-missing', 'Khong tim thay micro da chon, dang dung micro mac dinh cua may.');
    }
  }
  try {
    const s = await gUM({ audio: base, video: false });
    return { stream: s, why: '' };
  } catch (e) {
    return { stream: null, why: (e && e.name) || 'error' };
  }
}

// Vao voice cua phong hien tai (tu dong khi vao phong, hoac khi bam nut)
async function joinVoice() {
  if (inVoice || joining || !socket || !socket.connected) return;
  joining = true;
  voiceFull = false;
  updateVoiceUI();
 const myRoom = memberRoom;

if (!myRoom) {
  joining = false;
  updateVoiceUI();
  toast('Bạn cần tham gia một phòng trước khi bật voice.');
  return;
}

if (myRoom === 'chung') {
  joining = false;
  updateVoiceUI();
  toast('Phòng chung chỉ dùng để nhắn tin, không có voice.');
  return;
}

  let stream = null;
  let why = '';
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    why = 'insecure';
  } else {
    const mic = await openMic();
    stream = mic.stream;
    why = mic.why;
  }

  // Trong luc cho micro ma da doi phong hoac mat ket noi thi huy
 if (memberRoom !== myRoom || !socket.connected) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    joining = false;
    updateVoiceUI();
    if (socket.connected && autoVoice && !inVoice) joinVoice(); // vao voice cua phong moi
    return;
  }

  localStream = stream;
  rawTrack = stream ? stream.getAudioTracks()[0] : null;
  listenOnly = !stream;
  inVoice = true;
  joining = false;
  muted = false;
  talking = false;

  if (stream) {
    // Kiem tra trinh duyet co that su bat chong vang khong
    const s = rawTrack.getSettings();
    if (s.echoCancellation === false) {
      toastOnce('aec', 'Trinh duyet nay khong bat duoc chong vang. Hay dung tai nghe hoac chuyen sang che do Nhan de noi.');
    }
    lastSwitchAt = Date.now();
    refreshDevices(false); // da co quyen micro -> doc duoc ten thiet bi
    buildPipeline();       // bo do muc mic + cong loc tieng on
  } else {
    toastOnce('nomic:' + why, micMessage(why));
  }

  applyMic();
  updateVoiceUI();
  socket.emit('voice-join');
}

// notify = true thi bao cho server biet la minh roi voice
function leaveVoice(notify) {
  if (notify && socket && socket.connected) socket.emit('voice-leave');
  peers.forEach((_, id) => closePeer(id));
  stopPipeline();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop()); // tat han micro
    localStream = null;
  }
  rawTrack = null;
  inVoice = false;
  listenOnly = false;
  muted = false;
  talking = false;
  voiceFull = false;
  updateVoiceUI();
}

// Doi micro khi dang trong voice (khong ngat ket noi voi moi nguoi)
async function switchMic() {
  if (!inVoice || !localStream || switching) return;
  switching = true;
  try {
    const mic = await openMic();
    if (!mic.stream) {
      toast('Khong mo duoc micro moi, van dung micro cu.');
      return;
    }
    if (!inVoice) { // trong luc cho ma da roi voice
      mic.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const old = localStream;
    localStream = mic.stream;
    rawTrack = mic.stream.getAudioTracks()[0];
    if (pipeline) { // noi micro moi vao bo loc
      try { pipeline.src.disconnect(); pipeline.clone.stop(); } catch (e) { /* bo qua */ }
      pipeline.clone = rawTrack.clone();
      pipeline.src = pipeline.ctx.createMediaStreamSource(new MediaStream([pipeline.clone]));
      pipeline.src.connect(pipeline.node);
    }
    applyMic();
    syncSenders(); // dat track moi vao cac ket noi dang co (khong can goi lai)
    old.getTracks().forEach((t) => t.stop());
    lastSwitchAt = Date.now();
  } finally {
    switching = false;
  }
}

// ---------- Bo do muc mic + cong loc tieng on (AudioWorklet) ----------
async function buildPipeline() {
  if (!HAS_WORKLET || !localStream || pipeline || building) return;
  building = true;
  const stream = localStream;
  let ctx = null;
  let retry = false;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('gate-worklet.js');
    if (localStream !== stream || !inVoice) { // da doi / roi voice trong luc cho
      ctx.close();
      retry = true;
      return;
    }
    // Dung ban sao cua track de do muc, nen tat mic van do duoc muc
    const clone = rawTrack.clone();
    const src = ctx.createMediaStreamSource(new MediaStream([clone]));
    const node = new AudioWorkletNode(ctx, 'gate-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
    });
    const dest = ctx.createMediaStreamDestination();
    src.connect(node);
    node.connect(dest);
    node.port.onmessage = (e) => onMeter(e.data);
    pipeline = { ctx, src, node, dest, clone, procTrack: dest.stream.getAudioTracks()[0] };
    ctx.onstatechange = () => { syncSenders(); renderMeter(); };
    sendGate();
    applyMic();
    syncSenders();
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => { /* cho nguoi dung bam vao trang */ });
      if (gateDb > GATE_OFF) {
        toastOnce('gate-susp', 'Hay bam vao man hinh mot lan de bo loc tieng on hoat dong. Luc nay mic van gui am thanh binh thuong.');
      }
    }
  } catch (err) {
    console.warn('Khong tao duoc bo loc tieng on', err);
    toastOnce('gate-fail', 'Khong khoi dong duoc bo loc tieng on. Voice van hoat dong binh thuong.');
    if (ctx) { try { ctx.close(); } catch (e) { /* bo qua */ } }
    pipeline = null;
  } finally {
    building = false;
    if (retry && inVoice && localStream && !pipeline) setTimeout(buildPipeline, 0);
  }
}

function stopPipeline() {
  if (!pipeline) return;
  const p = pipeline;
  pipeline = null;
  try { p.ctx.onstatechange = null; } catch (e) { /* bo qua */ }
  try { p.node.port.onmessage = null; p.src.disconnect(); p.node.disconnect(); } catch (e) { /* bo qua */ }
  try { p.clone.stop(); } catch (e) { /* bo qua */ }
  try { p.procTrack.stop(); } catch (e) { /* bo qua */ }
  try { p.ctx.close(); } catch (e) { /* bo qua */ }
  meterDb = -100;
  renderMeter();
}

// Gui nguong dB hien tai cho bo loc (0 = khong loc)
function sendGate() {
  if (!pipeline) return;
  const thr = gateDb > GATE_OFF ? Math.pow(10, gateDb / 20) : 0;
  pipeline.node.port.postMessage({ thr });
}

// Chi gui am thanh DA LOC khi bo loc dang bat va dang chay; con lai gui thang tu micro
function currentSendTrack() {
  if (pipeline && pipeline.ctx.state === 'running' && gateDb > GATE_OFF) return pipeline.procTrack;
  return rawTrack;
}

// Dat track dang dung vao tat ca cac ket noi voice (khong can thuong luong lai)
function syncSenders() {
  const t = currentSendTrack();
  if (!t) return;
  peers.forEach((p) => {
    p.pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === 'audio' && s.track !== t) s.replaceTrack(t).catch(() => { /* bo qua */ });
    });
  });
}

// Bat / tat micro that su theo che do hien tai
//  - tu dong: mo tru khi minh tat tieng
//  - nhan de noi: chi mo khi dang giu phim
function applyMic() {
  const on = voiceMode === 'auto' ? !muted : talking;
  if (rawTrack) rawTrack.enabled = on;
  if (pipeline) pipeline.procTrack.enabled = on;
}

function setTalking(v) {
  if (voiceMode !== 'ptt' || !localStream || !inVoice) v = false;
  if (talking === v) return;
  talking = v;
  applyMic();
  updateVoiceUI();
}

function setMode(m) {
  voiceMode = m;
  store.set('voiceMode', m);
  talking = false;
  applyMic();
  updateVoiceUI();
  renderSettings();
}

// Nut trang thai tren thanh tieu de
function updateVoiceUI() {
  const b = $('voiceBtn');
  b.classList.remove('on', 'talk', 'off', 'warn');
  let text, tip;
  if (joining) {
    text = '⏳ Voice...'; tip = 'Dang vao voice'; b.classList.add('off');
  } else if (!inVoice) {
    text = voiceFull ? '🚫 Voice day' : '🎧 Bat voice';
    tip = voiceFull ? 'Voice cua phong da day, bam de thu lai' : 'Bam de vao voice cua phong';
    b.classList.add('off');
  } else if (listenOnly) {
    text = '🎧 Chi nghe'; tip = 'Khong co micro. Bam de thu mo lai micro'; b.classList.add('warn');
  } else if (voiceMode === 'auto') {
    if (muted) { text = '🔇 Mic tat'; tip = 'Bam de bat mic'; b.classList.add('warn'); }
    else { text = '🎙 Mic mo'; tip = 'Bam de tat mic'; b.classList.add('on'); }
  } else if (talking) {
    text = '🎤 Dang noi'; tip = 'Tha ra de ngung noi'; b.classList.add('talk');
  } else {
    text = '🎤 Giu de noi'; tip = 'Giu nut nay (hoac phim ' + keyLabel(pttKey) + ') de noi'; b.classList.add('on');
  }
  b.textContent = text;
  b.title = tip;
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  if (activeVolumePeerId === id) closePeerVolumeDialog();
  peers.delete(id);
  try { peer.pc.close(); } catch (e) { /* bo qua */ }
  if (peer.audio) {
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
}

// Doi loa / tai nghe phat am thanh cho mot the <audio>
function applySink(a) {
  if (!HAS_SINK || !a) return;
  a.setSinkId(spkId || '').catch(() => {
    toastOnce('sink-fail', 'Khong chuyen duoc sang loa/tai nghe da chon (co the da bi rut ra). Dang dung thiet bi mac dinh.');
  });
}

// Tao ket noi truc tiep voi 1 nguoi. initiator = true thi minh la ben goi truoc.
function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { pc, audio: null, queue: [], name: getVoiceMemberName(id) };
  peers.set(id, peer);

  if (localStream) {
    pc.addTrack(currentSendTrack(), localStream);
  } else if (initiator) {
    pc.addTransceiver('audio', { direction: 'recvonly' }); // khong co mic: chi nhan
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('voice-signal', { to: id, data: { candidate: e.candidate.toJSON() } });
    }
  };

  pc.ontrack = (e) => {
    if (peer.audio) return;
    const a = document.createElement('audio');
    a.autoplay = true;
    a.srcObject = e.streams[0] || new MediaStream([e.track]);
    peer.audio = a;
    $('audioBox').appendChild(a);
    applySink(a);
    applyPeerVolume(id);
    a.play().catch(() => {
      toastOnce('autoplay', 'Trinh duyet dang chan am thanh. Hay bam vao trang mot lan de nghe.');
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && peers.get(id) === peer) {
      closePeer(id);
      toastOnce('ice', 'Khong ket noi duoc am thanh voi mot nguoi trong phong. Co the mang cua ho hoac cua ban can may chu TURN.');
    }
  };

  if (initiator) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        offer.sdp = tuneOpus(offer.sdp);
        await pc.setLocalDescription(offer);
        socket.emit('voice-signal', {
          to: id,
          data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }
        });
      } catch (err) {
        console.warn('Loi tao loi moi voice', err);
      }
    })();
  }
  return peer;
}

// Nhan "thuong luong" tu nguoi khac (loi moi, tra loi, ung vien ket noi)
async function onSignal({ from, data }) {
  if (!inVoice || !data) return;
  let peer = peers.get(from);
  try {
    if (data.sdp) {
      if (!peer) peer = createPeer(from, false);
      await peer.pc.setRemoteDescription(data.sdp);
      for (const c of peer.queue) await peer.pc.addIceCandidate(c);
      peer.queue = [];
      if (data.sdp.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        answer.sdp = tuneOpus(answer.sdp);
        await peer.pc.setLocalDescription(answer);
        socket.emit('voice-signal', {
          to: from,
          data: { sdp: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } }
        });
      }
    } else if (data.candidate) {
      if (!peer) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
      else peer.queue.push(data.candidate); // chua co mo ta tu xa thi xep hang cho
    }
  } catch (err) {
    console.warn('Loi xu ly goi voice', err);
  }
}

// ---------- Danh sach thiet bi am thanh ----------
async function refreshDevices(askPermission) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    renderDevices();
    return;
  }
  try {
    let list = await navigator.mediaDevices.enumerateDevices();
    const noNames = () => {
      const m = list.filter((d) => d.kind === 'audioinput');
      return m.length === 0 || m.every((d) => !d.label);
    };
    if (askPermission && window.isSecureContext && noNames()) {
      try { // xin quyen micro mot lan de trinh duyet cho biet ten thiet bi
        const s = await gUM({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      } catch (e) {
        toast('Khong mo duoc micro nen chua doc duoc ten thiet bi. Hay cho phep micro cho trang nay.');
      }
    }
    // Bo hai muc ao "default" va "communications" (da co lua chon "Mac dinh cua may")
    const real = (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
    devices.mics = list.filter((d) => d.kind === 'audioinput' && real(d));
    devices.spks = list.filter((d) => d.kind === 'audiooutput' && real(d));
    lastDevSig = list
      .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
      .map((d) => d.kind + ':' + d.deviceId).sort().join('|');
  } catch (e) { /* bo qua */ }
  renderDevices();
}


/* =========================================================
   CUSTOM AUDIO DEVICE DROPDOWN
   Thay hàm fillSelect cũ bằng toàn bộ phần này
========================================================= */

function setupDeviceDropdown(sel) {
  if (sel._customDeviceDropdown) return;

  sel.classList.add('native-device-select');

  const wrapper = document.createElement('div');
  wrapper.className = 'device-select';
  wrapper.dataset.selectId = sel.id;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'device-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const icon = document.createElement('span');
  icon.className = 'device-select-icon';
  icon.textContent = sel.id === 'micSelect' ? '🎙' : '🎧';

  const label = document.createElement('span');
  label.className = 'device-select-label';

  const arrow = document.createElement('span');
  arrow.className = 'device-select-arrow';
  arrow.innerHTML = `
    <svg viewBox="0 0 24 24"
         width="18"
         height="18"
         fill="none"
         stroke="currentColor"
         stroke-width="2.2"
         stroke-linecap="round"
         stroke-linejoin="round">
        <path d="m7 10 5 5 5-5"/>
    </svg>
`;

  trigger.append(icon, label, arrow);

  const menu = document.createElement('div');
  menu.className = 'device-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrapper.append(trigger, menu);

  sel.insertAdjacentElement('afterend', wrapper);

  sel._customDeviceDropdown = {
    wrapper,
    trigger,
    label,
    icon,
    arrow,
    menu
  };

  trigger.addEventListener('click', () => {
    if (sel.disabled) return;

    const isOpen = !menu.hidden;

    closeAllDeviceDropdowns();

    if (!isOpen) {
      menu.hidden = false;
      wrapper.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();

      if (menu.hidden) {
        trigger.click();
      } else {
        const first = menu.querySelector('.device-option');
        if (first) first.focus();
      }
    }
  });

  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.device-option')];
    const index = items.indexOf(document.activeElement);

    if (e.key === 'Escape') {
      closeAllDeviceDropdowns();
      trigger.focus();
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(index + 1, items.length - 1)]?.focus();
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(index - 1, 0)]?.focus();
    }
  });

  if (!window._deviceDropdownOutsideHandler) {
    window._deviceDropdownOutsideHandler = true;

    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.device-select')) {
        closeAllDeviceDropdowns();
      }
    });
  }
}

function closeAllDeviceDropdowns() {
  document.querySelectorAll('.device-select').forEach((wrapper) => {
    wrapper.classList.remove('open');

    const menu = wrapper.querySelector('.device-select-menu');
    const trigger = wrapper.querySelector('.device-select-trigger');

    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function syncDeviceDropdown(sel) {
  setupDeviceDropdown(sel);

  const ui = sel._customDeviceDropdown;
  if (!ui) return;

  const selectedOption = sel.options[sel.selectedIndex];

  ui.label.textContent = selectedOption
    ? selectedOption.textContent
    : 'Mac dinh cua may';

  ui.trigger.disabled = sel.disabled;
  ui.wrapper.classList.toggle('disabled', sel.disabled);

  ui.menu.innerHTML = '';

  [...sel.options].forEach((option, index) => {
    const item = document.createElement('button');

    item.type = 'button';
    item.className = 'device-option';
    item.setAttribute('role', 'option');

    const isSelected = option.value === sel.value;

    item.setAttribute('aria-selected', String(isSelected));

    const itemIcon = document.createElement('span');
    itemIcon.className = 'device-option-icon';

    if (index === 0) {
      itemIcon.textContent = '⚙';
    } else {
      itemIcon.textContent = sel.id === 'micSelect' ? '🎙' : '🎧';
    }

    const itemText = document.createElement('span');
    itemText.className = 'device-option-text';
    itemText.textContent = option.textContent;

    const check = document.createElement('span');
    check.className = 'device-option-check';
    check.textContent = isSelected ? '✓' : '';

    item.append(itemIcon, itemText, check);

    item.addEventListener('click', () => {
      sel.value = option.value;

      // Gọi đúng logic onchange cũ trong client.js
      sel.dispatchEvent(new Event('change', {
        bubbles: true
      }));

      syncDeviceDropdown(sel);
      closeAllDeviceDropdowns();
    });

    ui.menu.appendChild(item);
  });
}

function fillSelect(sel, list, current, defLabel, prefix) {
  setupDeviceDropdown(sel);

  sel.innerHTML = '';

  const def = document.createElement('option');
  def.value = '';
  def.textContent = defLabel;

  sel.appendChild(def);

  list.forEach((dev, i) => {
    const option = document.createElement('option');

    option.value = dev.deviceId;
    option.textContent = dev.label || (prefix + ' ' + (i + 1));

    sel.appendChild(option);
  });

  sel.value = current;

  if (sel.value !== current) {
    sel.value = '';
  }

  syncDeviceDropdown(sel);
}


function renderDevices() {
  fillSelect($('micSelect'), devices.mics, micId, 'Mặc định của máy', 'Micro');
  fillSelect($('spkSelect'), devices.spks, spkId, 'Mặc định của máy', 'Loa');
  $('spkSelect').disabled = !HAS_SINK;
  syncDeviceDropdown($('spkSelect'));
  const notes = [];
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    notes.push('Trình duyệt không hỗ trợ liên kết thiết bị âm thanh.');
  } else if (devices.mics.length === 0 || devices.mics.every((d) => !d.label)) {
    notes.push('chưa đọc được tên thiết bị: hãy cho phép micro rồi bấm "Làm mới danh sách thiết bị".');
  }
  if (!HAS_SINK) {
    notes.push('Trinh duyet nay khong cho chon loa/tai nghe dau ra (Safari, iPhone...). Hay doi trong cai dat he thong.');
  } else if (devices.spks.length === 0) {
    notes.push('Trinh duyet chua liet ke duoc thiet bi dau ra, dang dung thiet bi mac dinh.');
  }
  $('deviceHint').textContent = notes.join(' ');
}

// Cam / rut tai nghe: cap nhat danh sach va theo thiet bi moi
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  let devTimer = null;
  navigator.mediaDevices.addEventListener('devicechange', () => {
    clearTimeout(devTimer);
    devTimer = setTimeout(async () => {
      if (Date.now() - lastSwitchAt < 3000) return; // bo qua thay doi do chinh viec mo micro gay ra
      const before = lastDevSig;
      await refreshDevices(false);
      if (lastDevSig === before) return;
      if (inVoice && localStream) switchMic();           // mo lai micro theo thiet bi moi
      peers.forEach((p) => applySink(p.audio));          // phat lai theo loa moi
    }, 600);
  });
}

// ---------- Thanh do muc mic va thanh nguong ----------
function onMeter(d) {
  meterDb = d.db;
  if (!$('voiceModal').classList.contains('hidden')) renderMeter();
}

function renderMeter() {
  const bar = $('meterBar');
  const text = $('meterText');
  if (!pipeline) {
    bar.style.width = '0%';
    bar.className = '';
    if (!HAS_WORKLET) text.textContent = 'Trinh duyet nay khong ho tro bo loc tieng on (can https hoac localhost).';
    else if (inVoice && localStream) text.textContent = 'Dang khoi dong bo do muc mic...';
    else text.textContent = 'Vao voice (co micro) de xem muc mic.';
    return;
  }
  const pct = Math.max(0, Math.min(100, ((meterDb + 80) / 80) * 100));
  bar.style.width = pct + '%';
  const gateOn = gateDb > GATE_OFF;
  bar.className = gateOn ? (meterDb >= gateDb ? 'open' : 'closed') : '';
  let t = 'Muc mic hien tai: ' + Math.round(meterDb) + ' dB';
  if (pipeline.ctx.state !== 'running') t += ' (bam vao man hinh de bat do)';
  text.textContent = t;
}

function renderGateUI() {
  $('gateSlider').value = String(gateDb);
  $('gateSlider').disabled = !HAS_WORKLET;
  $('gateLabel').textContent = gateDb > GATE_OFF ? gateDb + ' dB' : 'Tat';
  $('meterThr').style.left = ((gateDb + 80) / 80) * 100 + '%';
  $('meterThr').classList.toggle('hidden', gateDb <= GATE_OFF);
}

$('gateSlider').oninput = () => {
  gateDb = Number($('gateSlider').value);
  store.set('gateDb', String(gateDb));
  sendGate();
  syncSenders(); // bat/tat bo loc thi doi track dang gui
  renderGateUI();
  renderMeter();
};

// ---- Nut tren thanh tieu de ----
const vb = $('voiceBtn');

// Che do nhan de noi: giu nut de noi (dung duoc ca tren dien thoai)
vb.addEventListener('pointerdown', (e) => {
  if (voiceMode === 'ptt' && inVoice && localStream) {
    e.preventDefault();
    try { vb.setPointerCapture(e.pointerId); } catch (err) { /* bo qua */ }
    setTalking(true);
  }
});
vb.addEventListener('pointerup', () => setTalking(false));
vb.addEventListener('pointercancel', () => setTalking(false));
vb.addEventListener('contextmenu', (e) => e.preventDefault()); // chan menu khi giu lau tren dien thoai

// Bam (nhan roi tha) nut
vb.addEventListener('click', () => {
  if (joining) return;
  if (!inVoice) { joinVoice(); return; }
  if (listenOnly) { // thu mo lai micro
    told = {};
    leaveVoice(true);
    joinVoice();
    return;
  }
  if (voiceMode === 'auto') { // tat / bat mic
    muted = !muted;
    applyMic();
    updateVoiceUI();
  }
});

// ---- Phim nhan de noi ----
function keyLabel(code) {
  const names = {
    Backquote: '` (ben trai so 1)',
    ControlLeft: 'Ctrl trai', ControlRight: 'Ctrl phai',
    AltLeft: 'Alt trai', AltRight: 'Alt phai',
    ShiftLeft: 'Shift trai', ShiftRight: 'Shift phai',
    CapsLock: 'Caps Lock'
  };
  return names[code] || code;
}

// Chi cho dung phim khong go ra chu (de khong can tro viec chat)
function isAllowedPttKey(e) {
  if (e.code === 'Backquote') return true;
  const deny = ['Enter', 'Backspace', 'Escape', 'Tab', 'Delete', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Process', 'Dead', 'Unidentified', 'Meta', 'OS'];
  if (deny.includes(e.key)) return false;
  return e.key.length > 1; // phim co ten (Control, Alt, F1...) khong go ra chu
}

document.addEventListener('keydown', (e) => {
  // Dang doi phim moi trong hop cai dat
  if (capturingKey) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { capturingKey = false; renderSettings(); return; }
    if (!isAllowedPttKey(e)) {
      toast('Phim nay khong dung duoc (se can tro viec go chu). Hay chon phim khac, vi du ` , Ctrl, F4...');
      return;
    }
    pttKey = e.code;
    store.set('pttKey', pttKey);
    capturingKey = false;
    renderSettings();
    updateVoiceUI();
    return;
  }
  // Giu phim de noi
  if (voiceMode === 'ptt' && inVoice && localStream && e.code === pttKey) {
    e.preventDefault();
    if (!e.repeat) setTalking(true);
  }
}, true);

document.addEventListener('keyup', (e) => {
  if (e.code === pttKey && talking) {
    e.preventDefault();
    setTalking(false);
  }
}, true);

// Tranh bi "ket mic": roi khoi tab / cua so la ngung noi ngay
window.addEventListener('blur', () => setTalking(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) setTalking(false); });

// Neu trinh duyet chan tu dong phat am thanh, bam vao trang la phat duoc
function resumeAudio() {
  peers.forEach((p) => {
    if (p.audio && p.audio.paused) p.audio.play().catch(() => { /* bo qua */ });
  });
  if (pipeline && pipeline.ctx.state === 'suspended') pipeline.ctx.resume().catch(() => { /* bo qua */ });
}
document.addEventListener('pointerdown', resumeAudio, true);
document.addEventListener('keydown', resumeAudio, true);

// ---- Am luong nghe rieng tung thanh vien voice (local-only) ----
function getVoiceMemberName(id) {
  const member = voiceMembers.find((m) => m && m.id === id);
  const peer = peers.get(id);
  return (member && member.name) || (peer && peer.name) || '';
}

function peerVolumeKey(name) {
  return 'peerVolume:' + memberRoom + ':' + name;
}

function peerMuteKey(name) {
  return 'peerMuted:' + memberRoom + ':' + name;
}
function getPeerVolume(name) {
  const value = Number(store.get(peerVolumeKey(name), '100'));
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
}
function getPeerMuted(name) {
  return store.get(peerMuteKey(name), '0') === '1';
}
function applyPeerVolume(id) {
  const peer = peers.get(id);
  if (!peer || !peer.audio) return;
  const name = getVoiceMemberName(id);
  if (!name) return;
  peer.name = name;
  peer.audio.volume = getPeerVolume(name) / 100;
  peer.audio.muted = getPeerMuted(name);
}

function openPeerVolumeForName(name) {
  const member = voiceMembers.find((m) => m && m.name === name);
  if (!member || !peers.has(member.id)) {
    toast('Chua ket noi duoc am thanh voi thanh vien nay.');
    return;
  }
  activeVolumePeerId = member.id;
  const peer = peers.get(member.id);
  if (peer) peer.name = name;

  $('peerVolumeName').textContent = name;
  $('peerVolumeSlider').value = String(getPeerVolume(name));
  $('peerVolumeValue').textContent = getPeerVolume(name) + '%';
  $('peerMuteCheckbox').checked = getPeerMuted(name);
  $('peerVolumeModal').classList.remove('hidden');
}
function closePeerVolumeDialog() {
  activeVolumePeerId = null;
  $('peerVolumeModal').classList.add('hidden');
}
function activeVolumePeerName() {
  return activeVolumePeerId ? getVoiceMemberName(activeVolumePeerId) : '';
}

$('peerVolumeSlider').addEventListener('input', () => {
  const name = activeVolumePeerName();
  if (!name || !activeVolumePeerId) return;
  const value = Number($('peerVolumeSlider').value);
  store.set(peerVolumeKey(name), String(value));
  $('peerVolumeValue').textContent = value + '%';
  applyPeerVolume(activeVolumePeerId);
});
$('peerMuteCheckbox').addEventListener('change', () => {
  const name = activeVolumePeerName();
  if (!name || !activeVolumePeerId) return;
  store.set(peerMuteKey(name), $('peerMuteCheckbox').checked ? '1' : '0');
  applyPeerVolume(activeVolumePeerId);
});
$('closePeerVolumeBtn').addEventListener('click', closePeerVolumeDialog);
$('closePeerVolumeBtnBottom').addEventListener('click', closePeerVolumeDialog);
$('peerVolumeModal').addEventListener('click', (e) => {
  if (e.target === $('peerVolumeModal')) closePeerVolumeDialog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('peerVolumeModal').classList.contains('hidden')) {
    closePeerVolumeDialog();
  }
});

// ---- Hop cai dat voice ----
function renderSettings() {
  $('optAuto').checked = autoVoice;
  document.querySelectorAll('input[name="vmode"]').forEach((r) => { r.checked = r.value === voiceMode; });
  $('pttKeyRow').classList.toggle('hidden', voiceMode !== 'ptt');
  $('pttKeyBtn').textContent = capturingKey ? 'Nhấn một phím...' : keyLabel(pttKey);
  $('leaveVoiceBtn').classList.toggle('hidden', !inVoice);
  renderDevices();
  renderGateUI();
  renderMeter();
}
function closeSettings() {
  capturingKey = false;
  $('voiceModal').classList.add('hidden');
}
$('settingsBtn').onclick = () => {
  renderSettings();
  $('voiceModal').classList.remove('hidden');
  refreshDevices(false); // lam moi danh sach thiet bi moi lan mo
};
$('closeVoiceModal').onclick = closeSettings;
$('voiceModal').addEventListener('click', (e) => {
  if (e.target === $('voiceModal')) closeSettings(); // bam ra vung toi ben ngoai
});
$('optAuto').onchange = () => {
  autoVoice = $('optAuto').checked;
  store.set('autoVoice', autoVoice ? '1' : '0');
  if (autoVoice && !inVoice && !joining) joinVoice(); // vua bat thi vao luon
};
document.querySelectorAll('input[name="vmode"]').forEach((r) => {
  r.onchange = () => { if (r.checked) setMode(r.value); };
});
$('pttKeyBtn').onclick = () => {
  capturingKey = true;
  renderSettings();
};
$('leaveVoiceBtn').onclick = () => {
  leaveVoice(true);
  renderSettings();
  toast('Bạn đã rời voice của phòng này. Bấm nút "Bật voice" hoặc đổi phòng để vào lại.');
};

// ---- Chon thiet bi ----
$('micSelect').onchange = () => {
  micId = $('micSelect').value;
  store.set('micId', micId);
  if (inVoice && localStream) switchMic(); // doi micro ngay, khong ngat voice
};
$('spkSelect').onchange = () => {
  spkId = $('spkSelect').value;
  store.set('spkId', spkId);
  peers.forEach((p) => applySink(p.audio));
};
$('refreshDevBtn').onclick = () => refreshDevices(true);

updateVoiceUI();
renderSettings();
// ==============================================================

// 11. Neu tab nay da dang nhap truoc do (vd vua bam F5) thi tu vao lai
// (doan nay PHAI nam o cuoi file)

// Kiểm tra tài khoản đã đăng nhập trước đó
async function checkLogin() {
  try {
    const res = await fetch('/api/me', {
  headers: {
    'X-Client-ID': cid
  }
});
    const data = await res.json();

    if (res.ok && data.user) {
      login(data.user);
    }
  } catch (err) {
    console.error('Không thể kiểm tra đăng nhập:', err);
  }
}

checkLogin();
