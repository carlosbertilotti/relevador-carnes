// Sincronización entre dispositivos (Mac, iPad, celular) usando Supabase.
// Las tablas están cerradas: sólo se accede con funciones que exigen la clave
// de Cuaderno (la misma que pide el servidor la primera vez).
//
// - Subir: todo lo que cambió localmente desde la última subida (_mod) y lo borrado.
// - Bajar: lo que cambió en el servidor desde el último número de secuencia visto.
// - Gana el cambio más reciente.
// - Archivos propios (grabaciones, fotos, diapositivas, PDFs importados) se suben
//   en partes; el material del campus no: cada dispositivo lo baja del campus.
import * as db from './db.js';
import { emit, mergeDuplicateNotebooks } from './store.js';

const SUPABASE_URL = 'https://qickqhaxbbnbcyhpyljm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpY2txaGF4YmJuYmN5aHB5bGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyMTg5NzMsImV4cCI6MjA5Mzc5NDk3M30.GZ06fdh9QFt5UeZnCbu_7ardjDamRb2l402zqMBXzVA';
const MAX_BATCH = 1_500_000; // bytes de JSON por pedido
const PART = 700_000; // caracteres base64 por parte de archivo
const LOCAL_FILE_FIELDS = ['downloaded', 'downloadedAt', 'downloadError'];

export const state = { running: false, lastOk: null, error: null };
const setState = (patch) => { Object.assign(state, patch); emit('sync', { ...state }); };

