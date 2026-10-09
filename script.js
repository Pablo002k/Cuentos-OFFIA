import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithPopup, GoogleAuthProvider, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy,
  onSnapshot, serverTimestamp, runTransaction, writeBatch, getDocs
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

/* ============================================================ */
const COOLDOWN_SECONDS = 40;
const MAX_WORDS = 3;
const MAX_NICKNAME_LENGTH = 20;
const IMAGE_MAX_SIZE = 1024;
const IMAGE_QUALITY = 0.75;
const STORY_PROMPT_LIMIT = 600;

const STYLES = {
  cartoon3d: '3D animated family movie style, expressive characters, warm lighting, vibrant colors',
  anime: 'anime style, clean lines, vivid colors, expressive characters',
  sketch: 'artistic pencil sketch, visible strokes, soft shading, hand-drawn'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let currentNickname = null;
let isAdmin = false;
let cooldownInterval = null;

let currentFinalStory = '';
let currentFinalPrompt = '';
let currentPreviewImage = null;
let currentPreviewSource = null;

const $ = (id) => document.getElementById(id);
const loadingScreen = $('loading');
const nicknameScreen = $('nickname-screen');
const writingRoom = $('writing-room');
const padletScreen = $('padlet-screen');
const adminPanel = $('admin-panel');

function showScreen(s) {
  [loadingScreen, nicknameScreen, writingRoom, padletScreen, adminPanel]
    .forEach(x => x.classList.add('hidden'));
  s.classList.remove('hidden');
}
function normalizeText(t) { return t.trim().replace(/\s+/g, ' '); }
function countWords(t) {
  const n = normalizeText(t);
  return n === '' ? 0 : n.split(' ').filter(w => w.length > 0).length;
}
function showError(msg) {
  const el = $('input-error');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

function buildPrompt(story, styleKey) {
  const style = STYLES[styleKey] || STYLES.cartoon3d;
  const trimmed = story.length > STORY_PROMPT_LIMIT
    ? story.slice(0, STORY_PROMPT_LIMIT) + '…'
    : story;
  return `Illustration for a short story. Story plot: "${trimmed}". Represent the central scene or idea of the story with its characters and environment. Style: ${style}. Clear composition, expressive colors, no text or letters in the image.`;
}

/* ============ COMPRESIÓN DE IMAGEN ============ */
async function compressBlobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width >= height && width > IMAGE_MAX_SIZE) {
        height = Math.round(height * IMAGE_MAX_SIZE / width);
        width = IMAGE_MAX_SIZE;
      } else if (height > IMAGE_MAX_SIZE) {
        width = Math.round(width * IMAGE_MAX_SIZE / height);
        height = IMAGE_MAX_SIZE;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', IMAGE_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagen inválida')); };
    img.src = url;
  });
}

