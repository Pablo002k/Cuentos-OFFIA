import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithPopup, GoogleAuthProvider,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy,
  onSnapshot, serverTimestamp, runTransaction, writeBatch, getDocs, where
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
const REACTION_COOLDOWN = 60;

const STYLES = {
  cartoon3d: '3D animated feature-film look, expressive characters, soft cinematic lighting, rich detail, vibrant colors',
  anime: 'high-quality anime illustration, clean line art, vivid colors, detailed background, cinematic lighting',
  sketch: 'detailed artistic pencil sketch, fine linework, cross-hatching shading, hand-drawn on paper'
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
let lastEngine = { model: 'flux', useKey: false };
let analysisStyle = null;
let reactUnsub = null;
let reactKey = '';
let reactionCounts = {};
let reactionsReady = false;
let reactCooldownTimer = null;
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
  if (reactUnsub) { try { reactUnsub(); } catch (e) {} reactUnsub = null; }
  publicListenKey = ''; adminListenKey = ''; reactKey = '';
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
  return `Illustration for a short story. ${scene} Style: ${STYLES[styleKey] || STYLES.cartoon3d}. Highly detailed, clear composition, expressive colors, no text or letters in the image.`;
}
// Prompt largo para copiar a otra IA cuando todavía no hay análisis: lleva el cuento completo
function buildCopyPrompt(story, styleKey) {
  const styleText = styleKey
    ? `Style: ${STYLES[styleKey]}.`
    : 'Style: choose the one that best fits the tone of the story and use only that one: 3D animated family movie style (for childish or tender stories), anime style (for landscapes, adventure or fantasy) or artistic pencil sketch (for serious or dramatic stories).';
  return `Create an illustration for this short story (it is written in Spanish). Story: "${story}". Represent the central scene or idea of the story with its characters and environment. ${styleText} Highly detailed, clear composition, expressive colors, no text or letters in the image.`;
}
function analysisPrompt(story) {
  return `Eres un asistente que prepara la ilustración de un cuento en español escrito palabra por palabra por muchas personas, por lo que puede tener errores de ortografía, frases sueltas o escenas sin lógica. Tu trabajo es entenderlo con la máxima fidelidad, sin inventar nada que no esté en el texto.
Responde EXACTAMENTE con estas 4 etiquetas, cada una en su propia línea y sin texto extra:
INTERPRETACION: 2 a 4 frases en español que expliquen qué cuenta el texto (personajes, objetos, lugares, acciones y ambiente). Corrige mentalmente la ortografía. Si el texto es absurdo o incoherente, descríbelo tal cual, uniendo los elementos que aparecen, sin agregar tramas ni datos nuevos.
TITULO: un título corto y llamativo en español (máximo 6 palabras) que use solo elementos del texto.
ESTILO: A, B o C (A = animación 3D de película familiar, para cuentos infantiles, tiernos o graciosos; B = anime, para paisajes, aventura o fantasía; C = boceto a lápiz, para cuentos serios, oscuros o melancólicos).
ESCENA: descripción en inglés de 60 a 90 palabras, lista para un generador de imágenes: una sola escena concreta con los personajes y objetos principales (aspecto, tamaño, colores), el lugar, la acción, el ambiente, la iluminación y la composición. Usa solo elementos presentes en el texto o claramente implícitos. Sin texto ni letras en la imagen.
Cuento: "${story.slice(0, 2000)}"`;
}
function parseAnalysis(answer) {
  const re = /^[\s*#]*(INTERPRETACI[ÓO]N|T[ÍI]TULO|ESTILO|ESCENA)[\s*]*:[\s*]*/gim;
  const marks = []; let m;
  while ((m = re.exec(answer))) {
    marks.push({ key: m[1].toUpperCase().replace('Ó', 'O').replace('Í', 'I'), start: m.index, end: re.lastIndex });
  }
  const out = {};
  marks.forEach((mk, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].start : answer.length;
    out[mk.key] = answer.slice(mk.end, to).replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
  });
  if (!out.ESCENA) throw new Error('la IA respondió algo inesperado');
  const letter = (out.ESTILO || '').match(/[ABC]/i);
  return {
    interp: out.INTERPRETACION || '',
    title: (out.TITULO || '').replace(/^["'«“]+|["'»”.]+$/g, '').slice(0, 80),
    style: letter ? STYLE_BY_LETTER[letter[0].toUpperCase()] : null,
    scene: out.ESCENA.slice(0, 900)
  };
}

/* ============ CLAVES DE IA (solo en el navegador del administrador) ============ */
const KEYS_STORAGE = 'cuento_ai_keys';
function getKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS_STORAGE) || '{}'); } catch (e) { return {}; }
}
function saveKeys(k) {
  try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(k)); } catch (e) {}
}

