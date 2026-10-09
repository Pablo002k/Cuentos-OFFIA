import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithPopup, GoogleAuthProvider,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy,
  onSnapshot, serverTimestamp, runTransaction, writeBatch, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ⚠️ CONSERVA ESTO */
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
const IMAGE_MAX_SIZE = 1024;
const MAX_IMAGE_CHARS = 700000; // tope de tamaño de la imagen (Firestore permite 1 MB por documento)
const STORY_PROMPT_LIMIT = 600;

const STYLES = {
  cartoon3d: '3D animated family movie style, expressive characters, warm lighting, vibrant colors',
  anime: 'anime style, clean lines, vivid colors, expressive characters',
  sketch: 'artistic pencil sketch, visible strokes, soft shading, hand-drawn'
};
const STYLE_LABELS = { cartoon3d: 'animación 3D', anime: 'anime', sketch: 'boceto a lápiz' };
const STYLE_BY_LETTER = { A: 'cartoon3d', B: 'anime', C: 'sketch' };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let currentNickname = null;
let isAdmin = false;
let cooldownInterval = null;
let unsubs = [];
let currentStoryId = null;
let currentFinalStory = '';
let currentFinalPrompt = '';
let adminStatus = 'idle';
let serverImage = '';      // imagen que ya está guardada en el servidor
let pendingImage = null;   // imagen elegida en el panel que todavía no se publicó
let pendingSource = null;  // 'pollinations' | 'manual'
let lastEngine = 'flux';
let prevPublicStatus = null;
let publicContribUnsub = null;
let publicListenKey = '';
let adminContribUnsub = null;
let adminListenKey = '';
let adminEventsBound = false;

const $ = (id) => document.getElementById(id);
const loadingScreen = $('loading');
const nicknameScreen = $('nickname-screen');
const mainApp = $('main-app');
const adminPanel = $('admin-panel');

function showScreen(s) {
  [loadingScreen, nicknameScreen, mainApp, adminPanel].forEach(x => x.classList.add('hidden'));
  s.classList.remove('hidden');
}
function normalizeText(t) { return t.trim().replace(/\s+/g, ' '); }
function countWords(t) {
  const n = normalizeText(t);
  return n === '' ? 0 : n.split(' ').filter(w => w.length > 0).length;
}
function showInputError(msg) {
  const el = $('input-error'); if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}
function clearAllListeners() {
  unsubs.forEach(u => { try { u(); } catch (e) {} });
  unsubs = [];
  if (publicContribUnsub) { try { publicContribUnsub(); } catch (e) {} publicContribUnsub = null; }
  if (adminContribUnsub) { try { adminContribUnsub(); } catch (e) {} adminContribUnsub = null; }
  publicListenKey = ''; adminListenKey = '';
}
function newStoryId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ============ MOSTRAR EL CUENTO (palabras que aparecen una a una) ============ */
function renderStory(el, parts) {
  const prev = el._parts || [];
  const same = parts.length >= prev.length && prev.every((p, i) => p === parts[i]);
  const animate = same && el._animate === true;
  let start = prev.length;
  if (!same) { el.textContent = ''; start = 0; }
  for (let i = start; i < parts.length; i++) {
    const s = document.createElement('span');
    s.className = 'w' + (animate ? ' new' : '');
    s.textContent = parts[i] + ' ';
    el.appendChild(s);
  }
  el._parts = parts.slice();
  el._animate = true;
  el.scrollTop = el.scrollHeight;
}
function setStoryText(el, text) {
  el.textContent = text || '';
  el._parts = null; el._animate = false;
}

