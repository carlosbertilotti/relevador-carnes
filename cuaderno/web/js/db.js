// Almacenamiento local (IndexedDB). Todo vive en el dispositivo: la app
// funciona sin conexión y el campus sólo se consulta al sincronizar.
const DB_NAME = 'cuaderno';
const VERSION = 1;
const STORES = {
  notebooks: { keyPath: 'id', indexes: { courseId: 'courseId' } },
  notes: { keyPath: 'id', indexes: { notebookId: 'notebookId', updatedAt: 'updatedAt' } },
  files: { keyPath: 'id', indexes: { courseId: 'courseId', url: 'url' } },
  blobs: { keyPath: 'id' },
  kv: { keyPath: 'key' },
};

let dbPromise;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idx, path] of Object.entries(def.indexes || {})) store.createIndex(idx, path);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const result = await fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

export const get = (store, id) => tx(store, 'readonly', (s) => wrap(s.get(id)));
export const all = (store) => tx(store, 'readonly', (s) => wrap(s.getAll()));
export const byIndex = (store, index, value) => tx(store, 'readonly', (s) => wrap(s.index(index).getAll(value)));
// ---- Qué se sincroniza entre dispositivos (ver sync.js) ----
// Cada cambio local lleva _mod (milisegundos) para saber qué subir y quién gana.
export const SYNC_STORES = ['notebooks', 'notes', 'files'];
export const SYNC_KV = ['campus', 'icsCalendars', 'campusEvents', 'hiddenCourses', 'defaultMode', 'defaultPaper'];
export const isSynced = (store, value) =>
  SYNC_STORES.includes(store) || (store === 'kv' && SYNC_KV.includes(value?.key ?? value));

function stamp(store, value, remote) {
  if (!remote && isSynced(store, value)) value._mod = Math.max(Date.now(), (value._mod || 0) + 1);
  return value;
}

// opts.remote: el cambio viene de otro dispositivo (no se vuelve a subir).
export const put = (store, value, opts = {}) => tx(store, 'readwrite', (s) => wrap(s.put(stamp(store, value, opts.remote))));
export const putMany = (store, values, opts = {}) =>
  tx(store, 'readwrite', (s) => Promise.all(values.map((v) => wrap(s.put(stamp(store, v, opts.remote))))));
export async function del(store, id, opts = {}) {
  await tx(store, 'readwrite', (s) => wrap(s.delete(id)));
  if (!opts.remote && isSynced(store, id)) {
    const tomb = (await get('kv', 'syncTombstones'))?.value || [];
    tomb.push({ store, id, mod: Date.now() });
    await tx('kv', 'readwrite', (s) => wrap(s.put({ key: 'syncTombstones', value: tomb })));
  }
}
export const clear = (store) => tx(store, 'readwrite', (s) => wrap(s.clear()));

export async function getSetting(key, fallback = null) {
  const row = await get('kv', key);
  return row ? row.value : fallback;
}
export const setSetting = (key, value) => put('kv', { key, value });

export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36);
}

// Copia de seguridad completa (incluye PDFs, audios e imágenes).
export async function exportAll() {
  const out = { app: 'cuaderno', version: VERSION, exportedAt: Date.now(), stores: {} };
  for (const name of Object.keys(STORES)) {
    const rows = await all(name);
    out.stores[name] = await Promise.all(rows.map(async (r) => {
      if (r.blob instanceof Blob) {
        return { ...r, blob: { __blob: true, type: r.blob.type, data: await blobToBase64(r.blob) } };
      }
      return r;
    }));
  }
  return new Blob([JSON.stringify(out)], { type: 'application/json' });
}

export async function importAll(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'cuaderno') throw new Error('El archivo no es una copia de Cuaderno');
  for (const [name, rows] of Object.entries(data.stores)) {
    if (!STORES[name]) continue;
    await putMany(name, rows.map((r) => (r.blob && r.blob.__blob ? { ...r, blob: base64ToBlob(r.blob.data, r.blob.type) } : r)));
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
