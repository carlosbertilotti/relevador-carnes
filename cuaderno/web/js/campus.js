// Sincronización con el Campus Virtual Di Tella (Moodle) a través del
// servidor de Cuaderno. Cada materia del campus se convierte en un cuaderno y
// su material (PDFs, presentaciones, etc.) se descarga al dispositivo.
import * as db from './db.js';
import { createNotebook, saveNotebook, emit, normalize } from './store.js';

export const DEFAULT_URL = 'https://campus.utdt.edu';
const AUTO_SYNC_MS = 60 * 60 * 1000;
const MAX_FILE = 40 * 1024 * 1024;

export const api = {
  async post(path, body, { raw = false } = {}) {
    const key = await db.getSetting('appKey', '');
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Cuaderno-Key': key } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Sin conexión con el servidor de Cuaderno');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.error || `Error ${res.status}`);
      e.code = err.code;
      e.status = res.status;
      throw e;
    }
    return raw ? res.blob() : res.json();
  },
};

export async function account() {
  return db.getSetting('campus', null);
}

export async function login({ url, username, password, token }) {
  url = (url || DEFAULT_URL).replace(/\/+$/, '');
  let site;
  if (token) {
    // Clave de seguridad copiada del campus (sirve para quien entra con Google/Microsoft).
    const snap = await api.post('/api/campus/sync', { url, token, daysAhead: 1 });
    site = snap.site;
  } else {
    const out = await api.post('/api/campus/login', { url, username, password });
    token = out.token;
    site = out.site;
  }
  const acc = { url, token, site, connectedAt: Date.now(), lastSync: null };
  await db.setSetting('campus', acc);
  emit('change', { type: 'campus' });
  return acc;
}

export async function logout() {
  await db.setSetting('campus', null);
  emit('change', { type: 'campus' });
}

let running = null;
export function syncing() { return !!running; }

export function sync(opts) {
  if (!running) running = doSync(opts).finally(() => { running = null; emit('change', { type: 'campus' }); });
  return running;
}

export async function maybeAutoSync() {
  const acc = await account();
  if (!acc || !navigator.onLine) return;
  if (!(await db.getSetting('autoSync', true))) return;
  if (acc.lastSync && Date.now() - acc.lastSync < AUTO_SYNC_MS) return;
  try { await sync(); } catch (err) { console.warn('Sync automática falló:', err); }
}

