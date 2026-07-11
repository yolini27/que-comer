/* ============================================================
   ¿Qué comer? — app con nube (Supabase), misma arquitectura
   que Outfit Hoy:
   - IndexedDB guarda la copia local (rápida y offline):
     foods:   { id, name, place, notes, type, district, photo(Blob|null),
                favorite, eatenDates[ISO], extras[{id,photo}],
                createdAt(ISO), updatedAt(ms), photoVer }
     pending: cambios aún no subidos { foodId, op, fotoDirty, extrasDirty }
     settings: { key: 'customDistricts'|'avatar', ... }
   - Supabase es la fuente de verdad entre dispositivos:
     tabla `comidas` + `perfiles_comida` + bucket privado `fotos-comida`.
     Gana el updated_at más nuevo (last-write-wins).
   ============================================================ */
'use strict';

// ===================== Constantes =====================
const TYPES = [
  { id: 'desayuno', label: '🍳 Desayuno' },
  { id: 'almuerzo', label: '🍽️ Almuerzo/Cena' },
  { id: 'snack',    label: '🍿 Snackito' },
];
const DEFAULT_DISTRICTS = ['Surco', 'Miraflores', 'Barranco', 'San Isidro', 'San Borja', 'Delivery'];
const NEVER_EATEN_DAYS = 45; // peso para "sorpréndeme" cuando nunca se comió
const TAM_FOTO = 800;        // fotos de comida: 800x800
const TAM_AVATAR = 400;      // foto de perfil: 400x400

// ===================== IndexedDB =====================
let _db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('que-comer', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'foodId' });
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
const dbPutSetting = (v)  => dbOp('settings', 'readwrite', (s) => s.put(v));

const dbPendingAll    = ()   => dbOp('pending', 'readonly',  (s) => s.getAll());
const dbPendingGet    = (id) => dbOp('pending', 'readonly',  (s) => s.get(id));
const dbPendingPut    = (op) => dbOp('pending', 'readwrite', (s) => s.put(op));
const dbPendingDelete = (id) => dbOp('pending', 'readwrite', (s) => s.delete(id));

async function dbClearAll() {
  await dbClearFoods();
  await dbOp('pending', 'readwrite', (s) => s.clear());
  await dbOp('settings', 'readwrite', (s) => s.clear());
}

// ===================== Estado =====================
let foods = [];              // caché en memoria
let customDistricts = [];    // distritos agregados por la usuaria
let distritosUpdatedAt = 0;  // para last-write-wins con la nube
let filters = { type: null, district: null, favs: false };
let decide = { type: null, district: null };
let editingId = null;        // id en edición, null = nueva
let formPhoto = null;        // { blob } foto pendiente del formulario
let detailId = null;         // comida abierta en detalle
let detalleFoto = 'principal'; // qué foto se ve grande en el detalle
let resultId = null;         // comida mostrada en resultado sorpresa
let rollTimer = null;
let deferredInstall = null;  // evento beforeinstallprompt

const photoURLs = new Map();  // id -> objectURL foto principal
const extraURLs = new Map();  // `${foodId}/${extraId}` -> objectURL
const $ = (sel) => document.querySelector(sel);

function allDistricts() { return [...DEFAULT_DISTRICTS, ...customDistricts]; }

// Distritos que aparecen en filtros: los que tienen comidas, en orden
// conocido; los de comidas viejas (distrito personalizado ya quitado) al final.
function distritosConComida() {
  const usados = new Set(foods.map((f) => f.district).filter(Boolean));
  const orden = allDistricts().filter((d) => usados.has(d));
  for (const d of usados) if (!orden.includes(d)) orden.push(d);
  return orden;
}

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
function extraURL(foodId, x) {
  const k = foodId + '/' + x.id;
  if (!extraURLs.has(k)) extraURLs.set(k, URL.createObjectURL(x.photo));
  return extraURLs.get(k);
}
function dropExtraURL(foodId, extraId) {
  const k = foodId + '/' + extraId;
  if (extraURLs.has(k)) { URL.revokeObjectURL(extraURLs.get(k)); extraURLs.delete(k); }
}
function dropAllExtraURLs(food) {
  for (const x of (food.extras || [])) dropExtraURL(food.id, x.id);
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

// ===================== Recorte cuadrado =====================
function cargarImagen(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = url;
  });
}

// Estado del recorte activo (null si no hay recorte en curso)
let recorte = null;

/**
 * Abre la pantalla de encuadre para `file` y resuelve con un Blob
 * cuadrado de `tam` x `tam` px (jpeg), o null si se cancela.
 */
function abrirRecorte(file, tam) {
  return new Promise(async (resolver) => {
    const url = URL.createObjectURL(file);
    try {
      await cargarImagen(url);
    } catch {
      URL.revokeObjectURL(url);
      toast('No se pudo leer la imagen 😢');
      resolver(null);
      return;
    }
    const el = $('#recorte-img');
    el.src = url;
    $('#screen-recorte').classList.add('open');
    const marco = $('#recorte-marco').getBoundingClientRect().width;
    const natW = el.naturalWidth;
    const natH = el.naturalHeight;
    const base = marco / Math.min(natW, natH); // escala mínima que cubre el cuadro
    el.style.width = natW + 'px';
    recorte = {
      el, url, natW, natH, marco, base, tam, resolver,
      escala: base,
      x: (marco - natW * base) / 2, // centrada
      y: (marco - natH * base) / 2,
    };
    $('#recorte-zoom').value = 100;
    aplicarRecorte();
  });
}

