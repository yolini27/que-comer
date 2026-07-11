/* ¿Qué comer? — todo local, sin backend. */
'use strict';

// ===================== Constantes =====================
const TYPES = [
  { id: 'desayuno', label: '🍳 Desayuno' },
  { id: 'almuerzo', label: '🍽️ Almuerzo/Cena' },
  { id: 'snack',    label: '🍿 Snackito' },
];
const DEFAULT_DISTRICTS = ['Surco', 'Miraflores', 'Barranco', 'San Isidro', 'San Borja', 'Delivery'];
const NEVER_EATEN_DAYS = 45; // peso para "sorpréndeme" cuando nunca se comió

// ===================== IndexedDB =====================
let _db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('que-comer', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function db() { if (!_db) _db = await openDB(); return _db; }
async function dbOp(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const dbPutFood    = (f)  => dbOp('foods', 'readwrite', (s) => s.put(f));
const dbDeleteFood = (id) => dbOp('foods', 'readwrite', (s) => s.delete(id));
const dbGetFoods   = ()   => dbOp('foods', 'readonly',  (s) => s.getAll());
const dbClearFoods = ()   => dbOp('foods', 'readwrite', (s) => s.clear());
const dbGetSetting = (k)  => dbOp('settings', 'readonly',  (s) => s.get(k));
const dbPutSetting = (k, v) => dbOp('settings', 'readwrite', (s) => s.put({ key: k, value: v }));

// ===================== Estado =====================
let foods = [];              // caché en memoria
let customDistricts = [];    // distritos agregados por la usuaria
let filters = { type: null, district: null, favs: false };
let decide = { type: null, district: null };
let editingId = null;        // id en edición, null = nueva
let formPhoto = null;        // { blob } foto pendiente del formulario
let detailId = null;         // comida abierta en detalle
let resultId = null;         // comida mostrada en resultado sorpresa
let rollTimer = null;

const photoURLs = new Map(); // id -> objectURL
const $ = (sel) => document.querySelector(sel);

function allDistricts() { return [...DEFAULT_DISTRICTS, ...customDistricts]; }

// ===================== Utilidades =====================
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function lastEaten(food) {
  if (!food.eatenDates || !food.eatenDates.length) return null;
  return food.eatenDates.reduce((a, b) => (a > b ? a : b));
}
function daysSinceEaten(food) {
  const last = lastEaten(food);
  if (!last) return null;
  return Math.round((startOfDay(new Date()) - startOfDay(new Date(last))) / 86400000);
}
function fmtAgo(days) {
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 14) return `hace ${days} días`;
  if (days < 60) return `hace ${Math.round(days / 7)} sem`;
  return `hace ${Math.round(days / 30)} meses`;
}
function photoURL(food) {
  if (!food.photo) return null;
  if (!photoURLs.has(food.id)) photoURLs.set(food.id, URL.createObjectURL(food.photo));
  return photoURLs.get(food.id);
}
function dropPhotoURL(id) {
  if (photoURLs.has(id)) { URL.revokeObjectURL(photoURLs.get(id)); photoURLs.delete(id); }
}
function typeLabel(id) { const t = TYPES.find((t) => t.id === id); return t ? t.label : id; }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===================== Compresión de fotos =====================
async function compressImage(file, maxDim = 800, quality = 0.82) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
      img.src = url;
    });
  }
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, cw, ch);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('No se pudo comprimir la foto');
  return blob;
}

// ===================== Chips genéricos =====================
function renderChips(container, options, selected, onTap, { allLabel = null, addButton = false } = {}) {
  container.innerHTML = '';
  const mk = (label, value, on) => {
    const b = document.createElement('button');
    b.className = 'chip' + (on ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => onTap(value));
    container.appendChild(b);
    return b;
  };
  if (allLabel !== null) mk(allLabel, null, selected === null);
  for (const opt of options) {
    const value = typeof opt === 'string' ? opt : opt.id;
    const label = typeof opt === 'string' ? opt : opt.label;
    mk(label, value, selected === value);
  }
  if (addButton) {
    const b = mk('+ Otro', '__add__', false);
    b.classList.add('add-chip');
  }
}