/* ============ PROMPTS ============ */
function buildFallbackPrompt(story, styleKey) {
  const style = STYLES[styleKey] || STYLES.cartoon3d;
  const trimmed = story.length > STORY_PROMPT_LIMIT ? story.slice(0, STORY_PROMPT_LIMIT) + '…' : story;
  return `Illustration for a short story (written in Spanish). Story: "${trimmed}". Represent the central scene or idea of the story with its characters and environment. Style: ${style}. Clear composition, expressive colors, no text or letters in the image.`;
}
function buildImagePrompt(scene, styleKey) {
  return `Illustration for a short story. Scene: ${scene}. Style: ${STYLES[styleKey] || STYLES.cartoon3d}. Clear composition, expressive colors, no text or letters in the image.`;
}
// Prompt para copiar y usar en cualquier IA externa (Plan C): lleva el cuento completo
function buildCopyPrompt(story, styleKey) {
  const styleText = styleKey
    ? `Style: ${STYLES[styleKey]}.`
    : 'Style: choose the one that best fits the tone of the story and use only that one: 3D animated family movie style (for childish or tender stories), anime style (for landscapes, adventure or fantasy) or artistic pencil sketch (for serious or dramatic stories).';
  return `Create an illustration for this short story (it is written in Spanish). Story: "${story}". Represent the central scene or idea of the story with its characters and environment. ${styleText} Clear composition, expressive colors, no text or letters in the image.`;
}
function sceneAnalysisPrompt(story) {
  return `You help illustrate a short story written word by word by many different people, so it may sound odd or incoherent. It is in Spanish.
Answer with exactly two lines and nothing else:
STYLE: A, B or C (A = 3D animated family-movie look, for childish, tender or funny stories; B = anime, for landscapes, adventure or fantasy; C = pencil sketch, for serious, dark or melancholic stories)
SCENE: one sentence in English (maximum 45 words) describing ONE concrete scene to draw: main characters or creatures, place, action and mood, using only elements that appear in the story.
Story: "${story.slice(0, 1500)}"`;
}
function parseScene(answer) {
  const sceneMatch = answer.match(/SCENE:\s*([\s\S]+)/i);
  if (!sceneMatch) throw new Error('la IA respondió algo inesperado');
  const scene = sceneMatch[1].trim().replace(/\s+/g, ' ').slice(0, 400);
  const styleMatch = answer.match(/STYLE:\s*([ABC])/i);
  const style = styleMatch ? STYLE_BY_LETTER[styleMatch[1].toUpperCase()] : null;
  return { scene, style };
}

/* ============ CLAVES DE IA (solo en el navegador del administrador) ============ */
const KEYS_STORAGE = 'cuento_ai_keys';
function getKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS_STORAGE) || '{}'); } catch (e) { return {}; }
}
function saveKeys(k) {
  try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(k)); } catch (e) {}
}

/* ============ IA DE TEXTO (título y análisis del cuento) ============ */
let geminiModelCache = null;
async function pickGeminiModel(key) {
  if (geminiModelCache) return geminiModelCache;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`la clave no sirvió (${res.status})`);
  const data = await res.json();
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => /^gemini-.*flash/.test(n) && !/(image|tts|live|audio|embedding|robotics|computer|vision)/.test(n))
    .sort().reverse();
  if (!names.length) throw new Error('no hay un modelo de texto disponible');
  geminiModelCache = names[0];
  return geminiModelCache;
}
async function askGemini(prompt, key) {
  const model = await pickGeminiModel(key);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) throw new Error(`Gemini respondió ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini no devolvió texto');
  return text;
}
async function askPollinationsText(prompt, key) {
  const enc = encodeURIComponent(prompt);
  const url = key
    ? `https://gen.pollinations.ai/text/${enc}?key=${encodeURIComponent(key)}`
    : `https://text.pollinations.ai/${enc}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pollinations texto respondió ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error('Pollinations no devolvió texto');
  return text;
}
// Prueba, en orden: Gemini (si hay clave), Pollinations con clave, Pollinations sin clave.
async function askTextAI(prompt) {
  const keys = getKeys();
  const errors = [];
  if (keys.gemini) {
    try { return await askGemini(prompt, keys.gemini); }
    catch (e) { errors.push('Gemini: ' + e.message); }
  }
  if (keys.pollen) {
    try { return await askPollinationsText(prompt, keys.pollen); }
    catch (e) { errors.push('Pollinations: ' + e.message); }
  }
  try { return await askPollinationsText(prompt, ''); }
  catch (e) { errors.push('Pollinations sin clave: ' + e.message); }
  throw new Error(errors.join(' | '));
}
async function generateTitleWithAI(story) {
  const prompt = `Genera un título corto, llamativo y creativo (máximo 6 palabras) para este cuento. Responde SOLO con el título, sin comillas, sin punto final y sin explicaciones. Cuento: "${story.slice(0, 800)}"`;
  let title = (await askTextAI(prompt)).split('\n')[0].trim();
  title = title.replace(/^(t[ií]tulo\s*:\s*)/i, '').replace(/^["'«»“”*#\s]+|["'«»“”*.\s]+$/g, '').trim();
  if (title.length > 80) title = title.slice(0, 80);
  return title || 'Cuento sin título';
}

/* ============ IMAGEN ============ */
async function compressBlobToDataURL(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Imagen inválida'));
      i.src = url;
    });
    let maxSide = IMAGE_MAX_SIZE;
    for (let round = 0; round < 4; round++) {
      let { width, height } = img;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      for (let q = 0.8; q >= 0.45; q -= 0.1) {
        const out = canvas.toDataURL('image/jpeg', q);
        if (out.length <= MAX_IMAGE_CHARS) return out;
      }
      maxSide = Math.round(maxSide * 0.75);
    }
    throw new Error('La imagen pesa demasiado');
  } finally { URL.revokeObjectURL(url); }
}
async function generateWithPollinations(prompt, model, onStatus) {
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true&model=${model}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < 3) {
      onStatus && onStatus('⏳ Pollinations pide esperar un momento… reintentando');
      await wait(16000);
      continue;
    }
    if (!res.ok) throw new Error(`Pollinations respondió ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('La respuesta no fue una imagen');
    return await compressBlobToDataURL(blob);
  }
  throw new Error('Pollinations está ocupado. Prueba en unos segundos');
}