/* ============ IA DE TEXTO (análisis, título) ============ */
const GEMINI_PREFERRED = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
let geminiModelsCache = null;
let geminiWorking = null;
async function geminiModelList(key) {
  if (geminiModelsCache) return geminiModelsCache;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`la clave no sirvió (${res.status})`);
  const data = await res.json();
  const all = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => /^gemini-/.test(n) && !/(image|tts|live|audio|embedding|robotics|computer|vision|thinking|exp)/.test(n));
  const pref = GEMINI_PREFERRED.filter(n => all.includes(n));
  const rest = all.filter(n => /flash/.test(n) && !pref.includes(n)).sort();
  geminiModelsCache = [...pref, ...rest];
  if (!geminiModelsCache.length) throw new Error('no hay modelos de texto disponibles');
  return geminiModelsCache;
}
async function callGemini(model, key, prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } })
  });
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (res.ok) {
    const text = (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    return { ok: !!text, status: res.status, text, msg: text ? '' : 'respuesta vacía (posible bloqueo de seguridad)' };
  }
  return { ok: false, status: res.status, text: '', msg: (body.error && body.error.message) || '' };
}
// Prueba varios modelos de Gemini: si uno da 429 (sin cuota) pasa al siguiente.
async function askGemini(prompt, key) {
  const models = await geminiModelList(key);
  const order = geminiWorking ? [geminiWorking, ...models.filter(m => m !== geminiWorking)] : models;
  const errs = [];
  for (const m of order.slice(0, 6)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await callGemini(m, key, prompt);
      if (r.ok) { geminiWorking = m; return r.text; }
      if (r.status === 401 || r.status === 403) throw new Error(`clave rechazada (${r.status}) ${r.msg.slice(0, 100)}`);
      if (r.status === 429 && attempt === 1 && !/limit:\s*0/i.test(r.msg)) { await wait(5000); continue; }
      errs.push(`${m}: ${r.status || 'sin respuesta'}${r.msg ? ' (' + r.msg.slice(0, 90) + ')' : ''}`);
      break;
    }
  }
  throw new Error(errs.join(' · '));
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
// Orden: Gemini (si hay clave), Pollinations con clave, Pollinations sin clave.
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
async function generateTitleWithAI(story, interp) {
  const base = interp
    ? `Resumen fiel del cuento: ${interp}\nTexto original: "${story.slice(0, 800)}"`
    : `Cuento: "${story.slice(0, 800)}"`;
  const prompt = `Genera un título corto y llamativo en español (máximo 6 palabras) para este cuento. Usa SOLO personajes, objetos y lugares que aparezcan en el texto: no inventes nada nuevo. Responde únicamente con el título, sin comillas ni punto final.\n${base}`;
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
async function generateWithPollinations(prompt, model, onStatus, key) {
  const seed = Math.floor(Math.random() * 1000000);
  const enc = encodeURIComponent(prompt);
  const legacy = (m) => `https://image.pollinations.ai/prompt/${enc}?width=1024&height=1024&seed=${seed}&nologo=true&model=${m}`;
  if (key) {
    // Modelo elegido con clave: si falla, se cae al motor gratuito
    try {
      const res = await fetch(`https://gen.pollinations.ai/image/${enc}?model=${encodeURIComponent(model)}&width=1024&height=1024&seed=${seed}&key=${encodeURIComponent(key)}`);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) return await compressBlobToDataURL(blob);
      }
      onStatus && onStatus(`⚠️ El modelo "${model}" respondió ${res.status}. Probando con el motor gratuito…`);
    } catch (e) {
      onStatus && onStatus(`⚠️ El modelo "${model}" falló (${e.message}). Probando con el motor gratuito…`);
    }
    model = 'flux';
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(legacy(model));
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
const REACTION_ICONS = { heart: '❤️', laugh: '😂', like: '👍', dislike: '👎', sad: '😢', clap: '👏', fire: '🔥', wow: '😮' };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Cuento publicado. Con animate=true: el título entra letra a letra y el cuento se "reescribe" palabra a palabra.
function renderPublished(data, animate) {
  const title = data.finalTitle || '';
  const story = data.finalStory || '';
  const t = $('padlet-title'), s = $('padlet-story');
  t.textContent = ''; s.textContent = '';
  t.setAttribute('aria-label', title);
  if (!animate || reducedMotion()) { t.textContent = title; s.textContent = story; return; }
  let n = 0;
  const titleWords = title.split(' ');
  titleWords.forEach((w, wi) => {
    const ws = document.createElement('span'); ws.className = 'tw';
    [...w].forEach(ch => {
      const c = document.createElement('span'); c.className = 'ch'; c.textContent = ch;
      c.style.animationDelay = (0.4 + n * 0.035) + 's'; n++; ws.appendChild(c);
    });
    t.appendChild(ws);
    if (wi < titleWords.length - 1) t.appendChild(document.createTextNode(' '));
  });
  const words = story.split(/\s+/).filter(Boolean);
  const step = Math.min(0.07, 3 / Math.max(words.length, 1));
  words.forEach((w, i) => {
    const sp = document.createElement('span'); sp.className = 'pw'; sp.textContent = w + ' ';
    sp.style.animationDelay = (1.3 + i * step) + 's'; s.appendChild(sp);
  });
}
function playReveal() {
  const p = $('padlet-current');
  p.classList.remove('reveal'); void p.offsetWidth; p.classList.add('reveal');
  if (reducedMotion()) return;
  const b = document.createElement('div'); b.className = 'burst';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 2000);
}

