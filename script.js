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
let unsubs = [];
let currentStoryId = null;
let currentFinalStory = '';
let currentFinalPrompt = '';
let currentPreviewImage = null;
let currentPreviewSource = null;

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
}
function newStoryId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function buildPrompt(story, styleKey) {
  const style = STYLES[styleKey] || STYLES.cartoon3d;
  const trimmed = story.length > STORY_PROMPT_LIMIT ? story.slice(0, STORY_PROMPT_LIMIT) + '…' : story;
  return `Illustration for a short story. Story plot: "${trimmed}". Represent the central scene or idea of the story with its characters and environment. Style: ${style}. Clear composition, expressive colors, no text or letters in the image.`;
}

async function compressBlobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width >= height && width > IMAGE_MAX_SIZE) {
        height = Math.round(height * IMAGE_MAX_SIZE / width); width = IMAGE_MAX_SIZE;
      } else if (height > IMAGE_MAX_SIZE) {
        width = Math.round(width * IMAGE_MAX_SIZE / height); height = IMAGE_MAX_SIZE;
      }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
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
  return await compressBlobToDataURL(await res.blob());
}
async function generateTitleWithAI(story) {
  const prompt = `Genera un título corto, llamativo y creativo (máximo 6 palabras) para este cuento. Responde SOLO con el título, sin comillas ni explicaciones. Cuento: "${story.slice(0, 500)}"`;
  const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pollinations texto respondió ${res.status}`);
  let title = (await res.text()).trim();
  title = title.replace(/^["'«»“”]|["'«»“”]$/g, '').trim();
  if (title.length > 80) title = title.slice(0, 80);
  return title || 'Cuento sin título';
}

/* ============ TABS ============ */
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
      finalStyle: 'cartoon3d', updatedAt: serverTimestamp()
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
  if (!data.finalStyle) fixes.finalStyle = 'cartoon3d';
  if (Object.keys(fixes).length > 0) {
    await setDoc(ref, fixes, { merge: true });
  }
}

/* ============ VISTA PÚBLICA ============ */
function setupPublicView() {
  $('my-nickname').textContent = currentNickname || 'Anónimo';

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
    } else {
      const badge = $('status-badge');
      badge.textContent = isOpen ? '🟢 Escritura abierta'
                       : isIdle ? '⏳ Esperando inicio'
                       : '🔴 Cuento terminado';
      badge.className = 'badge ' + (isOpen ? 'open' : isIdle ? 'idle' : 'closed');
      $('writing-controls').classList.toggle('hidden', !isOpen);
      $('illustrating-msg').classList.toggle('hidden', isOpen || isIdle);
      $('idle-msg').classList.toggle('hidden', !isIdle);
      if (!isOpen) {
        $('word-input').disabled = true; $('send-btn').disabled = true;
      } else if (!cooldownInterval) {
        $('word-input').disabled = false; $('send-btn').disabled = false;
      }
    }
    listenContributions(data.storyId, isPublished, 'story-container');
  }, (err) => console.error('state snapshot error:', err));
  unsubs.push(u);
}

let publicContribUnsub = null;
function listenContributions(storyId, isPublished, targetId) {
  if (publicContribUnsub) { try { publicContribUnsub(); } catch (e) {} publicContribUnsub = null; }
  const el = $(targetId);
  if (!storyId || isPublished) { el.textContent = ''; return; }
  // SIN filtro en el servidor: traemos todo y filtramos por código.
  const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
  publicContribUnsub = onSnapshot(q, (snap) => {
    const parts = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.storyId === storyId && data.text) parts.push(data.text);
    });
    el.textContent = parts.join(' ');
    el.scrollTop = el.scrollHeight;
  }, (err) => {
    console.error('contributions error:', err);
    el.textContent = '(error al leer aportes: ' + err.message + ')';
  });
}

/* ============ GALERÍA ============ */
let galleryLoaded = false;
async function loadGallery() {
  const grid = $('gallery-grid');
  grid.innerHTML = '<p class="info">Cargando cuentos…</p>';
  try {
    const q = query(collection(db, 'stories'), orderBy('publishedAt', 'desc'));
    const snap = await getDocs(q);
    grid.innerHTML = '';
    if (snap.empty) {
      $('gallery-empty').classList.remove('hidden');
      return;
    }
    $('gallery-empty').classList.add('hidden');
    snap.forEach(d => {
      const s = d.data();
      const card = document.createElement('div');
      card.className = 'gallery-card';
      const img = document.createElement('img');
      img.src = s.image || ''; img.alt = s.title || 'Cuento';
      const title = document.createElement('div');
      title.className = 'gallery-title'; title.textContent = s.title || 'Cuento sin título';
      const story = document.createElement('div');
      story.className = 'gallery-story'; story.textContent = s.story || '';
      const date = document.createElement('div');
      date.className = 'gallery-date';
      const ts = s.publishedAt && s.publishedAt.toDate ? s.publishedAt.toDate() : null;
      date.textContent = ts ? ts.toLocaleString('es-AR') : '';
      card.appendChild(img); card.appendChild(title); card.appendChild(story); card.appendChild(date);
      grid.appendChild(card);
    });
    galleryLoaded = true;
  } catch (err) {
    console.error('gallery error:', err);
    grid.innerHTML = '<p class="error">No se pudo cargar la galería.</p>';
  }
}

/* ============ ENVÍO ============ */
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
  $('word-input').disabled = true; $('send-btn').disabled = true;
  if (cooldownInterval) clearInterval(cooldownInterval);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(cooldownInterval); cooldownInterval = null; msg.textContent = '';
      if ($('status-badge').classList.contains('open')) {
        $('word-input').disabled = false; $('send-btn').disabled = false;
      }
      return;
    }
    msg.textContent = `⏳ Espera ${remaining} s para volver a escribir`;
    remaining--;
  };
  tick(); cooldownInterval = setInterval(tick, 1000);
}

/* ============ PANEL ADMIN ============ */
function setupAdmin() {
  $('admin-email').textContent = currentUser.email;

  let adminContribUnsub = null;

  const u = onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const status = data.status || 'idle';
    currentStoryId = data.storyId || null;
    currentFinalStory = data.finalStory || '';
    currentFinalPrompt = data.finalPrompt || '';
    currentPreviewImage = data.finalImage || null;

    // Botones separados
    const openBtn = $('open-btn'); const closeBtn = $('close-btn');
    openBtn.disabled = (status !== 'idle');
    closeBtn.disabled = (status !== 'writing_open');
    openBtn.textContent = (status === 'idle') ? '▶ Comenzar cuento' : '▶ Comenzar cuento';
    closeBtn.textContent = (status === 'writing_open') ? '⏹ Cerrar y terminar cuento' : '⏹ Cerrar y terminar cuento';

    $('state-info').textContent =
      status === 'idle' ? 'Estado: sin cuento activo.'
      : status === 'writing_open' ? 'Estado: escritura ABIERTA.'
      : status === 'writing_closed' ? 'Estado: cuento CERRADO. Genera título, prompt e imagen.'
      : 'Estado: cuento PUBLICADO. Puedes seguir editándolo.';

    const showIllus = (status === 'writing_closed' || status === 'published');
    $('illustration-block').classList.toggle('hidden', !showIllus);
    $('edit-block').classList.toggle('hidden', !showIllus);

    if (showIllus) {
      if (document.activeElement !== $('edit-textarea')) {
        $('edit-textarea').value = currentFinalStory;
      }
      if (!currentFinalPrompt) {
        currentFinalPrompt = buildPrompt(currentFinalStory, $('style-select').value);
      }
      $('prompt-display').value = currentFinalPrompt;
      if (document.activeElement !== $('title-input')) {
        $('title-input').value = data.finalTitle || '';
      }
    }

    if ((status === 'writing_closed' || status === 'published') && data.finalImage) {
      $('preview-image').src = data.finalImage;
      $('preview-block').classList.remove('hidden');
      $('publish-btn').disabled = (status === 'published');
      currentPreviewImage = data.finalImage;
    } else {
      $('preview-block').classList.add('hidden');
    }

    // Vista en vivo del cuento
    if (adminContribUnsub) { try { adminContribUnsub(); } catch (e) {} adminContribUnsub = null; }
    if (!data.storyId) {
      $('admin-story').textContent = '(sin cuento todavía)';
    } else if (status === 'writing_closed' || status === 'published') {
      $('admin-story').textContent = currentFinalStory || '(sin cuento todavía)';
    } else if (status === 'idle') {
      $('admin-story').textContent = '(sin cuento todavía)';
    } else {
      const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
      adminContribUnsub = onSnapshot(q, (s2) => {
        const parts = [];
        s2.forEach(d => {
          const dd = d.data();
          if (dd.storyId === data.storyId && dd.text) parts.push(dd.text);
        });
        $('admin-story').textContent = parts.join(' ') || '(esperando primeras palabras…)';
      }, (err) => {
        console.error('admin contrib error:', err);
        $('admin-story').textContent = '(error al leer aportes)';
      });
    }
  }, (err) => console.error('admin state error:', err));
  unsubs.push(u);
  unsubs.push(() => adminContribUnsub && adminContribUnsub());

  // BOTÓN ABRIR
  $('open-btn').addEventListener('click', async () => {
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    if ((data.status || 'idle') !== 'idle') return;
    const storyId = newStoryId();
    await setDoc(ref, {
      status: 'writing_open', storyId,
      finalStory: '', finalPrompt: '', finalTitle: '', finalImage: '',
      finalStyle: $('style-select').value,
      startedAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true });
    $('edit-textarea').value = ''; $('prompt-display').value = ''; $('title-input').value = '';
    $('preview-block').classList.add('hidden');
    $('gen-error').textContent = ''; $('gen-status').textContent = '';
  });

  // BOTÓN CERRAR
  $('close-btn').addEventListener('click', async () => {
    if (!confirm('¿Cerrar y terminar el cuento? Después no se podrán añadir más palabras.')) return;
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    if ((data.status || '') !== 'writing_open') return;
    const q = query(collection(db, 'contributions'), orderBy('createdAt', 'asc'));
    const snapStory = await getDocs(q);
    const parts = [];
    snapStory.forEach(d => {
      const dd = d.data();
      if (dd.storyId === data.storyId && dd.text) parts.push(dd.text);
    });
    const story = parts.join(' ');
    const prompt = buildPrompt(story, $('style-select').value);
    await setDoc(ref, {
      status: 'writing_closed', finalStory: story, finalPrompt: prompt,
      closedAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true });
    currentFinalStory = story; currentFinalPrompt = prompt;
  });

  // Reiniciar
  $('reset-btn').addEventListener('click', async () => {
    if (!confirm('¿Reiniciar? Se empezará un cuento nuevo. Los publicados quedan en la galería.')) return;
    await setDoc(doc(db, 'state', 'current'), {
      status: 'idle', storyId: newStoryId(),
      finalStory: '', finalPrompt: '', finalTitle: '', finalImage: '',
      finalStyle: $('style-select').value, updatedAt: serverTimestamp()
    }, { merge: true });
    currentFinalStory = ''; currentFinalPrompt = ''; currentPreviewImage = null;
    $('edit-textarea').value = ''; $('prompt-display').value = ''; $('title-input').value = '';
    $('preview-block').classList.add('hidden');
    $('gen-error').textContent = ''; $('gen-status').textContent = '';
  });

  // Logout
  $('logout-btn').addEventListener('click', async () => {
    if (!confirm('¿Cerrar sesión del panel?')) return;
    clearAllListeners();
    await signOut(auth);
    try { await signInAnonymously(auth); } catch (e) {}
  });

  // Guardar edición
  $('save-edit-btn').addEventListener('click', async () => {
    const newText = $('edit-textarea').value.trim();
    const newPrompt = buildPrompt(newText, $('style-select').value);
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const status = snap.exists() ? snap.data().status : 'writing_closed';
    await setDoc(ref, { finalStory: newText, finalPrompt: newPrompt, updatedAt: serverTimestamp() }, { merge: true });
    if (status === 'published' && currentStoryId) {
      await setDoc(doc(db, 'stories', currentStoryId), {
        story: newText, updatedAt: serverTimestamp()
      }, { merge: true });
      galleryLoaded = false;
    }
    currentFinalStory = newText; currentFinalPrompt = newPrompt;
    $('prompt-display').value = newPrompt;
    $('edit-feedback').textContent = '✅ Guardado.';
    setTimeout(() => { $('edit-feedback').textContent = ''; }, 3000);
  });
  $('cancel-edit-btn').addEventListener('click', () => { $('edit-textarea').value = currentFinalStory; });

  // Guardar título
  $('title-input').addEventListener('change', async () => {
    const newTitle = $('title-input').value.trim();
    const ref = doc(db, 'state', 'current');
    const snap = await getDoc(ref);
    const status = snap.exists() ? snap.data().status : 'writing_closed';
    await setDoc(ref, { finalTitle: newTitle, updatedAt: serverTimestamp() }, { merge: true });
    if (status === 'published' && currentStoryId) {
      await setDoc(doc(db, 'stories', currentStoryId), { title: newTitle, updatedAt: serverTimestamp() }, { merge: true });
      galleryLoaded = false;
    }
  });

  // Generar título
  $('gen-title-btn').addEventListener('click', async () => {
    const story = $('edit-textarea').value.trim() || currentFinalStory;
    if (!story) { $('title-feedback').textContent = 'Primero debe haber un cuento.'; return; }
    $('title-feedback').textContent = '⏳ Generando título…';
    $('gen-title-btn').disabled = true;
    try {
      const title = await generateTitleWithAI(story);
      $('title-input').value = title;
      const ref = doc(db, 'state', 'current');
      const snap = await getDoc(ref);
      const status = snap.exists() ? snap.data().status : 'writing_closed';
      await setDoc(ref, { finalTitle: title, updatedAt: serverTimestamp() }, { merge: true });
      if (status === 'published' && currentStoryId) {
        await setDoc(doc(db, 'stories', currentStoryId), { title, updatedAt: serverTimestamp() }, { merge: true });
        galleryLoaded = false;
      }
      $('title-feedback').textContent = '✅ Título generado.';
    } catch (e) {
      console.error(e);
      $('title-feedback').textContent = 'No se pudo generar. Escribe uno a mano.';
    } finally {
      $('gen-title-btn').disabled = false;
      setTimeout(() => { $('title-feedback').textContent = ''; }, 5000);
    }
  });

  $('style-select').addEventListener('change', () => {
    currentFinalPrompt = buildPrompt(currentFinalStory, $('style-select').value);
    $('prompt-display').value = currentFinalPrompt;
  });

  $('copy-prompt-btn').addEventListener('click', async () => {
    const text = $('prompt-display').value;
    try { await navigator.clipboard.writeText(text); }
    catch (e) { $('prompt-display').select(); document.execCommand('copy'); }
    $('copy-feedback').textContent = '✅ Prompt copiado.';
    setTimeout(() => { $('copy-feedback').textContent = ''; }, 6000);
  });

  $('gen-pollinations-btn').addEventListener('click', async () => {
    $('gen-error').textContent = '';
    $('gen-status').textContent = '⏳ Generando con Pollinations… (10-30 s)';
    $('gen-pollinations-btn').disabled = true;
    try {
      const prompt = $('prompt-display').value || currentFinalPrompt;
      const dataURL = await generateWithPollinations(prompt);
      showPreview(dataURL, 'pollinations');
      $('gen-status').textContent = '✅ Imagen generada.';
    } catch (e) {
      console.error(e);
      $('gen-error').textContent = 'No se pudo generar: ' + e.message;
      $('gen-status').textContent = 'Prueba de nuevo o usa el Plan B.';
    } finally { $('gen-pollinations-btn').disabled = false; }
  });

  $('upload-btn').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $('gen-error').textContent = ''; $('gen-status').textContent = '⏳ Comprimiendo…';
    try {
      const dataURL = await compressBlobToDataURL(file);
      showPreview(dataURL, 'manual');
      $('gen-status').textContent = '✅ Imagen cargada.';
    } catch (err) { console.error(err); $('gen-error').textContent = 'No se pudo procesar la imagen.'; }
    e.target.value = '';
  });

  $('regen-btn').addEventListener('click', () => {
    if (currentPreviewSource === 'manual') $('upload-input').click();
    else $('gen-pollinations-btn').click();
  });

  $('publish-btn').addEventListener('click', async () => {
    if (!currentPreviewImage) return;
    if (!confirm('¿Publicar el cuento y la imagen para todos?')) return;
    $('publish-btn').disabled = true; $('gen-status').textContent = '⏳ Publicando…';
    const title = $('title-input').value.trim() || 'Cuento sin título';
    try {
      await setDoc(doc(db, 'state', 'current'), {
        status: 'published',
        finalStory: currentFinalStory,
        finalPrompt: currentFinalPrompt,
        finalTitle: title,
        finalImage: currentPreviewImage,
        finalStyle: $('style-select').value,
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      await setDoc(doc(db, 'stories', currentStoryId), {
        title, story: currentFinalStory, prompt: currentFinalPrompt,
        image: currentPreviewImage, style: $('style-select').value,
        storyId: currentStoryId,
        publishedAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      galleryLoaded = false;
      $('gen-status').textContent = '✅ Publicado.';
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