export async function rpc(fn, args) {
  let res;
  const base = (await db.getSetting('syncUrlOverride', null)) || SUPABASE_URL; // sólo para pruebas
  try {
    res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('Sin conexión para sincronizar');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.message || `Error de sincronización (${res.status})`);
    e.code = err.code === '28000' ? 'appkey' : err.code;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

async function key() {
  const k = await db.getSetting('appKey', '');
  if (k) return k;
  const { prompt } = await import('./ui.js');
  const v = await prompt('Clave de Cuaderno', { placeholder: 'La misma clave que te pidió al conectar el campus', ok: 'Sincronizar' });
  if (!v) throw Object.assign(new Error('Falta la clave de Cuaderno para sincronizar'), { code: 'appkey' });
  await db.setSetting('appKey', v);
  return v;
}

const cursor = async () => (await db.getSetting('syncCursor', null)) || { pushed: 0, pulled: 0 };
const saveCursor = (c) => db.setSetting('syncCursor', c);

function forUpload(store, value) {
  const data = { ...value };
  delete data._mod;
  if (store === 'files') for (const f of LOCAL_FILE_FIELDS) delete data[f];
  return data;
}

// Lo que se guardó antes de que existiera la sincronización no tiene _mod:
// se le pone su fecha real (así el más reciente sigue ganando) y se vuelve a
// subir todo una vez. La fecha real puede ser anterior a lo último subido, así
// que sin volver el cursor a 0 esas cosas (por ejemplo, la conexión del campus
// y su calendario) nunca llegaban a los otros dispositivos.
async function stampLegacy() {
  if (await db.getSetting('syncLegacyStamped2', false)) return;
  for (const store of db.SYNC_STORES) {
    for (const v of await db.all(store)) {
      if (v._mod) continue;
      await db.put(store, { ...v, _mod: v.updatedAt || v.syncedAt || v.addedAt || v.createdAt || 1 }, { remote: true });
    }
  }
  for (const row of await db.all('kv')) {
    if (!db.SYNC_KV.includes(row.key) || row._mod || row.value == null) continue;
    const v = row.value;
    await db.put('kv', { ...row, _mod: (v && (v.lastSync || v.connectedAt)) || 1 }, { remote: true });
  }
  await saveCursor({ ...(await cursor()), pushed: 0 });
  await db.setSetting('syncLegacyStamped2', true);
}

// ---------- Subir ----------
async function push(k) {
  await stampLegacy();
  const c = await cursor();
  const docs = [];
  for (const store of db.SYNC_STORES) {
    for (const v of await db.all(store)) {
      if ((v._mod || 0) > c.pushed) docs.push({ store, id: v.id, data: forUpload(store, v), mod: v._mod });
    }
  }
  for (const row of await db.all('kv')) {
    if (db.SYNC_KV.includes(row.key) && (row._mod || 0) > c.pushed) docs.push({ store: 'kv', id: row.key, data: { value: row.value }, mod: row._mod });
  }
  const tomb = (await db.getSetting('syncTombstones', [])) || [];
  for (const t of tomb) docs.push({ store: t.store, id: t.id, data: null, mod: t.mod, deleted: true });
  if (!docs.length) return 0;

  docs.sort((a, b) => a.mod - b.mod);
  let batch = [];
  let size = 0;
  let maxMod = c.pushed;
  const flush = async () => {
    if (!batch.length) return;
    await rpc('cuaderno_push', { k, docs: batch });
    maxMod = Math.max(maxMod, ...batch.map((d) => d.mod));
    await saveCursor({ ...(await cursor()), pushed: maxMod });
    batch = [];
    size = 0;
  };
  for (const d of docs) {
    const s = JSON.stringify(d).length;
    if (size + s > MAX_BATCH) await flush();
    batch.push(d);
    size += s;
  }
  await flush();
  if (tomb.length) {
    const left = ((await db.getSetting('syncTombstones', [])) || []).filter((t) => t.mod > maxMod);
    await db.setSetting('syncTombstones', left);
  }
  return docs.length;
}

// ---------- Bajar ----------
async function pull(k) {
  let c = await cursor();
  let applied = 0;
  for (;;) {
    const rows = await rpc('cuaderno_pull', { k, since: c.pulled, lim: 200 });
    if (!rows?.length) break;
    for (const r of rows) {
      if (await applyRemote(r)) applied++;
      c.pulled = Math.max(c.pulled, r.seq);
    }
    await saveCursor({ ...(await cursor()), pulled: c.pulled });
    c = await cursor();
    if (rows.length < 200) break;
  }
  if (applied) {
    await mergeDuplicateNotebooks();
    emit('change', { type: 'sync', remote: true });
  }
  return applied;
}

async function applyRemote(r) {
  if (r.store === 'kv') {
    const local = await db.get('kv', r.id);
    if (local && (local._mod || 0) >= r.mod) return false;
    if (r.deleted) await db.del('kv', r.id, { remote: true });
    else await db.put('kv', { key: r.id, value: r.data?.value, _mod: r.mod }, { remote: true });
    return true;
  }
  if (!db.SYNC_STORES.includes(r.store)) return false;
  const local = await db.get(r.store, r.id);
  if (local && (local._mod || 0) >= r.mod) return false;
  if (r.deleted) {
    if (local) await db.del(r.store, r.id, { remote: true });
    return !!local;
  }
  const value = { ...r.data, _mod: r.mod };
  if (r.store === 'files' && local) for (const f of LOCAL_FILE_FIELDS) if (local[f] !== undefined) value[f] = local[f];
  if (r.store === 'files' && r.data?.local) value.downloaded = false; // se baja de la nube abajo
  await db.put(r.store, value, { remote: true });
  emit('change', { type: r.store === 'notes' ? 'note' : r.store.replace(/s$/, ''), id: r.id, remote: true, silent: r.store === 'notes' });
  return true;
}

// ---------- Archivos propios ----------
async function referencedBlobs() {
  const ids = new Set();
  for (const n of await db.all('notes')) {
    for (const rec of n.recordings || []) ids.add(rec.blobId);
    for (const b of n.blocks || []) {
      if (b.image?.blobId) ids.add(b.image.blobId);
      for (const ph of b.photos || []) ids.add(ph.blobId);
      // PDFs del campus que se usan en una nota: se sincronizan para que la nota
      // se vea completa en cualquier dispositivo, aunque ahí no esté conectado el campus.
      if (b.pdf?.fileId) ids.add(`file:${b.pdf.fileId}`);
    }
  }
  for (const f of await db.all('files')) if (f.local) ids.add(`file:${f.id}`);
  return [...ids];
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function syncBlobs(k) {
  const ids = await referencedBlobs();
  if (!ids.length) return;
  const uploaded = new Set((await db.getSetting('syncUploadedBlobs', [])) || []);
  const remote = new Set((await rpc('cuaderno_blob_have', { k, ids })) || []);

  // Subir los que están acá y no allá.
  for (const id of ids) {
    if (remote.has(id)) { uploaded.add(id); continue; }
    const row = await db.get('blobs', id);
    if (!row?.blob) continue;
    const b64 = await blobToB64(row.blob);
    const total = Math.max(1, Math.ceil(b64.length / PART));
    for (let p = 0; p < total; p++) {
      await rpc('cuaderno_blob_put', { k, p_id: id, p_part: p, p_total: total, p_mime: row.blob.type || 'application/octet-stream', p_data: b64.slice(p * PART, (p + 1) * PART) });
    }
    uploaded.add(id);
    remote.add(id);
  }
  await db.setSetting('syncUploadedBlobs', [...uploaded]);

  // Bajar los que están allá y no acá.
  for (const id of ids) {
    if (!remote.has(id) || (await db.get('blobs', id))) continue;
    const first = (await rpc('cuaderno_blob_get', { k, p_id: id, p_part: 0 }))?.[0];
    if (!first) continue;
    let b64 = first.o_data;
    for (let p = 1; p < first.o_total; p++) b64 += (await rpc('cuaderno_blob_get', { k, p_id: id, p_part: p }))?.[0]?.o_data || '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await db.put('blobs', { id, blob: new Blob([bytes], { type: first.o_mime || '' }) });
    if (id.startsWith('file:')) {
      const f = await db.get('files', id.slice(5));
      if (f) await db.put('files', { ...f, downloaded: true }, { remote: true });
    }
    emit('change', { type: 'blob', id, remote: true, silent: true });
  }
}

// ---------- Orquestación ----------
let running = null;
let again = false;

export function syncNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    if (!(await db.getSetting('syncEnabled', true))) return null;
    if (!navigator.onLine) throw new Error('Sin conexión');
    setState({ running: true, error: null });
    const k = await key();
    const pushed = await push(k);
    const pulled = await pull(k);
    await syncBlobs(k);
    return { pushed, pulled };
  })()
    .then((r) => { setState({ running: false, lastOk: Date.now(), error: null }); return r; })
    .catch((err) => {
      setState({ running: false, error: err.code === 'appkey' ? 'Clave de Cuaderno incorrecta' : err.message });
      if (err.code === 'appkey') db.setSetting('appKey', '');
      throw err;
    })
    .finally(() => {
      running = null;
      if (again) { again = false; setTimeout(() => syncNow().catch(() => {}), 500); }
    });
  return running;
}

let timer;
export function schedule(ms = 4000) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), ms);
}

// Arranca la sincronización automática: al abrir, al volver a la app, al
// recuperar la conexión, cada 2 minutos y unos segundos después de cada cambio.
export function start(bus) {
  syncNow().catch(() => {});
  bus.addEventListener('change', (e) => { if (!e.detail?.remote) schedule(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(300); else syncNow().catch(() => {}); });
  window.addEventListener('online', () => schedule(500));
  setInterval(() => { if (!document.hidden) syncNow().catch(() => {}); }, 120_000);
}