/* --- Reacciones --- */
function floatEmoji(key) {
  const layer = $('fx-layer');
  if (!layer || layer.children.length > 24) return;
  const el = document.createElement('span');
  el.className = 'fx fx-' + key;
  el.textContent = REACTION_ICONS[key] || '✨';
  el.style.left = (8 + Math.random() * 80) + 'vw';
  el.addEventListener('animationend', () => el.remove());
  layer.appendChild(el);
}
function updateReactionCounts() {
  document.querySelectorAll('.react-btn').forEach(b => {
    const n = reactionCounts[b.dataset.react] || 0;
    b.querySelector('.count').textContent = n > 0 ? n : '';
  });
}
function setReactionButtons(disabled) {
  document.querySelectorAll('.react-btn').forEach(b => { b.disabled = disabled; });
}
function startReactCooldown(seconds) {
  let remaining = Math.ceil(seconds);
  const msg = $('reaction-msg');
  setReactionButtons(true);
  if (reactCooldownTimer) clearInterval(reactCooldownTimer);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(reactCooldownTimer); reactCooldownTimer = null;
      msg.textContent = 'Reacciona cuando quieras.';
      setReactionButtons(false);
      return;
    }
    msg.textContent = `Podrás reaccionar de nuevo en ${remaining} s`;
    remaining--;
  };
  tick(); reactCooldownTimer = setInterval(tick, 1000);
}
async function sendReaction(key) {
  if (reactCooldownTimer || !currentStoryId || !currentUser) return;
  floatEmoji(key);
  startReactCooldown(REACTION_COOLDOWN);
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'reactionLimits', currentUser.uid), { lastAt: serverTimestamp() });
    batch.set(doc(collection(db, 'reactions')), {
      uid: currentUser.uid, emoji: key, storyId: currentStoryId, createdAt: serverTimestamp()
    });
    await batch.commit();
  } catch (e) {
    console.error(e);
    clearInterval(reactCooldownTimer); reactCooldownTimer = null;
    setReactionButtons(false);
    $('reaction-msg').textContent = 'No se pudo enviar la reacción. Inténtalo de nuevo en un momento.';
  }
}
document.querySelectorAll('.react-btn').forEach(b => b.addEventListener('click', () => sendReaction(b.dataset.react)));