/* ============ PESTAÑAS ============ */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $('tab-live').classList.toggle('hidden', target !== 'live');
    $('tab-gallery').classList.toggle('hidden', target !== 'gallery');
    if (target === 'gallery') loadGallery();
  });
});

/* ============ AUTENTICACIÓN ============ */
onAuthStateChanged(auth, async (user) => {
  clearAllListeners();
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { console.error(e); }
    return;
  }
  currentUser = user;
  isAdmin = (user.email === ADMIN_EMAIL);

  if (isAdmin) {
    await ensureStateDoc();
    setupAdmin();
    showScreen(adminPanel);
    return;
  }
  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (userSnap.exists() && userSnap.data().nickname) {
    currentNickname = userSnap.data().nickname;
    setupPublicView();
    showScreen(mainApp);
  } else {
    $('enter-btn').disabled = false;
    $('enter-btn').textContent = 'Entrar';
    showScreen(nicknameScreen);
  }
});

$('enter-btn').addEventListener('click', async () => {
  const raw = $('nickname-input').value.trim();
  const errEl = $('nickname-error'); errEl.textContent = '';
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
    setupPublicView();
    showScreen(mainApp);
  } catch (e) { errEl.textContent = e.message || 'Error al reservar apodo'; }
});
$('nickname-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('enter-btn').click(); });

$('admin-login-btn').addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { console.error(e); alert('No se pudo iniciar sesión con Google'); }
});

async function ensureStateDoc() {
  const ref = doc(db, 'state', 'current');
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      status: 'idle', storyId: newStoryId(),
      finalStory: '', finalPrompt: '', finalTitle: '', finalImage: '',
      finalStyle: 'auto', updatedAt: serverTimestamp()
    });
    return;
  }
  const data = snap.data();
  const fixes = {};
  if (!data.status) fixes.status = 'idle';
  if (!data.storyId) fixes.storyId = newStoryId();
  if (data.finalStory === undefined) fixes.finalStory = '';
  if (data.finalPrompt === undefined) fixes.finalPrompt = '';
  if (data.finalTitle === undefined) fixes.finalTitle = '';
  if (data.finalImage === undefined) fixes.finalImage = '';
  if (!data.finalStyle) fixes.finalStyle = 'auto';
  if (Object.keys(fixes).length > 0) await setDoc(ref, fixes, { merge: true });
}

/* ============ VISTA PÚBLICA ============ */
function playReveal() {
  const p = $('padlet-current');
  p.classList.remove('reveal'); void p.offsetWidth; p.classList.add('reveal');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#ffb84d', '#ff4f8b', '#3ddbb0', '#cfc8f5', '#fff9f0'];
  for (let i = 0; i < 28; i++) {
    const c = document.createElement('i');
    c.style.setProperty('--x', (Math.random() * 100) + 'vw');
    c.style.setProperty('--c', colors[i % colors.length]);
    c.style.setProperty('--r', Math.floor(Math.random() * 360) + 'deg');
    c.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    c.style.animationDelay = (Math.random() * 0.5) + 's';
    box.appendChild(c);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4800);
}

