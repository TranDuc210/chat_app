const $ = (id) => document.getElementById(id);
const MAX_SHOWN = 8; // so nguoi toi da hien duoi moi ten phong
let socket, myName = '';
let currentRoom = 'chung', currentPass = ''; // phong va mat khau dang o
let tryPass = '';                             // mat khau dang thu
let lastRooms = [];                           // danh sach phong moi nhat tu server
let currentUsers = [];                        // nguoi dang o trong phong hien tai
let voiceNames = [];                          // nguoi dang trong voice cua phong hien tai

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
    const badge = document.createElement('span');
    badge.className = 'vbadge';
    badge.textContent = '🎙';
    chip.appendChild(badge);
  }
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
    leaveVoice(false); // mat ket noi thi tu roi voice
    const note = reason === 'io server disconnect'
      ? '(bi ngat ket noi, hay tai lai trang)'
      : '(mat ket noi, dang thu lai...)';
    $('roomTitle').textContent = '# ' + currentRoom + '  ' + note;
  });

  socket.on('rooms', (list) => {
    lastRooms = list;
    renderRooms();
  });

  socket.on('joined', ({ room, history, users, voice }) => {
    // Moi lan vao/doi phong, server deu xoa ban khoi voice -> client cung phai roi voice
    if (inVoice) leaveVoice(false);
    currentRoom = room;
    currentPass = tryPass; // nho mat khau de tu vao lai khi mat ket noi
    voiceNames = voice || [];
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
    leaveVoice(false);
    currentRoom = 'chung';
    currentPass = '';
    currentUsers = [];
    voiceNames = [];
    sessionStorage.removeItem('name'); // quen ten de khong bi lap vo han
    socket.disconnect();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  });

  // ---- Su kien voice tu server ----
  socket.on('voice-users', (names) => {
    voiceNames = names;
    renderUsers(currentUsers);
  });
  socket.on('voice-peers', (ids) => {
    if (!inVoice) return;
    ids.forEach((id) => createPeer(id, true)); // nguoi moi vao thi chu dong goi cho tung nguoi
  });
  socket.on('voice-signal', onSignal);
  socket.on('voice-peer-left', (id) => closePeer(id));
  socket.on('voice-denied', () => leaveVoice(false));
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
    li.appendChild(makeChip(u, voiceNames.includes(u)));
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

let localStream = null;   // micro cua minh
let inVoice = false;      // dang trong voice hay khong
let muted = false;        // dang tat mic hay khong
let warnedFail = false;   // chi bao loi ket noi 1 lan moi phien voice
const peers = new Map();  // id nguoi khac -> { pc, audio, queue }

// Yeu cau ben kia gui am thanh nhe: mono, ~24 kbps, bat DTX (im lang thi gan nhu khong gui gi)
function tuneOpus(sdp) {
  return sdp.replace('useinbandfec=1', 'useinbandfec=1;usedtx=1;maxaveragebitrate=24000;stereo=0');
}

async function joinVoice() {
  if (inVoice || !socket) return;
  if (!window.isSecureContext || !navigator.mediaDevices) {
    alert('Trinh duyet chi cho dung micro tren https:// hoac localhost. Hay mo bang link https cua ban (vi du link Render).');
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false
    });
  } catch (e) {
    alert('Khong mo duoc micro. Hay cho phep trinh duyet dung micro roi thu lai.');
    return;
  }
  inVoice = true;
  muted = false;
  warnedFail = false;
  updateVoiceUI();
  socket.emit('voice-join');
}

// notify = true thi bao cho server biet la minh roi voice
function leaveVoice(notify) {
  if (notify && socket) socket.emit('voice-leave');
  peers.forEach((_, id) => closePeer(id));
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop()); // tat han micro
    localStream = null;
  }
  inVoice = false;
  muted = false;
  updateVoiceUI();
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  updateVoiceUI();
}

function updateVoiceUI() {
  $('voiceBtn').textContent = inVoice ? '📞 Roi voice' : '🎧 Voice';
  $('voiceBtn').classList.toggle('on', inVoice);
  $('muteBtn').classList.toggle('hidden', !inVoice);
  $('muteBtn').textContent = muted ? '🔇' : '🎙';
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  try { peer.pc.close(); } catch (e) { /* bo qua */ }
  if (peer.audio) {
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
}

// Tao ket noi truc tiep voi 1 nguoi. initiator = true thi minh la ben goi truoc.
function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { pc, audio: null, queue: [] };
  peers.set(id, peer);

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('voice-signal', { to: id, data: { candidate: e.candidate.toJSON() } });
    }
  };

  pc.ontrack = (e) => {
    if (peer.audio) return;
    const a = document.createElement('audio');
    a.autoplay = true;
    a.srcObject = e.streams[0];
    $('audioBox').appendChild(a);
    a.play().catch(() => { /* neu bi chan tu dong phat, nguoi dung bam vao trang la phat */ });
    peer.audio = a;
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && peers.get(id) === peer) {
      closePeer(id);
      if (!warnedFail) {
        warnedFail = true;
        alert('Khong ket noi duoc am thanh voi mot nguoi trong phong. Co the mang cua ho hoac cua ban can may chu TURN.');
      }
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

$('voiceBtn').onclick = () => { if (inVoice) leaveVoice(true); else joinVoice(); };
$('muteBtn').onclick = toggleMute;
// ==============================================================

// 11. Neu tab nay da dang nhap truoc do (vd vua bam F5) thi tu vao lai
// (doan nay PHAI nam o cuoi file)
const savedName = sessionStorage.getItem('name');
if (savedName) login(savedName);