async function promptNewDistrict() {
  const name = (prompt('Nombre del nuevo distrito o lugar:') || '').trim();
  if (!name) return null;
  const existing = allDistricts().find((d) => d.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  customDistricts.push(name);
  await dbPutSetting('customDistricts', customDistricts);
  return name;
}

// ===================== Galería =====================
function visibleFoods() {
  return foods.filter((f) =>
    (!filters.type || f.type === filters.type) &&
    (!filters.district || f.district === filters.district) &&
    (!filters.favs || f.favorite)
  );
}

function makeCard(food, onTap) {
  const card = document.createElement('div');
  card.className = 'card';
  const url = photoURL(food);
  const days = daysSinceEaten(food);
  card.innerHTML = `
    ${url ? `<img src="${url}" alt="" loading="lazy">` : `<div class="no-photo">🍽️</div>`}
    ${days !== null ? `<span class="badge-ago">${fmtAgo(days)}</span>` : ''}
    ${food.favorite ? `<span class="badge-fav">❤️</span>` : ''}
    <div class="card-label">
      <div class="name">${escapeHTML(food.name)}</div>
      ${food.place ? `<div class="place">${escapeHTML(food.place)}</div>` : ''}
    </div>`;
  card.addEventListener('click', () => onTap(food));
  return card;
}

function renderGallery() {
  renderChips($('#filter-type-chips'), TYPES, filters.type, (v) => {
    filters.type = filters.type === v ? null : v;
    renderGallery();
  }, { allLabel: 'Todo' });

  // chip de favoritos al final de la fila de tipos
  const favChip = document.createElement('button');
  favChip.className = 'chip' + (filters.favs ? ' on' : '');
  favChip.textContent = '❤️ Favs';
  favChip.addEventListener('click', () => { filters.favs = !filters.favs; renderGallery(); });
  $('#filter-type-chips').appendChild(favChip);

  const usedDistricts = allDistricts().filter((d) => foods.some((f) => f.district === d));
  renderChips($('#filter-district-chips'), usedDistricts, filters.district, (v) => {
    filters.district = filters.district === v ? null : v;
    renderGallery();
  }, { allLabel: '📍 Todos' });

  const grid = $('#grid');
  grid.innerHTML = '';
  const list = visibleFoods();
  for (const f of list) grid.appendChild(makeCard(f, openDetail));

  $('#empty-state').classList.toggle('hidden', foods.length > 0);
  $('#empty-filter').classList.toggle('hidden', !(foods.length > 0 && list.length === 0));
}

// ===================== Pantallas =====================
function openScreen(id) { $('#' + id).classList.add('open'); }
function closeScreen(id) { $('#' + id).classList.remove('open'); }

// ===================== Formulario =====================
function openForm(food = null) {
  editingId = food ? food.id : null;
  formPhoto = food && food.photo ? { blob: food.photo } : null;
  $('#form-title').textContent = food ? 'Editar comida' : 'Nueva comida';
  $('#f-name').value = food ? food.name : '';
  $('#f-place').value = food ? (food.place || '') : '';
  $('#f-notes').value = food ? (food.notes || '') : '';
  formState.type = food ? food.type : null;
  formState.district = food ? food.district : null;
  updateFormPhotoPreview();
  renderFormChips();
  openScreen('screen-form');
}
const formState = { type: null, district: null };

function renderFormChips() {
  renderChips($('#form-type-chips'), TYPES, formState.type, (v) => {
    formState.type = v; renderFormChips();
  });
  renderChips($('#form-district-chips'), allDistricts(), formState.district, async (v) => {
    if (v === '__add__') {
      const name = await promptNewDistrict();
      if (name) formState.district = name;
    } else {
      formState.district = v;
    }
    renderFormChips();
  }, { addButton: true });
}

function updateFormPhotoPreview() {
  const img = $('#photo-preview');
  const ph = $('#photo-placeholder');
  if (img.dataset.tmp) { URL.revokeObjectURL(img.src); delete img.dataset.tmp; }
  if (formPhoto) {
    img.src = URL.createObjectURL(formPhoto.blob);
    img.dataset.tmp = '1';
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    ph.classList.remove('hidden');
  }
}

async function handlePhotoInput(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await compressImage(file);
    formPhoto = { blob };
    updateFormPhotoPreview();
  } catch (err) {
    console.error(err);
    toast('😖 No se pudo procesar la foto');
  }
}