async function doSync({ onProgress = () => {} } = {}) {
  const acc = await account();
  if (!acc) throw new Error('Conectá tu cuenta del campus primero');
  onProgress('Consultando el campus…');
  let snap;
  try {
    snap = await api.post('/api/campus/sync', { url: acc.url, token: acc.token });
  } catch (err) {
    if (err.status === 401) { acc.error = 'La sesión del campus venció. Volvé a conectar.'; await db.setSetting('campus', acc); }
    throw err;
  }

  const notebooks = await db.all('notebooks');
  const byCourse = new Map(notebooks.filter((n) => n.courseId != null).map((n) => [n.courseId, n]));
  let newFiles = 0;
  const hidden = new Set((await db.getSetting('hiddenCourses', [])) || []);

  for (const course of snap.courses) {
    if (hidden.has(course.id)) continue;
    let nb = byCourse.get(course.id);
    if (!nb) {
      // ¿Ya existía una materia creada a mano con la misma sigla o nombre? La vinculamos.
      const pretty = normalize(prettyCourseName(course.name));
      nb = notebooks.find((n) => n.courseId == null && ((n.shortname && normalize(n.shortname) === normalize(course.shortname)) || normalize(n.name) === pretty));
      if (nb) { nb.courseId = course.id; byCourse.set(course.id, nb); }
    }
    if (!nb) {
      nb = await createNotebook({ name: prettyCourseName(course.name), courseId: course.id, shortname: course.shortname });
    }
    nb.campusName = course.name;
    nb.shortname = course.shortname;
    nb.startdate = course.startdate;
    nb.enddate = course.enddate;
    nb.sections = course.sections;
    nb.syncedAt = snap.syncedAt;
    await saveNotebook(nb);

    const files = course.sections.flatMap((s) => s.modules.flatMap((m) => m.files.map((f) => ({ ...f, section: s.name, module: m.name }))));
    for (const f of files) {
      const id = fileId(course.id, f.url);
      const existing = await db.get('files', id);
      const meta = { id, courseId: course.id, notebookId: nb.id, name: f.name, url: f.url, size: f.size, mimetype: f.mimetype, modified: f.modified, section: f.section, module: f.module };
      if (existing && existing.modified >= f.modified && existing.downloaded) { continue; }
      const isNew = !existing;
      await db.put('files', { ...existing, ...meta, downloaded: false, seen: existing?.seen ?? false, addedAt: existing?.addedAt || Date.now() });
      if (isNew) newFiles++;
    }
  }

  await db.setSetting('campusEvents', snap.events);
  acc.lastSync = snap.syncedAt;
  acc.site = snap.site;
  acc.error = null;
  await db.setSetting('campus', acc);
  emit('change', { type: 'campus' });

  // Descarga en segundo plano del material pendiente.
  if (await db.getSetting('autoDownload', true)) {
    const pending = (await db.all('files')).filter((f) => !f.downloaded && f.size <= MAX_FILE && isDownloadable(f.name));
    let i = 0;
    for (const f of pending) {
      onProgress(`Descargando material ${++i}/${pending.length}…`);
      try { await download(f.id); } catch (err) { console.warn('No se pudo bajar', f.name, err); }
    }
  }
  return { courses: snap.courses.length, newFiles, events: snap.events.length };
}

export const isDownloadable = (name) => /\.(pdf|docx?|pptx?|xlsx?|txt|md|png|jpe?g|gif|csv)$/i.test(name);
export const isPdf = (f) => /\.pdf$/i.test(f.name) || f.mimetype === 'application/pdf';

export async function download(id) {
  const f = await db.get('files', id);
  if (!f) throw new Error('Archivo desconocido');
  if (f.downloaded) return getBlob(id);
  const acc = await account();
  const blob = await api.post('/api/campus/file', { url: acc.url, token: acc.token, fileurl: f.url }, { raw: true });
  await db.put('blobs', { id: `file:${id}`, blob });
  await db.put('files', { ...f, downloaded: true, downloadedAt: Date.now() });
  emit('change', { type: 'file', id });
  return blob;
}

export async function getBlob(id) {
  const row = await db.get('blobs', `file:${id}`);
  return row?.blob || null;
}

// Archivos importados a mano (PDF propio, foto del pizarrón, etc.).
export async function importLocalFile(file, notebookId) {
  const id = db.uid('local_');
  await db.put('blobs', { id: `file:${id}`, blob: file });
  await db.put('files', { id, courseId: null, notebookId, name: file.name, size: file.size, mimetype: file.type, modified: Date.now(), downloaded: true, local: true, seen: true, addedAt: Date.now() });
  emit('change', { type: 'file', id });
  return id;
}

function fileId(courseId, url) {
  const clean = url.replace(/[?&]forcedownload=1/, '');
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (Math.imul(31, h) + clean.charCodeAt(i)) | 0;
  return `c${courseId}_${(h >>> 0).toString(36)}`;
}

// "ECO123 - Microeconomía I (2026-2)" -> "Microeconomía I"
export function prettyCourseName(name) {
  const cleaned = name
    .replace(/\s*[\[(](?:\d{4}|[12]°?\s*sem|sem|cuat|c\d)[^\])]*[\])]\s*/gi, ' ')
    .replace(/^[A-Z]{2,}[-_ ]?\d{2,}\s*[-–:]\s*/, '')
    .trim();
  return cleaned || name;
}