async function generateWithPollinations(prompt) {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pollinations respondió ${res.status}`);
  const blob = await res.blob();
  return await compressBlobToDataURL(blob);
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

/* ============ LOGIN ADMIN ============ */
$('admin-login-btn').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { console.error(e); alert('No se pudo iniciar sesión con Google'); }
});

async function ensureStateDoc() {
  const ref = doc(db, 'state', 'current');
  const snap = await getDoc(ref);
  if (!snap.exists()) await setDoc(ref, { status: 'writing_closed', published: false });
}

/* ============ SALA DE ESCRITURA (PÚBLICO) ============ */
function setupWritingRoom() {
  $('my-nickname').textContent = currentNickname || 'Anónimo';
  const statusBadge = $('status-badge');

  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const status = data.status || 'writing_closed';

    if (status === 'published') {
      $('padlet-story').textContent = data.finalStory || '';
      $('padlet-image').src = data.finalImage || '';
      showScreen(padletScreen);
      return;
    }

    const isOpen = status === 'writing_open';
    statusBadge.textContent = isOpen ? '🟢 Escritura abierta' : '🔴 Escritura cerrada';
    statusBadge.className = 'badge ' + (isOpen ? 'open' : 'closed');
    $('writing-controls').classList.toggle('hidden', !isOpen);
    $('illustrating-msg').classList.toggle('hidden', isOpen);
    if (!isOpen) {
      $('word-input').disabled = true;
      $('send-btn').disabled = true;
    } else if (!cooldownInterval) {
      $('word-input').disabled = false;
      $('send-btn').disabled = false;
    }
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
      uid: currentUser.uid, nickname: currentNickname, text, wordCount: words,
      createdAt: serverTimestamp()
    });
    batch.update(doc(db, 'users', currentUser.uid), { lastContributionAt: serverTimestamp() });
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

/* ============ PANEL DE ADMINISTRADOR ============ */
function setupAdmin() {
  $('admin-email').textContent = currentUser.email;

  // Cuento en vivo
  const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
  onSnapshot(q, (snap) => {
    const parts = [];
    snap.forEach(d => { if (d.data().text) parts.push(d.data().text); });
    currentFinalStory = parts.join(' ');
    $('admin-story').textContent = currentFinalStory || '(todavía no hay nada escrito)';
  });

  // Estado
  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const status = data.status || 'writing_closed';
    const isOpen = status === 'writing_open';
    const isPublished = status === 'published';

    $('toggle-btn').textContent = isOpen ? 'Cerrar escritura' : 'Abrir escritura';
    $('toggle-btn').disabled = isPublished;
    $('state-info').textContent = isPublished
      ? '✅ El cuento está publicado.'
      : isOpen
        ? 'La escritura está ABIERTA.'
        : 'La escritura está CERRADA. Prepara la ilustración.';

    // Mostrar bloque de ilustración cuando está cerrada o publicada
    const showIllus = (status === 'writing_closed' || isPublished);
    $('illustration-block').classList.toggle('hidden', !showIllus);

    // Si ya está publicado, mostrar preview
    if (isPublished && data.finalImage) {
      $('preview-image').src = data.finalImage;
      $('preview-block').classList.remove('hidden');
      $('publish-btn').disabled = true;
    }

    // Construir prompt si aún no hay
    if (showIllus && !currentFinalPrompt) {
      currentFinalPrompt = buildPrompt(currentFinalStory, $('style-select').value);
      $('prompt-display').value = currentFinalPrompt;
    }
  });

  // Abrir/cerrar escritura
  $('toggle-btn').addEventListener('click', async () => {
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const current = snap.exists() ? snap.data().status : 'writing_closed';
    if (current === 'published') return;
    const next = current === 'writing_open' ? 'writing_closed' : 'writing_open';
    const update = { status: next, updatedAt: serverTimestamp() };

    if (next === 'writing_closed') {
      // Congelar el cuento y armar el prompt
      const storySnap = await getDocs(query(collection(db, 'contributions'), orderBy('createdAt', 'asc')));
      const parts = [];
      storySnap.forEach(d => { if (d.data().text) parts.push(d.data().text); });
      const story = parts.join(' ');
      const prompt = buildPrompt(story, $('style-select').value);
      update.finalStory = story;
      update.finalPrompt = prompt;
      currentFinalStory = story;
      currentFinalPrompt = prompt;
      $('prompt-display').value = prompt;
    }
    await setDoc(ref, update, { merge: true });
  });

  // Cambio de estilo
  $('style-select').addEventListener('change', () => {
    currentFinalPrompt = buildPrompt(currentFinalStory, $('style-select').value);
    $('prompt-display').value = currentFinalPrompt;
  });

  // Copiar prompt (Plan C)
  $('copy-prompt-btn').addEventListener('click', async () => {
    const text = $('prompt-display').value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      $('prompt-display').select();
      document.execCommand('copy');
    }
    $('copy-feedback').textContent = '✅ Prompt copiado. Pégalo en la IA que prefieras y luego sube la imagen con el Plan B.';
    setTimeout(() => { $('copy-feedback').textContent = ''; }, 6000);
  });

  // Generar con Pollinations
  $('gen-pollinations-btn').addEventListener('click', async () => {
    $('gen-error').textContent = '';
    $('gen-status').textContent = '⏳ Generando con Pollinations… (puede tardar 10-30 s)';
    $('gen-pollinations-btn').disabled = true;
    try {
      const prompt = $('prompt-display').value || currentFinalPrompt;
      const dataURL = await generateWithPollinations(prompt);
      showPreview(dataURL, 'pollinations');
      $('gen-status').textContent = '✅ Imagen generada. Revísala abajo.';
    } catch (e) {
      console.error(e);
      $('gen-error').textContent = 'No se pudo generar con Pollinations: ' + e.message;
      $('gen-status').textContent = 'Prueba de nuevo o usa el Plan B (subir imagen).';
    } finally {
      $('gen-pollinations-btn').disabled = false;
    }
  });

  // Subir manual (Plan B)
  $('upload-btn').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('gen-error').textContent = '';
    $('gen-status').textContent = '⏳ Comprimiendo imagen…';
    try {
      const dataURL = await compressBlobToDataURL(file);
      showPreview(dataURL, 'manual');
      $('gen-status').textContent = '✅ Imagen cargada. Revísala abajo.';
    } catch (err) {
      console.error(err);
      $('gen-error').textContent = 'No se pudo procesar la imagen.';
    }
    e.target.value = '';
  });

  // Regenerar
  $('regen-btn').addEventListener('click', () => {
    if (currentPreviewSource === 'manual') $('upload-input').click();
    else $('gen-pollinations-btn').click();
  });

  // Publicar
  $('publish-btn').addEventListener('click', async () => {
    if (!currentPreviewImage) return;
    if (!confirm('¿Publicar el cuento y la imagen para todos?')) return;
    $('publish-btn').disabled = true;
    $('gen-status').textContent = '⏳ Publicando…';
    try {
      await setDoc(doc(db, 'state', 'current'), {
        status: 'published',
        finalStory: currentFinalStory,
        finalPrompt: currentFinalPrompt,
        finalImage: currentPreviewImage,
        finalStyle: $('style-select').value,
        publishedAt: serverTimestamp()
      }, { merge: true });
      $('gen-status').textContent = '✅ Publicado. Todos pueden verlo ahora.';
    } catch (e) {
      console.error(e);
      $('gen-error').textContent = 'Error al publicar: ' + e.message;
      $('publish-btn').disabled = false;
    }
  });
}

function showPreview(dataURL, source) {
  currentPreviewImage = dataURL;
  currentPreviewSource = source;
  $('preview-image').src = dataURL;
  $('preview-block').classList.remove('hidden');
  $('publish-btn').disabled = false;
}