function listenReactions(storyId, isPublished) {
  const k = `${storyId}|${isPublished}`;
  if (k === reactKey) return;
  reactKey = k;
  if (reactUnsub) { try { reactUnsub(); } catch (e) {} reactUnsub = null; }
  reactionCounts = {}; reactionsReady = false; updateReactionCounts();
  if (!storyId || !isPublished) return;
  reactUnsub = onSnapshot(query(collection(db, 'reactions'), where('storyId', '==', storyId)), (snap) => {
    const counts = {};
    snap.forEach(d => { const e = d.data().emoji; counts[e] = (counts[e] || 0) + 1; });
    reactionCounts = counts; updateReactionCounts();
    if (reactionsReady) {
      snap.docChanges().forEach(ch => {
        const d = ch.doc.data();
        if (ch.type === 'added' && d.uid !== (currentUser && currentUser.uid) && !ch.doc.metadata.hasPendingWrites) floatEmoji(d.emoji);
      });
    }
    reactionsReady = true;
  }, (err) => console.error('reactions error:', err));
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
  try {
    const r = await getDoc(doc(db, 'reactionLimits', currentUser.uid));
    const t = r.exists() ? r.data().lastAt : null;
    if (t && t.toDate) {
      const remaining = REACTION_COOLDOWN - (Date.now() - t.toDate().getTime()) / 1000;
      if (remaining > 1) startReactCooldown(remaining);
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
      const first = !!prevPublicStatus && prevPublicStatus !== 'published';
      renderPublished(data, first);
      $('padlet-image').src = data.finalImage || '';
      if (first) playReveal();
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
    listenReactions(data.storyId, isPublished);
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
function currentStyleKey() {
  const sv = $('style-select').value;
  return sv !== 'auto' ? sv : (analysisStyle || null);
}
function computeFinalPrompt() {
  const scene = $('scene-input').value.trim();
  const sk = currentStyleKey();
  return scene ? buildImagePrompt(scene, sk || 'cartoon3d') : buildCopyPrompt(currentFinalStory, sk);
}
function refreshPromptDisplay() {
  currentFinalPrompt = computeFinalPrompt();
  $('prompt-display').value = currentFinalPrompt;
}
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
  $('gen-pol-btn').disabled = busy || $('pol-model').disabled;
}
async function saveTitleEverywhere(title) {
  await setDoc(doc(db, 'state', 'current'), { finalTitle: title, updatedAt: serverTimestamp() }, { merge: true });
  if (adminStatus === 'published' && currentStoryId) {
    await setDoc(doc(db, 'stories', currentStoryId), { title, updatedAt: serverTimestamp() }, { merge: true });
  }
}
function resetAdminWorkArea() {
  pendingImage = null; pendingSource = null; serverImage = ''; analysisStyle = null;
  currentFinalStory = ''; currentFinalPrompt = '';
  ['edit-textarea', 'prompt-display', 'title-input', 'interp-input', 'scene-input'].forEach(id => { $(id).value = ''; });
  $('preview-block').classList.add('hidden');
  ['gen-error', 'gen-status', 'scene-info', 'style-info'].forEach(id => { $(id).textContent = ''; });
}

// Paso 1: la IA lee el cuento, lo interpreta y prepara la escena, el estilo y un título
async function runAnalysis() {
  const story = (currentFinalStory || '').trim();
  if (!story) { $('gen-error').textContent = 'Primero debe haber un cuento.'; return false; }
  $('analyze-btn').disabled = true;
  $('gen-error').textContent = ''; $('scene-info').textContent = '';
  $('gen-status').textContent = '⏳ La IA está leyendo el cuento…';
  try {
    const r = parseAnalysis(await askTextAI(analysisPrompt(story)));
    $('interp-input').value = r.interp;
    $('scene-input').value = r.scene;
    analysisStyle = r.style;
    $('style-info').textContent = r.style ? `Estilo elegido por la IA: ${STYLE_LABELS[r.style]}.` : '';
    if (r.title && !$('title-input').value.trim()) {
      $('title-input').value = r.title;
      await saveTitleEverywhere(r.title);
    }
    refreshPromptDisplay();
    $('gen-status').textContent = '✅ Listo. Revisa lo que entendió la IA y corrige lo que quieras antes de generar la imagen.';
    return true;
  } catch (e) {
    console.warn('análisis con IA falló:', e);
    $('scene-info').textContent = '⚠️ No se pudo analizar el cuento con IA (' + e.message + '). Puedes escribir la descripción a mano, o generar con el texto directo (menos fiel). Usa "Probar Gemini" en Claves de IA para ver qué falla.';
    $('gen-status').textContent = '';
    return false;
  } finally { $('analyze-btn').disabled = false; }
}

// Paso 2: imagen
async function runGeneration(model, useKey) {
  const story = (currentFinalStory || '').trim();
  if (!story) { $('gen-error').textContent = 'Primero debe haber un cuento.'; return; }
  lastEngine = { model, useKey };
  setGenBusy(true);
  $('gen-error').textContent = '';
  try {
    if (!$('scene-input').value.trim()) await runAnalysis();
    const scene = $('scene-input').value.trim();
    const sk = currentStyleKey() || 'cartoon3d';
    const prompt = scene ? buildImagePrompt(scene, sk) : buildFallbackPrompt(story, sk);
    $('gen-status').textContent = `⏳ Dibujando con ${model}… puede tardar entre 10 y 30 s`;
    const key = useKey ? (getKeys().pollen || '') : '';
    const dataURL = await generateWithPollinations(prompt, model, (m) => { $('gen-status').textContent = m; }, key);
    showPreview(dataURL, 'pollinations');
    $('gen-status').textContent = '✅ Imagen lista. Revisa la vista previa.';
  } catch (e) {
    console.error(e);
    $('gen-error').textContent = 'No se pudo generar: ' + e.message;
    $('gen-status').textContent = 'Prueba de nuevo, usa otro motor o el Plan B/C.';
  } finally { setGenBusy(false); }
}

async function loadPollModels() {
  const key = getKeys().pollen || '';
  const sel = $('pol-model');
  sel.innerHTML = '';
  if (!key) {
    sel.innerHTML = '<option value="">Guarda tu clave de Pollinations para ver los modelos</option>';
    sel.disabled = true; $('gen-pol-btn').disabled = true; return;
  }
  let names = [];
  try {
    const res = await fetch('https://gen.pollinations.ai/image/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    names = (Array.isArray(data) ? data : (data.models || [])).map(m => typeof m === 'string' ? m : (m.name || m.id)).filter(Boolean);
  } catch (e) { console.warn('modelos de Pollinations:', e); }
  if (!names.length) names = ['flux'];
  names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
  sel.disabled = false; $('gen-pol-btn').disabled = false;
}

/* --- Cuentos publicados (borrar de la galería) --- */
async function loadAdminStories() {
  const list = $('stories-list');
  list.textContent = 'Cargando…';
  try {
    const snap = await getDocs(query(collection(db, 'stories'), orderBy('publishedAt', 'desc')));
    list.textContent = '';
    if (snap.empty) { list.innerHTML = '<p class="info">No hay cuentos publicados.</p>'; return; }
    snap.forEach(d => {
      const s = d.data();
      const row = document.createElement('label'); row.className = 'story-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = d.id;
      const img = document.createElement('img'); img.src = s.image || ''; img.alt = ''; img.loading = 'lazy';
      const info = document.createElement('span'); info.className = 'story-row-info';
      const ts = s.publishedAt && s.publishedAt.toDate ? s.publishedAt.toDate().toLocaleString('es-AR') : '';
      info.textContent = s.title || 'Cuento sin título';
      const small = document.createElement('small'); small.textContent = ts; info.appendChild(small);
      row.append(cb, img, info); list.appendChild(row);
    });
  } catch (e) {
    console.error(e);
    list.textContent = 'No se pudo cargar la lista: ' + e.message;
  }
}

function setupAdmin() {
  $('admin-email').textContent = currentUser.email;
  const keys = getKeys();
  $('gemini-key').value = keys.gemini || '';
  $('pollen-key').value = keys.pollen || '';
  loadPollModels();
  loadAdminStories();

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
      : status === 'writing_closed' ? 'Estado: cuento CERRADO. Analízalo con IA, genera el título y la imagen.'
      : 'Estado: cuento PUBLICADO. Puedes seguir editándolo.';

    const showIllus = (status === 'writing_closed' || status === 'published');
    $('illustration-block').classList.toggle('hidden', !showIllus);
    $('edit-block').classList.toggle('hidden', !showIllus);

    if (showIllus) {
      if (document.activeElement !== $('edit-textarea')) $('edit-textarea').value = currentFinalStory;
      if (!currentFinalPrompt) currentFinalPrompt = buildCopyPrompt(currentFinalStory, currentStyleKey());
      $('prompt-display').value = $('scene-input').value.trim() ? computeFinalPrompt() : currentFinalPrompt;
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
    await setDoc(ref, {
      status: 'writing_closed', finalStory: story, finalPrompt: buildCopyPrompt(story, sv === 'auto' ? null : sv),
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
    currentFinalStory = newText;
    refreshPromptDisplay();
    try {
      await setDoc(doc(db, 'state', 'current'), { finalStory: newText, finalPrompt: currentFinalPrompt, updatedAt: serverTimestamp() }, { merge: true });
      if (adminStatus === 'published' && currentStoryId) {
        await setDoc(doc(db, 'stories', currentStoryId), { story: newText, updatedAt: serverTimestamp() }, { merge: true });
      }
      $('edit-feedback').textContent = '✅ Guardado. Si cambiaste el cuento, vuelve a analizarlo con IA.';
    } catch (e) { console.error(e); $('edit-feedback').textContent = 'No se pudo guardar: ' + e.message; }
    setTimeout(() => { $('edit-feedback').textContent = ''; }, 5000);
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
      const title = await generateTitleWithAI(story, $('interp-input').value.trim());
      $('title-input').value = title;
      await saveTitleEverywhere(title);
      $('title-feedback').textContent = '✅ Título generado. Puedes editarlo a mano.';
    } catch (e) {
      console.error(e);
      $('title-feedback').textContent = 'No se pudo generar con IA (' + e.message + '). Escríbelo a mano o revisa "Claves de IA".';
    } finally { $('gen-title-btn').disabled = false; }
  });

  // Claves
  $('save-keys-btn').addEventListener('click', () => {
    saveKeys({ gemini: $('gemini-key').value.trim(), pollen: $('pollen-key').value.trim() });
    geminiModelsCache = null; geminiWorking = null;
    $('keys-feedback').textContent = '✅ Claves guardadas en este navegador.';
    loadPollModels();
  });
  $('test-gemini-btn').addEventListener('click', async () => {
    const key = $('gemini-key').value.trim();
    const fb = $('keys-feedback');
    if (!key) { fb.textContent = 'Primero pega tu clave de Gemini.'; return; }
    fb.textContent = '⏳ Probando Gemini…';
    geminiModelsCache = null;
    try {
      const models = await geminiModelList(key);
      const lines = [];
      for (const m of models.slice(0, 5)) {
        const r = await callGemini(m, key, 'Responde solo con la palabra OK.');
        lines.push(`${r.ok ? '✅' : '❌'} ${m}: ${r.ok ? 'funciona' : (r.status + ' ' + r.msg.slice(0, 110))}`);
        if (r.ok) { geminiWorking = m; break; }
      }
      fb.textContent = lines.join('\n');
    } catch (e) { fb.textContent = '❌ ' + e.message; }
  });

  // Análisis, estilo y prompt
  $('analyze-btn').addEventListener('click', runAnalysis);
  $('scene-input').addEventListener('input', refreshPromptDisplay);
  $('style-select').addEventListener('change', refreshPromptDisplay);
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
  $('gen-flux-btn').addEventListener('click', () => runGeneration('flux', false));
  $('gen-turbo-btn').addEventListener('click', () => runGeneration('turbo', false));
  $('gen-pol-btn').addEventListener('click', () => runGeneration($('pol-model').value || 'flux', true));
  $('regen-btn').addEventListener('click', () => {
    if (pendingSource === 'manual') $('upload-input').click();
    else runGeneration(lastEngine.model, lastEngine.useKey);
  });

  // Subir (Plan B) o pegar una imagen (Ctrl+V)
  const loadImageFile = async (file) => {
    $('gen-error').textContent = ''; $('gen-status').textContent = '⏳ Preparando la imagen…';
    try {
      showPreview(await compressBlobToDataURL(file), 'manual');
      $('gen-status').textContent = '✅ Imagen cargada. Revisa la vista previa.';
    } catch (err) {
      console.error(err);
      $('gen-error').textContent = 'No se pudo procesar la imagen: ' + err.message;
      $('gen-status').textContent = '';
    }
  };
  $('upload-btn').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    await loadImageFile(file);
    e.target.value = '';
  });
  document.addEventListener('paste', (e) => {
    if (!isAdmin || $('illustration-block').classList.contains('hidden')) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    loadImageFile(item.getAsFile());
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
    const finalPrompt = computeFinalPrompt();
    try {
      await setDoc(doc(db, 'stories', currentStoryId), {
        title, story: currentFinalStory, prompt: finalPrompt,
        image: img, style: sv, storyId: currentStoryId,
        publishedAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      await setDoc(doc(db, 'state', 'current'), {
        status: 'published',
        finalStory: currentFinalStory, finalPrompt,
        finalTitle: title, finalImage: img, finalStyle: sv,
        publishedAt: serverTimestamp(), updatedAt: serverTimestamp()
      }, { merge: true });
      pendingImage = null; pendingSource = null;
      $('gen-status').textContent = '✅ Publicado.';
      loadAdminStories();
    } catch (e) {
      console.error(e);
      $('gen-error').textContent = 'Error al publicar: ' + (e.code ? e.code + ' · ' : '') + e.message;
      $('gen-status').textContent = '';
      updatePublishButton();
    }
  });

  // Gestor de cuentos publicados
  $('stories-refresh-btn').addEventListener('click', loadAdminStories);
  $('stories-all-btn').addEventListener('click', () => {
    const boxes = [...$('stories-list').querySelectorAll('input[type=checkbox]')];
    const all = boxes.length > 0 && boxes.every(b => b.checked);
    boxes.forEach(b => { b.checked = !all; });
    $('stories-all-btn').textContent = all ? 'Marcar todos' : 'Desmarcar todos';
  });
  $('stories-delete-btn').addEventListener('click', async () => {
    const fb = $('stories-feedback');
    const ids = [...$('stories-list').querySelectorAll('input:checked')].map(i => i.value);
    if (!ids.length) { fb.textContent = 'Marca al menos un cuento.'; return; }
    if (!confirm(`¿Eliminar ${ids.length} cuento(s) de la galería? No se puede deshacer.`)) return;
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(db);
        ids.slice(i, i + 400).forEach(id => batch.delete(doc(db, 'stories', id)));
        await batch.commit();
      }
      fb.textContent = `✅ Eliminados: ${ids.length}.` + (ids.includes(currentStoryId) && adminStatus === 'published'
        ? ' El cuento que está en pantalla para el público sigue visible: usa "Reiniciar todo" para quitarlo.' : '');
      loadAdminStories();
    } catch (e) {
      console.error(e);
      fb.textContent = 'No se pudo eliminar: ' + (e.code ? e.code + ' · ' : '') + e.message
        + (e.code === 'permission-denied' ? ' (las reglas de Firestore no permiten borrar en "stories")' : '');
    }
  });
}
