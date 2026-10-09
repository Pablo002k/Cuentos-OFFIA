import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithPopup, GoogleAuthProvider, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy,
  onSnapshot, serverTimestamp, runTransaction, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyABMAbPxBFU8IsAIk7kE8U5CL8fbT8u5k4",
  authDomain: "cuentos-offia.firebaseapp.com",
  projectId: "cuentos-offia",
  storageBucket: "cuentos-offia.firebasestorage.app",
  messagingSenderId: "236762483109",
  appId: "1:236762483109:web:67393b3a672b5bf05b404c"
};

const ADMIN_EMAIL = "agustincejas2@gmail.com";

const COOLDOWN_SECONDS = 40;
const MAX_WORDS = 3;
const MAX_NICKNAME_LENGTH = 20;

/* ============================================================ */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let currentNickname = null;
let isAdmin = false;
let cooldownInterval = null;

const $ = (id) => document.getElementById(id);
const loadingScreen = $('loading');
const nicknameScreen = $('nickname-screen');
const writingRoom = $('writing-room');
const adminPanel = $('admin-panel');

function showScreen(s) {
  [loadingScreen, nicknameScreen, writingRoom, adminPanel].forEach(x => x.classList.add('hidden'));
  s.classList.remove('hidden');
}

function normalizeText(t) {
  return t.trim().replace(/\s+/g, ' ');
}
function countWords(t) {
  const n = normalizeText(t);
  return n === '' ? 0 : n.split(' ').filter(w => w.length > 0).length;
}
function showError(msg) {
  $('input-error').textContent = msg;
  setTimeout(() => {
    if ($('input-error').textContent === msg) $('input-error').textContent = '';
  }, 4000);
}

/* ============ AUTENTICACIÓN ============ */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { console.error(e); alert('Error al conectar con Firebase.'); }
    return;
  }
  currentUser = user;

  if (user.email === ADMIN_EMAIL) {
    isAdmin = true;
    await ensureStateDoc();
    setupAdmin();
    setupWritingRoom();
    showScreen(adminPanel);
    return;
  }

  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (userSnap.exists() && userSnap.data().nickname) {
    currentNickname = userSnap.data().nickname;
    setupWritingRoom();
    showScreen(writingRoom);
  } else {
    showScreen(nicknameScreen);
  }
});

/* ============ RESERVA DE APODO ============ */
$('enter-btn').addEventListener('click', async () => {
  const raw = $('nickname-input').value.trim();
  const errEl = $('nickname-error');
  errEl.textContent = '';
  if (raw.length < 2) { errEl.textContent = 'Mínimo 2 caracteres'; return; }
  if (raw.length > MAX_NICKNAME_LENGTH) { errEl.textContent = `Máximo ${MAX_NICKNAME_LENGTH}`; return; }
  const key = raw.toLowerCase();
  try {
    await runTransaction(db, async (tx) => {
      const nickRef = doc(db, 'nicknames', key);
      const snap = await tx.get(nickRef);
      if (snap.exists()) throw new Error('Ese apodo ya está en uso');
      tx.set(nickRef, { nickname: raw, uid: currentUser.uid, createdAt: serverTimestamp() });
      tx.set(doc(db, 'users', currentUser.uid), {
        nickname: raw, nicknameKey: key, createdAt: serverTimestamp(), lastContributionAt: null
      });
    });
    currentNickname = raw;
    setupWritingRoom();
    showScreen(writingRoom);
  } catch (e) {
    errEl.textContent = e.message || 'Error al reservar apodo';
  }
});
$('nickname-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('enter-btn').click(); });

/* ============ ADMINISTRADOR ============ */
$('admin-login-btn').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { console.error(e); alert('No se pudo iniciar sesión con Google'); }
});

async function ensureStateDoc() {
  const ref = doc(db, 'state', 'current');
  const snap = await getDoc(ref);
  if (!snap.exists()) await setDoc(ref, { status: 'writing_closed', published: false });
}

function setupAdmin() {
  $('admin-email').textContent = currentUser.email;
  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    if (!snap.exists()) return;
    const isOpen = snap.data().status === 'writing_open';
    $('toggle-btn').textContent = isOpen ? 'Cerrar escritura' : 'Abrir escritura';
    $('state-info').textContent = isOpen ? 'La escritura está ABIERTA.' : 'La escritura está CERRADA.';
  });
  $('toggle-btn').addEventListener('click', async () => {
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const current = snap.exists() ? snap.data().status : 'writing_closed';
    const next = current === 'writing_open' ? 'writing_closed' : 'writing_open';
    await setDoc(ref, { status: next, updatedAt: serverTimestamp() }, { merge: true });
  });
}

/* ============ SALA DE ESCRITURA ============ */
function setupWritingRoom() {
  $('my-nickname').textContent = currentNickname || 'Admin';
  const statusBadge = $('status-badge');

  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const isOpen = snap.exists() && snap.data().status === 'writing_open';
    statusBadge.textContent = isOpen ? '🟢 Escritura abierta' : '🔴 Escritura cerrada';
    statusBadge.className = 'badge ' + (isOpen ? 'open' : 'closed');
    updateInputState(isOpen);
  });

  const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
  onSnapshot(q, (snap) => {
    const parts = [];
    snap.forEach(d => { if (d.data().text) parts.push(d.data().text); });
    const el = $('story-container');
    el.textContent = parts.join(' ');
    el.scrollTop = el.scrollHeight;
  });
}

function updateInputState(isOpen) {
  const on = isOpen && !cooldownInterval;
  $('word-input').disabled = !on;
  $('send-btn').disabled = !on;
}

/* ============ ENVÍO ============ */
$('send-btn').addEventListener('click', sendContribution);
$('word-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendContribution(); });
$('word-input').addEventListener('input', () => {
  const parts = normalizeText($('word-input').value).split(' ').filter(w => w.length > 0);
  if (parts.length > MAX_WORDS) {
    $('word-input').value = parts.slice(0, MAX_WORDS).join(' ');
    showError(`Máximo ${MAX_WORDS} palabras`);
  }
});

async function sendContribution() {
  if (cooldownInterval) return;
  const text = normalizeText($('word-input').value);
  const words = countWords(text);
  if (words === 0) { showError('Escribe al menos una palabra'); return; }
  if (words > MAX_WORDS) { showError(`Máximo ${MAX_WORDS} palabras`); return; }

  $('send-btn').disabled = true;
  try {
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'contributions')), {
      uid: currentUser.uid,
      nickname: currentNickname,
      text, wordCount: words,
      createdAt: serverTimestamp()
    });
    batch.update(doc(db, 'users', currentUser.uid), {
      lastContributionAt: serverTimestamp()
    });
    await batch.commit();
    $('word-input').value = '';
    startCooldown(COOLDOWN_SECONDS);
  } catch (e) {
    console.error(e);
    showError('No se pudo enviar. ¿Está abierta la escritura?');
    $('send-btn').disabled = false;
  }
}

function startCooldown(seconds) {
  const msg = $('cooldown-msg');
  let remaining = Math.ceil(seconds);
  $('word-input').disabled = true;
  $('send-btn').disabled = true;
  if (cooldownInterval) clearInterval(cooldownInterval);

  const tick = () => {
    if (remaining <= 0) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
      msg.textContent = '';
      if ($('status-badge').classList.contains('open')) {
        $('word-input').disabled = false;
        $('send-btn').disabled = false;
      }
      return;
    }
    msg.textContent = `⏳ Espera ${remaining} s para volver a escribir`;
    remaining--;
  };
  tick();
  cooldownInterval = setInterval(tick, 1000);
}