function aplicarRecorte() {
  if (!recorte) return;
  const r = recorte;
  // la imagen nunca puede dejar ver el fondo del cuadro
  r.x = Math.min(0, Math.max(r.marco - r.natW * r.escala, r.x));
  r.y = Math.min(0, Math.max(r.marco - r.natH * r.escala, r.y));
  r.el.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.escala})`;
}

async function confirmarRecorte() {
  if (!recorte) return;
  const r = recorte;
  const canvas = document.createElement('canvas');
  canvas.width = r.tam;
  canvas.height = r.tam;
  const sx = -r.x / r.escala;
  const sy = -r.y / r.escala;
  const lado = r.marco / r.escala;
  canvas.getContext('2d').drawImage(r.el, sx, sy, lado, lado, 0, 0, r.tam, r.tam);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  cerrarRecorte(blob);
}

function cerrarRecorte(blob) {
  if (!recorte) return;
  const r = recorte;
  recorte = null;
  $('#screen-recorte').classList.remove('open');
  URL.revokeObjectURL(r.url);
  r.el.removeAttribute('src');
  r.resolver(blob || null);
}

// ===================== Nube (Supabase) =====================
const nube = (typeof supabase !== 'undefined' &&
              typeof SUPABASE_URL === 'string' && SUPABASE_URL.startsWith('https'))
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Un usuario corto se guarda como correo sintético: yoli -> yoli@outfithoy.app
// MISMO dominio que Outfit Hoy: mismo proyecto = las cuentas sirven en ambas apps.
const USUARIO_DOMINIO = '@outfithoy.app';
const BUCKET = 'fotos-comida';

let sesion = null;
let sincronizando = false;
let estadoSync = 'ok'; // 'ok' | 'pendiente' | 'trabajando' (se muestra en la hoja de usuario)

const rutaFoto = (id) => `${sesion.user.id}/${id}.jpg`;
const rutaExtra = (foodId, extraId) => `${sesion.user.id}/${foodId}-${extraId}.jpg`;

// photo_ver = 0 significa "sin foto" (en que-comer la foto es opcional)
function aFila(f) {
  return {
    id: f.id,
    nombre: f.name,
    lugar: f.place || '',
    tipos: [f.type].filter(Boolean),
    distritos: [f.district].filter(Boolean),
    notas: f.notes || '',
    favorito: !!f.favorite,
    usos: f.eatenDates || [],
    extras: (f.extras || []).map((x) => x.id),
    photo_ver: f.photo ? (f.photoVer || 1) : 0,
    created_at: f.createdAt,
    updated_at: new Date(f.updatedAt || Date.parse(f.createdAt) || Date.now()).toISOString(),
  };
}

function aLocal(r, photo) {
  return {
    id: r.id,
    name: r.nombre || 'Sin nombre',
    place: r.lugar || '',
    type: (r.tipos || [])[0] || 'almuerzo',
    district: (r.distritos || [])[0] || '',
    notes: r.notas || '',
    favorite: !!r.favorito,
    eatenDates: r.usos || [],
    photo,
    extras: [], // se llenan aparte (hay que descargar cada mini foto)
    createdAt: r.created_at,
    updatedAt: Date.parse(r.updated_at) || Date.now(),
    photoVer: r.photo_ver || 0,
  };
}

// Arma la lista de extras de una fila remota, reusando blobs locales
// cuando existen y descargando solo los que faltan.
async function extrasDesdeRemoto(r, local) {
  const lista = [];
  for (const xid of (r.extras || [])) {
    const previa = local && (local.extras || []).find((x) => x.id === xid);
    if (previa) { lista.push(previa); continue; }
    const { data, error } = await nube.storage.from(BUCKET).download(rutaExtra(r.id, xid));
    if (!error && data) lista.push({ id: xid, photo: data });
  }
  return lista;
}

// Registra un cambio local para subirlo a la nube (coalesce por comida)
async function encolar(foodId, op, fotoDirty = false, extrasDirty = false, extrasBorrar = null) {
  if (!nube) return;
  const prev = await dbPendingGet(foodId);
  const nuevo = (op === 'delete')
    ? { foodId, op: 'delete', extras: extrasBorrar || [] }
    : {
        foodId,
        op: 'upsert',
        fotoDirty: fotoDirty || !!(prev && prev.op === 'upsert' && prev.fotoDirty),
        extrasDirty: extrasDirty || !!(prev && prev.op === 'upsert' && prev.extrasDirty),
      };
  await dbPendingPut(nuevo);
  sincronizar();
}

// La primera vez que esta usuaria entra en este dispositivo,
// las comidas que ya existían localmente se suben todas.
async function migrarSiPrimeraVez() {
  const marca = 'qc-migrado-' + sesion.user.id;
  if (localStorage.getItem(marca)) return;
  for (const f of foods) {
    await dbPendingPut({ foodId: f.id, op: 'upsert', fotoDirty: true, extrasDirty: true });
  }
  if (customDistricts.length && !distritosUpdatedAt) {
    distritosUpdatedAt = Date.now();
    await dbPutSetting({ key: 'customDistricts', value: customDistricts, updatedAt: distritosUpdatedAt });
  }
  localStorage.setItem(marca, '1');
}

async function empujar() {
  const ops = await dbPendingAll();
  for (const op of ops) {
    if (op.op === 'delete') {
      const { error } = await nube.from('comidas').delete().eq('id', op.foodId);
      if (error) throw error;
      const rutas = [rutaFoto(op.foodId),
        ...(op.extras || []).map((xid) => rutaExtra(op.foodId, xid))];
      await nube.storage.from(BUCKET).remove(rutas).catch(() => {});
    } else {
      const f = foods.find((x) => x.id === op.foodId);
      if (f) {
        if (op.fotoDirty && f.photo) {
          const { error: e1 } = await nube.storage.from(BUCKET)
            .upload(rutaFoto(f.id), f.photo, { upsert: true, contentType: 'image/jpeg' });
          if (e1) throw e1;
        }
        if (op.extrasDirty) {
          for (const x of (f.extras || [])) {
            const { error: e3 } = await nube.storage.from(BUCKET)
              .upload(rutaExtra(f.id, x.id), x.photo, { upsert: true, contentType: 'image/jpeg' });
            if (e3) throw e3;
          }
        }
        const { error: e2 } = await nube.from('comidas').upsert(aFila(f));
        if (e2) throw e2;
      }
    }
    await dbPendingDelete(op.foodId);
  }
}

async function descargarFoto(id) {
  const { data, error } = await nube.storage.from(BUCKET).download(rutaFoto(id));
  return error ? null : data;
}

async function jalar() {
  const { data: filas, error } = await nube.from('comidas').select('*');
  if (error) throw error;

  const pendientes = new Set((await dbPendingAll()).map((p) => p.foodId));
  const remotos = new Set(filas.map((r) => r.id));
  let cambios = false;

  for (const r of filas) {
    if (pendientes.has(r.id)) continue; // el cambio local aún no subido gana
    const local = foods.find((f) => f.id === r.id);
    if (!local) {
      let photo = null;
      if (r.photo_ver > 0) {
        photo = await descargarFoto(r.id);
        if (!photo) continue; // reintentará en la próxima sincronización
      }
      const nuevo = aLocal(r, photo);
      nuevo.extras = await extrasDesdeRemoto(r, null);
      await dbPutFood(nuevo);
      foods.push(nuevo);
      cambios = true;
    } else if (Date.parse(r.updated_at) > (local.updatedAt || 0)) {
      let photo = local.photo;
      if ((r.photo_ver || 0) !== (local.photoVer || 0)) {
        photo = r.photo_ver > 0 ? ((await descargarFoto(r.id)) || photo) : null;
        dropPhotoURL(r.id);
      }
      const nuevo = aLocal(r, photo);
      nuevo.extras = await extrasDesdeRemoto(r, local);
      for (const x of (local.extras || [])) {
        if (!nuevo.extras.find((y) => y.id === x.id)) dropExtraURL(local.id, x.id);
      }
      await dbPutFood(nuevo);
      foods[foods.indexOf(local)] = nuevo;
      cambios = true;
    }
  }

  // lo que ya no existe en la nube (borrado desde otro dispositivo) se quita local
  for (const local of [...foods]) {
    if (!remotos.has(local.id) && !pendientes.has(local.id)) {
      await dbDeleteFood(local.id);
      dropPhotoURL(local.id);
      dropAllExtraURLs(local);
      foods = foods.filter((f) => f.id !== local.id);
      if (detailId === local.id) { detailId = null; closeScreen('screen-detail'); }
      cambios = true;
    }
  }

  if (cambios) renderGallery();
}

async function sincronizar() {
  if (!nube || !sesion || sincronizando) return;
  if (!navigator.onLine) { estadoSync = 'pendiente'; return; }
  sincronizando = true;
  estadoSync = 'trabajando';
  try {
    await migrarSiPrimeraVez();
    // hasta 3 vueltas por si llegan cambios mientras se sincroniza
    for (let i = 0; i < 3; i++) {
      await empujar();
      if (!(await dbPendingAll()).length) break;
    }
    await jalar();
    await sincronizarDistritos();
    if (localStorage.getItem('qc-avatar-sube')) await subirAvatar();
    await bajarAvatar();
    estadoSync = (await dbPendingAll()).length ? 'pendiente' : 'ok';
  } catch (e) {
    console.warn('Error de sincronización', e);
    estadoSync = 'pendiente';
  } finally {
    sincronizando = false;
  }
}

// ===================== Distritos personalizados =====================
async function guardarDistritosLocal() {
  distritosUpdatedAt = Date.now();
  await dbPutSetting({ key: 'customDistricts', value: customDistricts, updatedAt: distritosUpdatedAt });
  subirDistritos(); // sin esperar: si falla, la próxima sincronización lo reintenta
}

async function subirDistritos() {
  if (!nube || !sesion) return;
  await nube.from('perfiles_comida').upsert({
    user_id: sesion.user.id,
    distritos: customDistricts,
    updated_at: new Date(distritosUpdatedAt || Date.now()).toISOString(),
  });
}

async function sincronizarDistritos() {
  const { data, error } = await nube.from('perfiles_comida').select('*').maybeSingle();
  if (error) return;
  const remotoTs = data ? (Date.parse(data.updated_at) || 0) : 0;
  if (data && remotoTs > distritosUpdatedAt) {
    customDistricts = data.distritos || [];
    distritosUpdatedAt = remotoTs;
    await dbPutSetting({ key: 'customDistricts', value: customDistricts, updatedAt: distritosUpdatedAt });
    renderGallery();
  } else if (distritosUpdatedAt > remotoTs && distritosUpdatedAt > 0) {
    await subirDistritos();
  }
}

async function promptNewDistrict() {
  const name = (prompt('Nombre del nuevo distrito o lugar:') || '').trim();
  if (!name) return null;
  if (name.length > 22) { toast('Muy largo — máximo 22 letras'); return null; }
  const existing = allDistricts().find((d) => d.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  customDistricts.push(name);
  await guardarDistritosLocal();
  return name;
}

async function quitarDistrito(nombre) {
  if (!confirm(`¿Quitar "${nombre}"? Las comidas que lo usan no se borran.`)) return;
  customDistricts = customDistricts.filter((d) => d !== nombre);
  if (filters.district === nombre) filters.district = null;
  await guardarDistritosLocal();
  renderGallery();
  renderMisDistritos();
}

function renderMisDistritos() {
  const box = $('#mis-distritos-box');
  const cont = $('#mis-distritos');
  cont.innerHTML = '';
  if (!customDistricts.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  for (const d of customDistricts) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.innerHTML = `${escapeHTML(d)} <span class="chip-x">✕</span>`;
    chip.setAttribute('aria-label', `Quitar distrito ${d}`);
    chip.addEventListener('click', () => quitarDistrito(d));
    cont.appendChild(chip);
  }
}

// ===================== Foto de perfil =====================
let avatarBlob = null;
let avatarURL = null;

function renderAvatar() {
  if (avatarURL) { URL.revokeObjectURL(avatarURL); avatarURL = null; }
  if (avatarBlob) avatarURL = URL.createObjectURL(avatarBlob);
  for (const [imgSel, defSel] of [['#avatar-img', '#avatar-default'], ['#avatar-img-mini', '#avatar-default-mini']]) {
    const img = $(imgSel);
    const def = $(defSel);
    if (avatarURL) {
      img.src = avatarURL;
      img.classList.remove('hidden');
      def.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      def.classList.remove('hidden');
    }
  }
  $('#avatar-hint').classList.toggle('hidden', !!avatarBlob);
}

async function elegirAvatar(file) {
  if (!file) return;
  const blob = await abrirRecorte(file, TAM_AVATAR);
  if (!blob) return;
  avatarBlob = blob;
  await dbPutSetting({ key: 'avatar', blob });
  renderAvatar();
  toast('Foto de perfil actualizada ✨');
  subirAvatar();
}

async function subirAvatar() {
  if (!nube || !avatarBlob) return;
  if (!sesion) { localStorage.setItem('qc-avatar-sube', '1'); return; }
  const { error } = await nube.storage.from(BUCKET)
    .upload(`${sesion.user.id}/avatar.jpg`, avatarBlob, { upsert: true, contentType: 'image/jpeg' });
  if (error) localStorage.setItem('qc-avatar-sube', '1');
  else localStorage.removeItem('qc-avatar-sube');
}

async function bajarAvatar() {
  if (avatarBlob || !nube || !sesion) return;
  let { data, error } = await nube.storage.from(BUCKET).download(`${sesion.user.id}/avatar.jpg`);
  if (error || !data) {
    // reusar la foto de perfil de Outfit Hoy (mismo usuario, bucket 'fotos')
    ({ data, error } = await nube.storage.from('fotos').download(`${sesion.user.id}/avatar.jpg`));
    if (!error && data) {
      nube.storage.from(BUCKET)
        .upload(`${sesion.user.id}/avatar.jpg`, data, { upsert: true, contentType: 'image/jpeg' })
        .catch(() => {});
    }
  }
  if (!error && data) {
    avatarBlob = data;
    await dbPutSetting({ key: 'avatar', blob: data });
    renderAvatar();
  }
}

// ===================== Cuenta =====================
function mensajeAuth(error) {
  const m = (error && error.message) || '';
  if (m.includes('Invalid login credentials')) return 'Usuario o contraseña incorrectos.';
  if (m.includes('already registered')) return 'Ese usuario ya tiene cuenta. Usa "Entrar".';
  if (m.includes('at least 6')) return 'La contraseña debe tener mínimo 6 caracteres.';
  if (m.includes('valid email') || m.includes('invalid format')) return 'Escribe un correo válido.';
  if (m.includes('Email not confirmed')) return 'Confirma tu correo primero: revisa tu bandeja de entrada.';
  return 'No se pudo: ' + m;
}

function datosLogin() {
  const usuario = $('#login-usuario').value.trim().toLowerCase();
  const pass = $('#login-pass').value;
  $('#login-error').classList.add('hidden');
  $('#login-info').classList.add('hidden');

  let email = usuario;
  if (usuario && !usuario.includes('@')) {
    if (!/^[a-z0-9._-]{3,}$/.test(usuario)) {
      $('#login-error').textContent = 'El usuario debe tener mínimo 3 caracteres y solo letras, números, punto o guion.';
      $('#login-error').classList.remove('hidden');
      return null;
    }
    email = usuario + USUARIO_DOMINIO;
  }
  if (!email || pass.length < 6) {
    $('#login-error').textContent = 'Escribe tu usuario (o correo) y una contraseña de mínimo 6 caracteres.';
    $('#login-error').classList.remove('hidden');
    return null;
  }
  return { email, password: pass };
}

async function entrar() {
  const datos = datosLogin();
  if (!datos) return;
  $('#btn-login').textContent = 'Entrando…';
  const { error } = await nube.auth.signInWithPassword(datos);
  $('#btn-login').textContent = 'Entrar';
  if (error) {
    $('#login-error').textContent = mensajeAuth(error);
    $('#login-error').classList.remove('hidden');
  }
  // si funciona, onAuthStateChange cierra la pantalla y sincroniza
}

async function crearCuenta() {
  const datos = datosLogin();
  if (!datos) return;
  $('#btn-signup').textContent = 'Creando…';
  const { data, error } = await nube.auth.signUp(datos);
  $('#btn-signup').textContent = 'Crear cuenta nueva';
  if (error) {
    $('#login-error').textContent = mensajeAuth(error);
    $('#login-error').classList.remove('hidden');
    return;
  }
  if (!data.session) {
    $('#login-info').textContent = '📬 Cuenta creada. Abre el correo que te llegó, toca el enlace de confirmación y vuelve aquí a "Entrar".';
    $('#login-info').classList.remove('hidden');
  }
}

async function cerrarSesion() {
  if (!confirm('Cerrar sesión borra la copia local de este dispositivo (lo sincronizado queda en la nube). ¿Continuar?')) return;
  const pendientes = (await dbPendingAll()).length;
  if (pendientes && !confirm(`Hay ${pendientes} cambio(s) sin subir que se perderían. ¿Cerrar sesión igual?`)) return;
  await nube.auth.signOut();
  await dbClearAll();
  localStorage.removeItem('qc-avatar-sube');
  location.reload();
}

async function initAuth() {
  if (!nube) { estadoSync = 'ok'; return; } // modo local, sin nube
  const { data } = await nube.auth.getSession();
  sesion = data.session;

  nube.auth.onAuthStateChange((evento, s) => {
    sesion = s;
    if (evento === 'SIGNED_IN' && s) {
      closeScreen('screen-login');
      $('#btn-logout').classList.remove('hidden');
      sincronizar();
    }
    if (evento === 'SIGNED_OUT') {
      openScreen('screen-login');
      $('#btn-logout').classList.add('hidden');
    }
  });

  if (sesion) {
    $('#btn-logout').classList.remove('hidden');
    sincronizar();
  } else {
    openScreen('screen-login');
  }
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

// ===================== Galería =====================
function visibleFoods() {
  return foods
    .filter((f) =>
      (!filters.type || f.type === filters.type) &&
      (!filters.district || f.district === filters.district) &&
      (!filters.favs || f.favorite))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function makeCard(food, onTap) {
  const card = document.createElement('div');
  card.className = 'card';
  const url = photoURL(food);
  const days = daysSinceEaten(food);
  card.innerHTML = `
    ${url ? `<img src="${url}" alt="" loading="lazy">` : `<div class="no-photo">🍽️</div>`}
    ${days !== null ? `<span class="badge-ago">${fmtAgo(days)}</span>` : ''}
    ${food.favorite ? `<span class="badge-fav">♡</span>` : ''}
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

  // chip de favoritos al final de la fila de tipos (corazón silueta)
  const favChip = document.createElement('button');
  favChip.className = 'chip chip-corazon' + (filters.favs ? ' on' : '');
  favChip.textContent = '♡';
  favChip.title = 'Favoritos';
  favChip.setAttribute('aria-label', 'Favoritos');
  favChip.addEventListener('click', () => { filters.favs = !filters.favs; renderGallery(); });
  $('#filter-type-chips').appendChild(favChip);

  renderChips($('#filter-district-chips'), distritosConComida(), filters.district, (v) => {
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
const formState = { type: null, district: null };

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
  $('#screen-form .screen-body').scrollTop = 0;
}

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
  const blob = await abrirRecorte(file, TAM_FOTO);
  if (!blob) return; // canceló el encuadre
  formPhoto = { blob };
  updateFormPhotoPreview();
}