async function restoreCooldown() {
  try {
    const s = await getDoc(doc(db, 'users', currentUser.uid));
    const t = s.exists() ? s.data().lastContributionAt : null;
    if (t && t.toDate) {
      const remaining = COOLDOWN_SECONDS - (Date.now() - t.toDate().getTime()) / 1000;
      if (remaining > 1) startCooldown(remaining);
    }
  } catch (e) {}
}

function setupPublicView() {
  $('my-nickname').textContent = currentNickname || 'Anónimo';
  restoreCooldown();

  const u = onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const status = data.status || 'idle';
    currentStoryId = data.storyId || null;

    const isOpen = status === 'writing_open';
    const isIdle = status === 'idle';
    const isPublished = status === 'published';

    $('writing-room').classList.toggle('hidden', isPublished);
    $('padlet-current').classList.toggle('hidden', !isPublished);

    if (isPublished) {
      $('padlet-title').textContent = data.finalTitle || '';
      $('padlet-story').textContent = data.finalStory || '';
      $('padlet-image').src = data.finalImage || '';
      if (prevPublicStatus && prevPublicStatus !== 'published') playReveal();
    } else {
      const badge = $('status-badge');
      badge.textContent = isOpen ? 'Escritura abierta' : isIdle ? 'Esperando inicio' : 'Cuento terminado';
      badge.className = 'badge ' + (isOpen ? 'open' : isIdle ? 'idle' : 'closed');
      $('writing-controls').classList.toggle('hidden', !isOpen);
      $('illustrating-msg').classList.toggle('hidden', isOpen || isIdle);
      $('idle-msg').classList.toggle('hidden', !isIdle);
      $('story-container').classList.toggle('hidden', isIdle);
      if (!isOpen) {
        $('word-input').disabled = true; $('send-btn').disabled = true;
      } else if (!cooldownInterval) {
        $('word-input').disabled = false; $('send-btn').disabled = false;
      }
    }
    prevPublicStatus = status;
    listenContributions(data.storyId, isPublished);
  }, (err) => console.error('state snapshot error:', err));
  unsubs.push(u);
}

function listenContributions(storyId, isPublished) {
  const key = `${storyId}|${isPublished}`;
  if (key === publicListenKey) return;
  publicListenKey = key;
  if (publicContribUnsub) { try { publicContribUnsub(); } catch (e) {} publicContribUnsub = null; }
  const el = $('story-container');
  if (!storyId || isPublished) { setStoryText(el, ''); return; }
  // Sin filtro en el servidor (evita pedir un índice): se filtra por código.
  const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
  publicContribUnsub = onSnapshot(q, (snap) => {
    const parts = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.storyId === storyId && data.text) parts.push(data.text);
    });
    renderStory(el, parts);
  }, (err) => {
    console.error('contributions error:', err);
    setStoryText(el, '(error al leer aportes: ' + err.message + ')');
  });
}

/* ============ GALERÍA ============ */
async function loadGallery() {
  const grid = $('gallery-grid');
  grid.innerHTML = '<p class="info">Cargando cuentos…</p>';
  try {
    const q = query(collection(db, 'stories'), orderBy('publishedAt', 'desc'));
    const snap = await getDocs(q);
    grid.innerHTML = '';
    if (snap.empty) { $('gallery-empty').classList.remove('hidden'); return; }
    $('gallery-empty').classList.add('hidden');
    snap.forEach(d => {
      const s = d.data();
      const card = document.createElement('article');
      card.className = 'gallery-card';
      card.tabIndex = 0;
      const img = document.createElement('img');
      img.src = s.image || ''; img.alt = s.title || 'Cuento'; img.loading = 'lazy';
      const body = document.createElement('div');
      body.className = 'gallery-body';
      const title = document.createElement('h3');
      title.className = 'gallery-title'; title.textContent = s.title || 'Cuento sin título';
      const story = document.createElement('p');
      story.className = 'gallery-story'; story.textContent = s.story || '';
      const date = document.createElement('p');
      date.className = 'gallery-date';
      const ts = s.publishedAt && s.publishedAt.toDate ? s.publishedAt.toDate() : null;
      date.textContent = ts ? ts.toLocaleString('es-AR') : '';
      body.append(title, story, date);
      card.append(img, body);
      const toggle = () => card.classList.toggle('open');
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      grid.appendChild(card);
    });
  } catch (err) {
    console.error('gallery error:', err);
    grid.innerHTML = '<p class="error">No se pudo cargar la galería.</p>';
  }
}