async function saveForm() {
  const name = $('#f-name').value.trim();
  if (!formState.type) return toast('Elige el tipo 🍳');
  if (!formState.district) return toast('Elige el distrito 📍');
  if (!name) return toast('Ponle nombre al plato ✍️');

  const existing = editingId ? foods.find((f) => f.id === editingId) : null;
  const food = {
    id: editingId || crypto.randomUUID(),
    name,
    place: $('#f-place').value.trim(),
    notes: $('#f-notes').value.trim(),
    type: formState.type,
    district: formState.district,
    photo: formPhoto ? formPhoto.blob : null,
    favorite: existing ? existing.favorite : false,
    eatenDates: existing ? existing.eatenDates : [],
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
  await dbPutFood(food);
  dropPhotoURL(food.id);
  const idx = foods.findIndex((f) => f.id === food.id);
  if (idx >= 0) foods[idx] = food; else foods.unshift(food);
  closeScreen('screen-form');
  renderGallery();
  if (detailId === food.id) renderDetail();
  toast(existing ? 'Guardado ✨' : '¡Agregado! 🎉');
}

// ===================== Detalle =====================
function openDetail(food) {
  detailId = food.id;
  renderDetail();
  openScreen('screen-detail');
}

function renderDetail() {
  const food = foods.find((f) => f.id === detailId);
  if (!food) { closeScreen('screen-detail'); return; }
  const url = photoURL(food);
  const days = daysSinceEaten(food);
  $('#btn-fav-detail').textContent = food.favorite ? '❤️' : '🤍';
  $('#btn-fav-detail').classList.toggle('on', food.favorite);
  $('#detail-body').innerHTML = `
    ${url ? `<img class="detail-photo" src="${url}" alt="">` : `<div class="detail-photo no-photo">🍽️</div>`}
    <div class="detail-name">${escapeHTML(food.name)}</div>
    ${food.place ? `<div class="detail-place">📍 ${escapeHTML(food.place)}</div>` : ''}
    <div class="detail-tags">
      <span class="tag">${typeLabel(food.type)}</span>
      <span class="tag">${escapeHTML(food.district)}</span>
    </div>
    <div class="detail-ago">${days === null ? '🕐 Aún no lo registras' : `🕐 Lo comiste ${fmtAgo(days)}${days === 0 ? ' 😋' : ''}`}</div>
    ${food.notes ? `<div class="notes-box"><div class="notes-title">📝 Cómo lo pido</div>${escapeHTML(food.notes)}</div>` : ''}
    <button class="btn primary big" id="btn-eat">✓ ¡Lo comí hoy!</button>
    <div class="row-2">
      <button class="btn secondary" id="btn-edit">✏️ Editar</button>
      <button class="btn danger" id="btn-delete">🗑️ Eliminar</button>
    </div>`;
  $('#btn-eat').addEventListener('click', () => markEaten(food.id));
  $('#btn-edit').addEventListener('click', () => openForm(food));
  $('#btn-delete').addEventListener('click', () => deleteFood(food.id));
}

async function toggleFav(id) {
  const food = foods.find((f) => f.id === id);
  if (!food) return;
  food.favorite = !food.favorite;
  await dbPutFood(food);
  renderGallery();
  if (detailId === id) renderDetail();
}

async function markEaten(id) {
  const food = foods.find((f) => f.id === id);
  if (!food) return;
  const today = new Date().toISOString();
  if (daysSinceEaten(food) === 0) { toast('Ya lo registraste hoy 😄'); return; }
  food.eatenDates = [...(food.eatenDates || []), today];
  await dbPutFood(food);
  renderGallery();
  if (detailId === id) renderDetail();
  toast('¡Buen provecho! 😋');
}

async function deleteFood(id) {
  const food = foods.find((f) => f.id === id);
  if (!food) return;
  if (!confirm(`¿Eliminar "${food.name}"? No se puede deshacer.`)) return;
  await dbDeleteFood(id);
  dropPhotoURL(id);
  foods = foods.filter((f) => f.id !== id);
  closeScreen('screen-detail');
  renderGallery();
  toast('Eliminado 🗑️');
}

// ===================== ¿Qué como hoy? =====================
function openDecide() {
  decide = { type: null, district: null };
  renderDecide();
  openScreen('screen-decide');
}

function decideCandidates() {
  if (!decide.type) return [];
  return foods.filter((f) =>
    f.type === decide.type &&
    (!decide.district || f.district === decide.district)
  );
}

function renderDecide() {
  const wrap = $('#decide-type-btns');
  wrap.innerHTML = '';
  for (const t of TYPES) {
    const b = document.createElement('button');
    b.className = 'decide-type-btn' + (decide.type === t.id ? ' on' : '');
    b.textContent = t.label;
    b.addEventListener('click', () => { decide.type = t.id; renderDecide(); });
    wrap.appendChild(b);
  }

  const usedDistricts = allDistricts().filter((d) => foods.some((f) => f.district === d));
  renderChips($('#decide-district-chips'), usedDistricts, decide.district, (v) => {
    decide.district = decide.district === v ? null : v;
    renderDecide();
  }, { allLabel: '📍 Donde sea' });

  const list = decideCandidates();
  const countEl = $('#decide-count');
  if (!decide.type) countEl.textContent = 'Elige un tipo para ver opciones 👆';
  else if (list.length === 0) countEl.textContent = 'Nada califica 😅 — prueba otro filtro';
  else countEl.textContent = `${list.length} ${list.length === 1 ? 'opción califica' : 'opciones califican'}:`;

  const grid = $('#decide-grid');
  grid.innerHTML = '';
  for (const f of list) grid.appendChild(makeCard(f, openDetail));

  $('#btn-surprise').disabled = list.length === 0;
  $('#btn-surprise').style.opacity = list.length === 0 ? 0.4 : 1;
}

// Random ponderado: más peso a lo que hace más tiempo no se come.
function pickSurprise(candidates, excludeId = null) {
  let pool = candidates.filter((f) => f.id !== excludeId);
  if (!pool.length) pool = candidates;
  const weights = pool.map((f) => {
    const d = daysSinceEaten(f);
    return d === null ? NEVER_EATEN_DAYS : Math.max(1, d);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function showSurprise(excludeId = null) {
  const candidates = decideCandidates();
  if (!candidates.length) return;
  const chosen = pickSurprise(candidates, excludeId);
  resultId = chosen.id;
  openScreen('screen-result');
  if (navigator.vibrate) navigator.vibrate(30);

  // animación de "ruleta": pasa rápido por opciones antes de aterrizar.
  // El resultado ya está renderizado; la animación termina por tiempo, así
  // no se queda colgada si el navegador limita los timers (pantalla apagada, etc.)
  const screen = $('#screen-result');
  clearInterval(rollTimer);
  screen.classList.remove('rolling');
  renderResult(chosen);
  if (candidates.length > 1 && document.visibilityState === 'visible') {
    screen.classList.add('rolling');
    const start = performance.now();
    rollTimer = setInterval(() => {
      const done = performance.now() - start >= 850;
      const random = candidates[Math.floor(Math.random() * candidates.length)];
      renderResult(done ? chosen : random);
      if (done) {
        clearInterval(rollTimer);
        screen.classList.remove('rolling');
        if (navigator.vibrate) navigator.vibrate([40, 60, 80]);
      }
    }, 110);
  }
}

function renderResult(food) {
  const url = photoURL(food);
  const days = daysSinceEaten(food);
  $('#result-body').innerHTML = `
    <div class="result-kicker">✨ Hoy te toca ✨</div>
    ${url ? `<img class="result-photo" src="${url}" alt="">` : `<div class="result-photo no-photo">🍽️</div>`}
    <div class="result-name">${escapeHTML(food.name)}</div>
    ${food.place ? `<div class="result-place">📍 ${escapeHTML(food.place)}${food.district ? ` · ${escapeHTML(food.district)}` : ''}</div>` : `<div class="result-place">📍 ${escapeHTML(food.district)}</div>`}
    ${days !== null ? `<div class="result-place">🕐 Lo comiste ${fmtAgo(days)}</div>` : `<div class="result-place">🕐 ¡Hace tiempo no lo registras!</div>`}
    ${food.notes ? `<div class="notes-box"><div class="notes-title">📝 Cómo lo pido</div>${escapeHTML(food.notes)}</div>` : ''}`;
}

// ===================== Exportar / Importar =====================
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function exportData() {
  const out = {
    app: 'que-comer',
    version: 1,
    exportedAt: new Date().toISOString(),
    customDistricts,
    foods: await Promise.all(foods.map(async (f) => ({
      ...f,
      photo: undefined,
      photoData: f.photo ? await blobToDataURL(f.photo) : null,
    }))),
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `que-comer-respaldo-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Respaldo con ${foods.length} comidas ⬇️`);
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('😖 Ese archivo no es un respaldo válido');
  }
  if (data.app !== 'que-comer' || !Array.isArray(data.foods)) {
    return toast('😖 Ese archivo no es un respaldo válido');
  }
  if (!confirm(`El respaldo tiene ${data.foods.length} comidas.\n\n⚠️ Se REEMPLAZARÁ todo lo que tienes ahora. ¿Continuar?`)) return;

  const imported = [];
  for (const f of data.foods) {
    let photo = null;
    if (f.photoData) {
      try { photo = await (await fetch(f.photoData)).blob(); } catch { photo = null; }
    }
    imported.push({
      id: f.id || crypto.randomUUID(),
      name: f.name || 'Sin nombre',
      place: f.place || '',
      notes: f.notes || '',
      type: TYPES.some((t) => t.id === f.type) ? f.type : 'almuerzo',
      district: f.district || 'Surco',
      photo,
      favorite: !!f.favorite,
      eatenDates: Array.isArray(f.eatenDates) ? f.eatenDates : [],
      createdAt: f.createdAt || new Date().toISOString(),
    });
  }

  await dbClearFoods();
  for (const f of imported) await dbPutFood(f);
  customDistricts = Array.isArray(data.customDistricts) ? data.customDistricts : [];
  await dbPutSetting('customDistricts', customDistricts);

  for (const id of photoURLs.keys()) URL.revokeObjectURL(photoURLs.get(id));
  photoURLs.clear();
  foods = imported.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  filters = { type: null, district: null, favs: false };
  closeScreen('screen-settings');
  renderGallery();
  toast(`¡Listo! ${imported.length} comidas importadas 🎉`);
}

function renderSettings() {
  const favs = foods.filter((f) => f.favorite).length;
  $('#stats-line').textContent = `${foods.length} comidas guardadas · ${favs} favoritas`;
}

// ===================== Eventos =====================
function bindEvents() {
  $('#fab').addEventListener('click', () => openForm());
  $('#btn-decide').addEventListener('click', openDecide);
  $('#btn-settings').addEventListener('click', () => { renderSettings(); openScreen('screen-settings'); });

  document.querySelectorAll('.btn-close').forEach((b) =>
    b.addEventListener('click', () => closeScreen(b.dataset.close)));

  $('#btn-camera').addEventListener('click', () => $('#input-camera').click());
  $('#btn-gallery').addEventListener('click', () => $('#input-gallery').click());
  $('#input-camera').addEventListener('change', handlePhotoInput);
  $('#input-gallery').addEventListener('change', handlePhotoInput);
  $('#btn-save').addEventListener('click', saveForm);

  $('#btn-fav-detail').addEventListener('click', () => detailId && toggleFav(detailId));

  $('#btn-surprise').addEventListener('click', () => showSurprise());
  $('#btn-result-again').addEventListener('click', () => showSurprise(resultId));
  $('#btn-result-close').addEventListener('click', () => closeScreen('screen-result'));
  $('#btn-result-eat').addEventListener('click', async () => {
    if (resultId) await markEaten(resultId);
    closeScreen('screen-result');
    closeScreen('screen-decide');
  });

  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#input-import').click());
  $('#input-import').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importData(file);
  });
}

// ===================== Init =====================
async function init() {
  const saved = await dbGetSetting('customDistricts');
  customDistricts = saved && Array.isArray(saved.value) ? saved.value : [];
  foods = ((await dbGetFoods()) || [])
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  bindEvents();
  renderGallery();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW no registrado:', e));
  }
}

init();