async function saveForm() {
  const name = $('#f-name').value.trim();
  if (!formState.type) return toast('Elige el tipo 🍳');
  if (!formState.district) return toast('Elige el distrito 📍');
  if (!name) return toast('Ponle nombre al plato ✍️');

  const existing = editingId ? foods.find((f) => f.id === editingId) : null;
  const newPhoto = formPhoto ? formPhoto.blob : null;
  const fotoCambio = existing ? newPhoto !== existing.photo : !!newPhoto;
  const food = {
    id: editingId || crypto.randomUUID(),
    name,
    place: $('#f-place').value.trim(),
    notes: $('#f-notes').value.trim(),
    type: formState.type,
    district: formState.district,
    photo: newPhoto,
    favorite: existing ? existing.favorite : false,
    eatenDates: existing ? existing.eatenDates : [],
    extras: existing ? (existing.extras || []) : [],
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: Date.now(),
    photoVer: existing ? (existing.photoVer || 0) + (fotoCambio ? 1 : 0) : (newPhoto ? 1 : 0),
  };
  await dbPutFood(food);
  dropPhotoURL(food.id);
  const idx = foods.findIndex((f) => f.id === food.id);
  if (idx >= 0) foods[idx] = food; else foods.unshift(food);
  // pedir persistencia al guardar la primera (evita que el navegador borre datos)
  if (!existing && navigator.storage && navigator.storage.persist) navigator.storage.persist();
  closeScreen('screen-form');
  renderGallery();
  if (detailId === food.id) renderDetail();
  toast(existing ? 'Guardado ✨' : '¡Agregado! 🎉');
  encolar(food.id, 'upsert', fotoCambio);
}