/* ============ ENVÍO DE PALABRAS ============ */
$('send-btn').addEventListener('click', sendContribution);
$('word-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendContribution(); });
$('word-input').addEventListener('input', () => {
  const parts = normalizeText($('word-input').value).split(' ').filter(w => w.length > 0);
  if (parts.length > MAX_WORDS) {
    $('word-input').value = parts.slice(0, MAX_WORDS).join(' ');
    showInputError(`Máximo ${MAX_WORDS} palabras`);
  }
});
async function sendContribution() {
  if (cooldownInterval) return;
  const text = normalizeText($('word-input').value);
  const words = countWords(text);
  if (words === 0) { showInputError('Escribe al menos una palabra'); return; }
  if (words > MAX_WORDS) { showInputError(`Máximo ${MAX_WORDS} palabras`); return; }
  if (!currentStoryId) { showInputError('El cuento no está iniciado todavía'); return; }
  $('send-btn').disabled = true;
  try {
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'contributions')), {
      uid: currentUser.uid, nickname: currentNickname,
      text, wordCount: words, storyId: currentStoryId, createdAt: serverTimestamp()
    });
    batch.update(doc(db, 'users', currentUser.uid), { lastContributionAt: serverTimestamp() });
    await batch.commit();
    $('word-input').value = '';
    startCooldown(COOLDOWN_SECONDS);
  } catch (e) {
    console.error(e);
    showInputError('No se pudo enviar. ¿Está abierta la escritura?');
    $('send-btn').disabled = false;
  }
}
function startCooldown(seconds) {
  const msg = $('cooldown-msg'); let remaining = Math.ceil(seconds);
  const bar = $('cooldown-bar');
  $('word-input').disabled = true; $('send-btn').disabled = true;
  if (cooldownInterval) clearInterval(cooldownInterval);
  bar.style.animation = 'none'; void bar.offsetWidth;
  bar.style.animation = `drain ${seconds}s linear forwards`;
  $('writing-controls').classList.add('cooling');
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(cooldownInterval); cooldownInterval = null; msg.textContent = '';
      $('writing-controls').classList.remove('cooling');
      if ($('status-badge').classList.contains('open')) {
        $('word-input').disabled = false; $('send-btn').disabled = false;
        $('word-input').focus();
      }
      return;
    }
    msg.textContent = `Podrás escribir de nuevo en ${remaining} s`;
    remaining--;
  };
  tick(); cooldownInterval = setInterval(tick, 1000);
}