// ===================== Detalle =====================
function openDetail(food) {
  detailId = food.id;
  detalleFoto = 'principal';
  renderDetail();
  openScreen('screen-detail');
  $('#screen-detail .screen-body').scrollTop = 0;
}

function fotoGrandeDetalle(food) {
  if (detalleFoto !== 'principal') {
    const x = (food.extras || []).find((y) => y.id === detalleFoto);
    if (x) return extraURL(food.id, x);
    detalleFoto = 'principal';
  }
  return photoURL(food);
}

function renderDetail() {
  const food = foods.find((f) => f.id === detailId);
  if (!food) { closeScreen('screen-detail'); return; }
  const url = fotoGrandeDetalle(food);
  const days = daysSinceEaten(food);
  const fav = $('#btn-fav-detail');
  fav.textContent = food.favorite ? '♥' : '♡';
  fav.classList.toggle('on', food.favorite);
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
    <div class="extras-box">
      <div class="notes-title">📸 Food check <span class="extras-sub">(el mismo plato, otros días)</span></div>
      <div id="detail-extras" class="extras-row"></div>
    </div>
    <button class="btn primary big" id="btn-eat">✓ ¡Lo comí hoy!</button>
    <div class="row-2">
      <button class="btn secondary" id="btn-edit">✏️ Editar</button>
      <button class="btn danger" id="btn-delete">🗑️ Eliminar</button>
    </div>`;
  renderExtras(food);
  $('#btn-eat').addEventListener('click', () => markEaten(food.id));
  $('#btn-edit').addEventListener('click', () => openForm(food));
  $('#btn-delete').addEventListener('click', () => deleteFood(food.id));
}

// ===================== Food check (mini fotos) =====================
function renderExtras(food) {
  const cont = $('#detail-extras');
  cont.innerHTML = '';
  const thumbs = [{ id: 'principal', photo: food.photo }, ...(food.extras || [])];
  for (const x of thumbs) {
    const b = document.createElement('button');
    b.className = 'extra-thumb';
    b.type = 'button';
    b.setAttribute('aria-current', String(detalleFoto === x.id));
    if (x.id === 'principal' && !food.photo) {
      b.classList.add('extra-vacia');
      b.textContent = '🍽️';
    } else {
      const img = document.createElement('img');
      img.src = x.id === 'principal' ? photoURL(food) : extraURL(food.id, x);
      img.alt = 'Food check';
      b.appendChild(img);
    }
    b.addEventListener('click', () => {
      detalleFoto = x.id;
      renderDetail();
    });
    if (x.id !== 'principal') {
      const del = document.createElement('span');
      del.className = 'extra-x';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Quitar esta foto');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('¿Quitar esta foto?')) return;
        food.extras = food.extras.filter((y) => y.id !== x.id);
        food.updatedAt = Date.now();
        await dbPutFood(food);
        dropExtraURL(food.id, x.id);
        if (nube && sesion) {
          nube.storage.from(BUCKET).remove([rutaExtra(food.id, x.id)]).catch(() => {});
        }
        if (detalleFoto === x.id) detalleFoto = 'principal';
        renderDetail();
        encolar(food.id, 'upsert');
      });
      b.appendChild(del);
    }
    cont.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'extra-add';
  add.type = 'button';
  add.textContent = '＋';
  add.setAttribute('aria-label', 'Agregar food check');
  add.addEventListener('click', () => $('#input-extra').click());
  cont.appendChild(add);
}

async function agregarExtra(file) {
  const food = foods.find((f) => f.id === detailId);
  if (!food || !file) return;
  const blob = await abrirRecorte(file, TAM_FOTO);
  if (!blob) return;
  const x = { id: crypto.randomUUID(), photo: blob };
  food.extras = food.extras || [];
  food.extras.push(x);
  food.updatedAt = Date.now();
  await dbPutFood(food);
  detalleFoto = x.id;
  renderDetail();
  toast('Food check agregado 📸');
  encolar(food.id, 'upsert', false, true);
}

// ===================== Acciones de comida =====================
async function toggleFav(id) {
  const food = foods.find((f) => f.id === id);
  if (!food) return;
  food.favorite = !food.favorite;
  food.updatedAt = Date.now();
  await dbPutFood(food);
  renderGallery();
  if (detailId === id) renderDetail();
  encolar(food.id, 'upsert');
}

async function markEaten(id) {
  const food = foods.find((f) => f.id === id);
  if (!food) return;
  if (daysSinceEaten(food) === 0) { toast('Ya lo registraste hoy 😄'); return; }
  food.eatenDates = [...(food.eatenDates || []), new Date().toISOString()];
  food.updatedAt = Date.now();
  await dbPutFood(food);
  renderGallery();
  if (detailId === id) renderDetail();
  toast('¡Buen provecho! 😋');
  encolar(food.id, 'upsert');
}

async function deleteFood(id) {
  const food = foods.find((f) => f.id === id);
  if (!food) return;
  if (!confirm(`¿Eliminar "${food.name}"? No se puede deshacer.`)) return;
  const extrasIds = (food.extras || []).map((x) => x.id);
  await dbDeleteFood(id);
  dropPhotoURL(id);
  dropAllExtraURLs(food);
  foods = foods.filter((f) => f.id !== id);
  closeScreen('screen-detail');
  renderGallery();
  toast('Eliminado 🗑️');
  encolar(id, 'delete', false, false, extrasIds);
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

  renderChips($('#decide-district-chips'), distritosConComida(), decide.district, (v) => {
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
    version: 2,
    exportedAt: new Date().toISOString(),
    customDistricts,
    foods: await Promise.all(foods.map(async (f) => ({
      ...f,
      photo: undefined,
      extras: undefined,
      photoData: f.photo ? await blobToDataURL(f.photo) : null,
      extrasData: await Promise.all((f.extras || []).map(async (x) => ({
        id: x.id,
        photoData: await blobToDataURL(x.photo),
      }))),
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
  const aviso = (nube && sesion)
    ? `El respaldo tiene ${data.foods.length} comidas.\n\n⚠️ Reemplaza lo local y se sube a la nube (lo que ya está en la nube se combina). ¿Continuar?`
    : `El respaldo tiene ${data.foods.length} comidas.\n\n⚠️ Se REEMPLAZARÁ todo lo que tienes ahora. ¿Continuar?`;
  if (!confirm(aviso)) return;

  const dataURLaBlob = async (d) => { try { return await (await fetch(d)).blob(); } catch { return null; } };
  const imported = [];
  for (const f of data.foods) {
    const photo = f.photoData ? await dataURLaBlob(f.photoData) : null;
    const extras = [];
    for (const x of (f.extrasData || [])) {
      const b = x.photoData ? await dataURLaBlob(x.photoData) : null;
      if (b) extras.push({ id: x.id || crypto.randomUUID(), photo: b });
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
      extras,
      createdAt: f.createdAt || new Date().toISOString(),
      updatedAt: Date.now(), // el respaldo recién importado gana en la nube
      photoVer: photo ? Math.max(1, f.photoVer || 1) : 0,
    });
  }

  await dbClearFoods();
  await dbOp('pending', 'readwrite', (s) => s.clear());
  for (const f of imported) await dbPutFood(f);
  customDistricts = Array.isArray(data.customDistricts) ? data.customDistricts : [];
  distritosUpdatedAt = Date.now();
  await dbPutSetting({ key: 'customDistricts', value: customDistricts, updatedAt: distritosUpdatedAt });

  for (const id of photoURLs.keys()) URL.revokeObjectURL(photoURLs.get(id));
  photoURLs.clear();
  for (const k of extraURLs.keys()) URL.revokeObjectURL(extraURLs.get(k));
  extraURLs.clear();
  foods = imported;
  filters = { type: null, district: null, favs: false };
  for (const f of foods) {
    await dbPendingPut({ foodId: f.id, op: 'upsert', fotoDirty: true, extrasDirty: true });
  }
  cerrarSheet();
  renderGallery();
  toast(`¡Listo! ${imported.length} comidas importadas 🎉`);
  sincronizar();
}

// ===================== Hoja de usuario =====================
async function abrirUsuario() {
  renderAvatar();
  renderMisDistritos();
  $('#user-count').textContent = foods.length === 1
    ? 'Tienes 1 comida guardada.'
    : `Tienes ${foods.length} comidas guardadas.`;

  const titulo = $('#user-title');
  if (!nube) {
    titulo.textContent = 'Mis comidas';
    $('#user-email').textContent = 'Modo local: sin nube configurada (ver config.js).';
    $('#sync-info').textContent = 'Tus comidas viven solo en este dispositivo.';
  } else if (sesion) {
    const correo = sesion.user.email || '';
    titulo.textContent = correo.endsWith(USUARIO_DOMINIO)
      ? correo.slice(0, -USUARIO_DOMINIO.length)
      : correo;
    $('#user-email').textContent = '';
    const pendientes = (await dbPendingAll()).length;
    $('#sync-info').textContent = pendientes
      ? `⏳ ${pendientes} cambio(s) esperando subir a la nube.`
      : (estadoSync === 'trabajando' ? '🔄 Sincronizando…' : '☁️ Todo sincronizado con la nube.');
  } else {
    titulo.textContent = 'Mis comidas';
    $('#user-email').textContent = 'Sin sesión iniciada.';
    $('#sync-info').textContent = '';
  }
  $('#sheet-user').classList.remove('hidden');
}

function cerrarSheet() { $('#sheet-user').classList.add('hidden'); }

// ===================== Actualizar (pull to refresh) =====================
async function refrescar() {
  $('#ptr').classList.remove('hidden');
  try { await sincronizar(); } catch { /* sin conexión: no pasa nada */ }
  renderGallery();
  setTimeout(() => $('#ptr').classList.add('hidden'), 700);
}

// ===================== Eventos =====================
function bindEvents() {
  $('#fab').addEventListener('click', () => openForm());
  $('#btn-decide').addEventListener('click', openDecide);
  $('#btn-user').addEventListener('click', abrirUsuario);

  document.querySelectorAll('.btn-close').forEach((b) =>
    b.addEventListener('click', () => closeScreen(b.dataset.close)));

  // Formulario
  $('#btn-camera').addEventListener('click', () => $('#input-camera').click());
  $('#btn-gallery').addEventListener('click', () => $('#input-gallery').click());
  $('#input-camera').addEventListener('change', handlePhotoInput);
  $('#input-gallery').addEventListener('change', handlePhotoInput);
  $('#btn-save').addEventListener('click', saveForm);

  // Recorte cuadrado
  $('#btn-recorte-ok').addEventListener('click', confirmarRecorte);
  $('#btn-recorte-cancelar').addEventListener('click', () => cerrarRecorte(null));
  $('#recorte-zoom').addEventListener('input', (e) => {
    if (!recorte) return;
    const r = recorte;
    const nueva = r.base * (Number(e.target.value) / 100);
    // acercar/alejar manteniendo el centro del cuadro
    const cx = (r.marco / 2 - r.x) / r.escala;
    const cy = (r.marco / 2 - r.y) / r.escala;
    r.escala = nueva;
    r.x = r.marco / 2 - cx * nueva;
    r.y = r.marco / 2 - cy * nueva;
    aplicarRecorte();
  });
  const marco = $('#recorte-marco');
  let arrastre = null;
  marco.addEventListener('pointerdown', (e) => {
    if (!recorte) return;
    marco.setPointerCapture(e.pointerId);
    arrastre = { x: e.clientX, y: e.clientY };
  });
  marco.addEventListener('pointermove', (e) => {
    if (!recorte || !arrastre) return;
    recorte.x += e.clientX - arrastre.x;
    recorte.y += e.clientY - arrastre.y;
    arrastre = { x: e.clientX, y: e.clientY };
    aplicarRecorte();
  });
  marco.addEventListener('pointerup', () => { arrastre = null; });
  marco.addEventListener('pointercancel', () => { arrastre = null; });

  // Detalle
  $('#btn-fav-detail').addEventListener('click', () => detailId && toggleFav(detailId));
  $('#input-extra').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) agregarExtra(file);
  });

  // ¿Qué como hoy?
  $('#btn-surprise').addEventListener('click', () => showSurprise());
  $('#btn-result-again').addEventListener('click', () => showSurprise(resultId));
  $('#btn-result-close').addEventListener('click', () => closeScreen('screen-result'));
  $('#btn-result-eat').addEventListener('click', async () => {
    if (resultId) await markEaten(resultId);
    closeScreen('screen-result');
    closeScreen('screen-decide');
  });

  // Hoja de usuario
  $('#sheet-user').addEventListener('click', (e) => {
    if (e.target === $('#sheet-user')) cerrarSheet();
  });
  $('#btn-sheet-close').addEventListener('click', cerrarSheet);
  $('#btn-avatar').addEventListener('click', () => $('#input-avatar').click());
  $('#input-avatar').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) elegirAvatar(file);
  });
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#input-import').click());
  $('#input-import').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importData(file);
  });

  // Cuenta
  if (nube) {
    $('#btn-login').addEventListener('click', entrar);
    $('#btn-signup').addEventListener('click', crearCuenta);
    $('#btn-logout').addEventListener('click', cerrarSesion);
    $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
  }

  // Reintentar sincronización al volver la conexión o al volver a la app
  window.addEventListener('online', sincronizar);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sincronizar();
  });

  // Actualizar jalando hacia abajo en la galería
  let ptrY = null;
  let ptrHecho = false;
  const tapado = () =>
    !!document.querySelector('.screen.open') || !$('#sheet-user').classList.contains('hidden');
  window.addEventListener('touchstart', (e) => {
    ptrY = (!tapado() && window.scrollY <= 0) ? e.touches[0].clientY : null;
    ptrHecho = false;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (ptrY === null || ptrHecho) return;
    if (e.touches[0].clientY - ptrY > 75) {
      ptrHecho = true;
      refrescar();
    }
  }, { passive: true });
  window.addEventListener('touchend', () => { ptrY = null; });

  // Instalación PWA (Android/Chrome)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#btn-install').classList.remove('hidden');
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('#btn-install').classList.add('hidden');
  });
}

// ===================== Init =====================
async function init() {
  bindEvents();

  const regDistritos = await dbGetSetting('customDistricts');
  if (regDistritos) {
    customDistricts = Array.isArray(regDistritos.value) ? regDistritos.value : [];
    distritosUpdatedAt = regDistritos.updatedAt || 0;
  }
  try {
    const regAvatar = await dbGetSetting('avatar');
    avatarBlob = regAvatar ? regAvatar.blob : null;
  } catch { avatarBlob = null; }
  renderAvatar();

  try {
    foods = (await dbGetFoods()) || [];
  } catch (e) {
    console.error('Error abriendo IndexedDB', e);
    toast('No se pudo abrir el almacenamiento 😢');
    foods = [];
  }

  // comidas guardadas antes de la nube: completar campos nuevos
  for (const f of foods) {
    let dirty = false;
    if (!f.updatedAt) { f.updatedAt = Date.parse(f.createdAt) || Date.now(); dirty = true; }
    if (f.photoVer === undefined) { f.photoVer = f.photo ? 1 : 0; dirty = true; }
    if (!f.extras) { f.extras = []; dirty = true; }
    if (dirty) await dbPutFood(f);
  }

  renderGallery();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW no registrado:', e));
  }

  await initAuth();
}

init();