/* ============ PANEL ADMIN ============ */
function updatePublishButton() {
  const btn = $('publish-btn');
  const has = !!(pendingImage || serverImage);
  const alreadyPublished = adminStatus === 'published' && !pendingImage;
  btn.disabled = !has || alreadyPublished;
  btn.textContent = alreadyPublished ? '✓ Publicado' : '✅ Confirmar y publicar';
}
function showPreview(dataURL, source) {
  pendingImage = dataURL;
  pendingSource = source;
  $('preview-image').src = dataURL;
  $('preview-block').classList.remove('hidden');
  updatePublishButton();
  $('preview-block').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function setGenBusy(busy) {
  ['gen-flux-btn', 'gen-turbo-btn', 'regen-btn'].forEach(id => { $(id).disabled = busy; });
}
async function saveTitleEverywhere(title) {
  const ref = doc(db, 'state', 'current');
  await setDoc(ref, { finalTitle: title, updatedAt: serverTimestamp() }, { merge: true });
  if (adminStatus === 'published' && currentStoryId) {
    await setDoc(doc(db, 'stories', currentStoryId), { title, updatedAt: serverTimestamp() }, { merge: true });
  }
}
function resetAdminWorkArea() {
  pendingImage = null; pendingSource = null; serverImage = '';
  currentFinalStory = ''; currentFinalPrompt = '';
  $('edit-textarea').value = ''; $('prompt-display').value = ''; $('title-input').value = '';
  $('preview-block').classList.add('hidden');
  $('gen-error').textContent = ''; $('gen-status').textContent = ''; $('scene-info').textContent = '';
}

async function runGeneration(model) {
  const story = (currentFinalStory || '').trim();
  if (!story) { $('gen-error').textContent = 'Primero debe haber un cuento.'; return; }
  lastEngine = model;
  setGenBusy(true);
  $('gen-error').textContent = ''; $('scene-info').textContent = '';
  try {
    const manualStyle = $('style-select').value;
    let styleKey = manualStyle !== 'auto' ? manualStyle : null;
    let scene = null;
    $('gen-status').textContent = '⏳ Analizando el cuento con IA…';
    try {
      const parsed = parseScene(await askTextAI(sceneAnalysisPrompt(story)));
      scene = parsed.scene;
      if (!styleKey) styleKey = parsed.style;
    } catch (e) {
      console.warn('análisis con IA falló:', e);
      $('scene-info').textContent = '⚠️ No se pudo analizar el cuento con IA (' + e.message + '). Se usa el texto directo, que puede dar una imagen menos fiel. Pega una clave de Gemini en "Claves de IA" para arreglarlo.';
    }
    styleKey = styleKey || 'cartoon3d';
    const prompt = scene ? buildImagePrompt(scene, styleKey) : buildFallbackPrompt(story, styleKey);
    if (scene) $('scene-info').textContent = `🎬 Escena elegida: ${scene} · Estilo: ${STYLE_LABELS[styleKey]}`;
    $('gen-status').textContent = `⏳ Dibujando con Pollinations (${model})… puede tardar entre 10 y 30 s`;
    const dataURL = await generateWithPollinations(prompt, model, (m) => { $('gen-status').textContent = m; });
    showPreview(dataURL, 'pollinations');
    $('gen-status').textContent = '✅ Imagen lista. Revisa la vista previa.';
  } catch (e) {
    console.error(e);
    $('gen-error').textContent = 'No se pudo generar: ' + e.message;
    $('gen-status').textContent = 'Prueba de nuevo, usa el otro botón o el Plan B/C.';
  } finally { setGenBusy(false); }
}

function setupAdmin() {
  $('admin-email').textContent = currentUser.email;
  const keys = getKeys();
  $('gemini-key').value = keys.gemini || '';
  $('pollen-key').value = keys.pollen || '';

  const u = onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const status = data.status || 'idle';
    adminStatus = status;
    currentStoryId = data.storyId || null;
    currentFinalStory = data.finalStory || '';
    currentFinalPrompt = data.finalPrompt || '';
    serverImage = data.finalImage || '';

    $('open-btn').disabled = (status !== 'idle');
    $('close-btn').disabled = (status !== 'writing_open');
    $('state-info').textContent =
      status === 'idle' ? 'Estado: sin cuento activo.'
      : status === 'writing_open' ? 'Estado: escritura ABIERTA.'
      : status === 'writing_closed' ? 'Estado: cuento CERRADO. Genera el título y la imagen.'
      : 'Estado: cuento PUBLICADO. Puedes seguir editándolo.';

    const showIllus = (status === 'writing_closed' || status === 'published');
    $('illustration-block').classList.toggle('hidden', !showIllus);
    $('edit-block').classList.toggle('hidden', !showIllus);

    if (showIllus) {
      if (document.activeElement !== $('edit-textarea')) $('edit-textarea').value = currentFinalStory;
      if (!currentFinalPrompt) {
        const sv = $('style-select').value;
        currentFinalPrompt = buildCopyPrompt(currentFinalStory, sv === 'auto' ? null : sv);
      }
      $('prompt-display').value = currentFinalPrompt;
      if (document.activeElement !== $('title-input')) $('title-input').value = data.finalTitle || '';
      if (!pendingImage) {
        if (serverImage) { $('preview-image').src = serverImage; $('preview-block').classList.remove('hidden'); }
        else $('preview-block').classList.add('hidden');
      }
      updatePublishButton();
    }

    // Vista en vivo del cuento (solo se vuelve a suscribir si cambia el estado o el cuento)
    const listenKey = `${status}|${data.storyId}`;
    if (listenKey === adminListenKey) return;
    adminListenKey = listenKey;
    if (adminContribUnsub) { try { adminContribUnsub(); } catch (e) {} adminContribUnsub = null; }
    const storyEl = $('admin-story');
    if (!data.storyId || status === 'idle') {
      setStoryText(storyEl, '');
    } else if (status === 'writing_closed' || status === 'published') {
      setStoryText(storyEl, currentFinalStory);
    } else {
      const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
      adminContribUnsub = onSnapshot(q, (s2) => {
        const parts = [];
        s2.forEach(d => {
          const dd = d.data();
          if (dd.storyId === data.storyId && dd.text) parts.push(dd.text);
        });
        renderStory(storyEl, parts);
      }, (err) => {
        console.error('admin contrib error:', err);
        setStoryText(storyEl, '(error al leer aportes)');
      });
    }
  }, (err) => console.error('admin state error:', err));
  unsubs.push(u);

  if (adminEventsBound) return;
  adminEventsBound = true;

  // Comenzar
  $('open-btn').addEventListener('click', async () => {
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    if ((data.status || 'idle') !== 'idle') return;
    await setDoc(ref, {
      status: 'writing_open', storyId: newStoryId(),
      finalStory: '', finalPrompt: '', finalTitle: '', finalImage: '',
      finalStyle: $('style-select').value,
      startedAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true });
    resetAdminWorkArea();
  });

  // Cerrar
  $('close-btn').addEventListener('click', async () => {
    if (!confirm('¿Cerrar y terminar el cuento? Después no se podrán añadir más palabras.')) return;
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    if ((data.status || '') !== 'writing_open') return;
    const snapStory = await getDocs(query(collection(db, 'contributions'), orderBy('createdAt', 'asc')));
    const parts = [];
    snapStory.forEach(d => {
      const dd = d.data();
      if (dd.storyId === data.storyId && dd.text) parts.push(dd.text);
    });
    const story = parts.join(' ');
    const sv = $('style-select').value;
    const prompt = buildCopyPrompt(story, sv === 'auto' ? null : sv);
    await setDoc(ref, {
      status: 'writing_closed', finalStory: story, finalPrompt: prompt,
      closedAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true });
  });

  // Reiniciar
  $('reset-btn').addEventListener('click', async () => {
    if (!confirm('¿Reiniciar? Se empezará un cuento nuevo. Los publicados quedan en la galería.')) return;
    await setDoc(doc(db, 'state', 'current'), {
      status: 'idle', storyId: newStoryId(),
      finalStory: '', finalPrompt: '', finalTitle: '', finalImage: '',
      finalStyle: 'auto', updatedAt: serverTimestamp()
    }, { merge: true });
    resetAdminWorkArea();
  });

  // Cerrar sesión
  $('logout-btn').addEventListener('click', async () => {
    if (!confirm('¿Cerrar sesión del panel?')) return;
    clearAllListeners();
    adminEventsBound = false;
    await signOut(auth);
  });

  // Editar el cuento
  $('save-edit-btn').addEventListener('click', async () => {
    const newText = $('edit-textarea').value.trim();
    const sv = $('style-select').value;
    const newPrompt = buildCopyPrompt(newText, sv === 'auto' ? null : sv);
    try {
      await setDoc(doc(db, 'state', 'current'), { finalStory: newText, finalPrompt: newPrompt, updatedAt: serverTimestamp() }, { merge: true });
      if (adminStatus === 'published' && currentStoryId) {
        await setDoc(doc(db, 'stories', currentStoryId), { story: newText, updatedAt: serverTimestamp() }, { merge: true });
      }
      $('edit-feedback').textContent = '✅ Guardado.';
    } catch (e) { console.error(e); $('edit-feedback').textContent = 'No se pudo guardar: ' + e.message; }
    setTimeout(() => { $('edit-feedback').textContent = ''; }, 3000);
  });
  $('cancel-edit-btn').addEventListener('click', () => { $('edit-textarea').value = currentFinalStory; });

  // Título
  $('title-input').addEventListener('change', async () => {
    try { await saveTitleEverywhere($('title-input').value.trim()); } catch (e) { console.error(e); }
  });
  $('gen-title-btn').addEventListener('click', async () => {
    const story = $('edit-textarea').value.trim() || currentFinalStory;
    if (!story) { $('title-feedback').textContent = 'Primero debe haber un cuento.'; return; }
    $('title-feedback').textContent = '⏳ Generando título…';
    $('gen-title-btn').disabled = true;
    try {
      const title = await generateTitleWithAI(story);
      $('title-input').value = title;
      await saveTitleEverywhere(title);
      $('title-feedback').textContent = '✅ Título generado. Puedes editarlo a mano.';
    } catch (e) {
      console.error(e);
      $('title-feedback').textContent = 'No se pudo generar con IA (' + e.message + '). Escríbelo a mano o pega una clave de Gemini en "Claves de IA".';
    } finally { $('gen-title-btn').disabled = false; }
  });

  // Claves
  $('save-keys-btn').addEventListener('click', () => {
    saveKeys({ gemini: $('gemini-key').value.trim(), pollen: $('pollen-key').value.trim() });
    geminiModelCache = null;
    $('keys-feedback').textContent = '✅ Claves guardadas en este navegador.';
    setTimeout(() => { $('keys-feedback').textContent = ''; }, 4000);
  });

  // Estilo y prompt
  $('style-select').addEventListener('change', () => {
    const sv = $('style-select').value;
    currentFinalPrompt = buildCopyPrompt(currentFinalStory, sv === 'auto' ? null : sv);
    $('prompt-display').value = currentFinalPrompt;
  });
  const copyPrompt = async () => {
    const text = $('prompt-display').value;
    try { await navigator.clipboard.writeText(text); }
    catch (e) { $('prompt-display').select(); document.execCommand('copy'); }
    $('copy-feedback').textContent = '✅ Prompt copiado. Pégalo en la IA que prefieras.';
    setTimeout(() => { $('copy-feedback').textContent = ''; }, 6000);
  };
  $('copy-prompt-btn').addEventListener('click', copyPrompt);
  document.querySelectorAll('.ext-ai').forEach(a => a.addEventListener('click', copyPrompt));

  // Generar imagen
  $('gen-flux-btn').addEventListener('click', () => runGeneration('flux'));
  $('gen-turbo-btn').addEventListener('click', () => runGeneration('turbo'));
  $('regen-btn').addEventListener('click', () => {
    if (pendingSource === 'manual') $('upload-input').click();
    else runGeneration(lastEngine);
  });

  // Subir imagen (Plan B)
  $('upload-btn').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $('gen-error').textContent = ''; $('gen-status').textContent = '⏳ Preparando la imagen…';
    try {
      showPreview(await compressBlobToDataURL(file), 'manual');
      $('gen-status').textContent = '✅ Imagen cargada. Revisa la vista previa.';
    } catch (err) {
      console.error(err);
      $('gen-error').textContent = 'No se pudo procesar la imagen: ' + err.message;
      $('gen-status').textContent = '';
    }
    e.target.value = '';
  });

  // Publicar
  $('publish-btn').addEventListener('click', async () => {
    const img = pendingImage || serverImage;
    if (!img) { $('gen-error').textContent = 'Primero genera o sube una imagen.'; return; }
    if (!currentStoryId) { $('gen-error').textContent = 'No hay un cuento activo.'; return; }
    if (img.length > MAX_IMAGE_CHARS + 50000) { $('gen-error').textContent = 'La imagen pesa demasiado. Genera otra o sube una más liviana.'; return; }
    if (!confirm('¿Publicar el cuento y la imagen para todos?')) return;
    $('publish-btn').disabled = true; $('gen-error').textContent = '';
    $('gen-status').textContent = '⏳ Publicando…';
    const title = $('title-input').value.trim() || 'Cuento sin título';
    const sv = $('style-select').value;
    try {
      await setDoc(doc(db, 'stories', currentStoryId), {
        title, story: currentFinalStory, prompt: currentFinalPrompt,
        image: img, style: sv, storyId: currentStoryId,
        publishedAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      await setDoc(doc(db, 'state', 'current'), {
        status: 'published',
        finalStory: currentFinalStory, finalPrompt: currentFinalPrompt,
        finalTitle: title, finalImage: img, finalStyle: sv,
        publishedAt: serverTimestamp(), updatedAt: serverTimestamp()
      }, { merge: true });
      pendingImage = null; pendingSource = null;
      $('gen-status').textContent = '✅ Publicado.';
    } catch (e) {
      console.error(e);
      $('gen-error').textContent = 'Error al publicar: ' + (e.code ? e.code + ' · ' : '') + e.message;
      $('gen-status').textContent = '';
      updatePublishButton();
    }
  });
}
