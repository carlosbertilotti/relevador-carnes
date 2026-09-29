// Modelo de datos de Cuaderno.
//
// Cuaderno (= materia): { id, name, color, courseId, shortname, schedule[], sections[], createdAt }
//   schedule: [{ day: 0-6 (0=domingo), start: 'HH:MM', end: 'HH:MM', room }]
// Nota (= clase):       { id, notebookId, title, classDate: 'YYYY-MM-DD', blocks[], pinned, createdAt, updatedAt, recordings[] }
//   bloque de texto:    { id, type: 'text', html }
//   bloque de lápiz:    { id, type: 'ink', paper, height, strokes[], pdf?: { fileId, page } }
import * as db from './db.js';
import { parseICS, expandEvents } from './lib/ics.js';

export const COLORS = ['#e8a33d', '#d9534f', '#5b8def', '#3fb37f', '#9b6cd6', '#e56fa6', '#2bb3c0', '#8a8f98'];
export const PAPER_W = 1000; // ancho lógico de una hoja; el alto va en las mismas unidades
export const PAGE_H = 1414; // proporción A4

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export function ymd(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function fromYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---------- Cuadernos ----------
export async function listNotebooks() {
  const rows = await db.all('notebooks');
  return rows.filter((n) => !n.archived).sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
}
export async function createNotebook(data = {}) {
  const existing = await db.all('notebooks');
  const nb = {
    // Las materias del campus tienen el mismo id en todos los dispositivos.
    id: data.courseId != null ? campusNotebookId(data.courseId) : db.uid('nb_'),
    name: data.name || 'Nueva materia',
    color: data.color || COLORS[existing.length % COLORS.length],
    courseId: data.courseId ?? null,
    shortname: data.shortname || '',
    schedule: data.schedule || [],
    sections: data.sections || [],
    createdAt: Date.now(),
    order: existing.length,
  };
  await db.put('notebooks', nb);
  emit('change', { type: 'notebook', id: nb.id });
  return nb;
}
export const campusNotebookId = (courseId) => `nb_c${courseId}`;

// Si la misma materia del campus quedó dos veces (por ejemplo, se conectó el
// campus en dos dispositivos antes de sincronizar), se juntan en una sola:
// se mueven las notas y el material y se borra la copia.
export async function mergeDuplicateNotebooks() {
  const all = await db.all('notebooks');
  const byCourse = new Map();
  for (const nb of all) {
    if (nb.courseId == null) continue;
    if (!byCourse.has(nb.courseId)) byCourse.set(nb.courseId, []);
    byCourse.get(nb.courseId).push(nb);
  }
  let merged = 0;
  for (const [courseId, list] of byCourse) {
    if (list.length < 2) continue;
    const target = list.find((n) => n.id === campusNotebookId(courseId))
      || list.slice().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
    for (const dup of list) {
      if (dup === target) continue;
      for (const n of await db.byIndex('notes', 'notebookId', dup.id)) await db.put('notes', { ...n, notebookId: target.id });
      for (const f of await db.byIndex('files', 'courseId', courseId)) {
        if (f.notebookId !== target.id) await db.put('files', { ...f, notebookId: target.id });
      }
      if (!target.schedule?.length && dup.schedule?.length) target.schedule = dup.schedule;
      if (!target.nameManual && dup.nameManual) { target.name = dup.name; target.nameManual = true; }
      if (!target.statusManual && dup.statusManual) { target.status = dup.status; target.statusManual = dup.statusManual; }
      if (!target.sections?.length && dup.sections?.length) target.sections = dup.sections;
      await db.del('notebooks', dup.id);
      merged++;
    }
    await db.put('notebooks', target);
  }
  if (merged) emit('change', { type: 'notebook' });
  return merged;
}

export async function saveNotebook(nb) {
  await db.put('notebooks', nb);
  emit('change', { type: 'notebook', id: nb.id });
}
export async function deleteNotebook(id) {
  for (const n of await db.byIndex('notes', 'notebookId', id)) await deleteNote(n.id);
  await db.del('notebooks', id);
  emit('change', { type: 'notebook', id });
}

// ---------- Notas ----------
export function newTextBlock(html = '') {
  return { id: db.uid('b_'), type: 'text', html };
}
export function newInkBlock(opts = {}) {
  return {
    id: db.uid('b_'), type: 'ink', paper: opts.paper || 'lined', height: opts.height || PAGE_H, strokes: [],
    pdf: opts.pdf || null,
    image: opts.image || null, // { blobId, name }: diapositiva o foto como fondo
    ...(opts.slideText ? { slideText: opts.slideText } : {}),
  };
}

export async function createNote(notebookId, data = {}) {
  const now = Date.now();
  const paper = (await db.getSetting('defaultPaper', 'lined')) || 'lined';
  const mode = (await db.getSetting('defaultMode', 'mixed')) || 'mixed';
  const blocks = data.blocks || (mode === 'ink'
    ? [newInkBlock({ paper })]
    : mode === 'text' ? [newTextBlock()] : [newTextBlock(), newInkBlock({ paper })]);
  const note = {
    id: db.uid('n_'),
    notebookId,
    title: data.title || '',
    classDate: data.classDate || ymd(),
    blocks,
    pinned: false,
    recordings: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.put('notes', note);
  emit('change', { type: 'note', id: note.id });
  return note;
}
export async function saveNote(note, { touch = true } = {}) {
  if (touch) note.updatedAt = Date.now();
  await db.put('notes', note);
  emit('change', { type: 'note', id: note.id, silent: true });
}
export async function deleteNote(id) {
  const note = await db.get('notes', id);
  if (note) for (const r of note.recordings || []) await db.del('blobs', r.blobId);
  await db.del('notes', id);
  emit('change', { type: 'note', id });
}
export async function notesOf(notebookId) {
  const rows = await db.byIndex('notes', 'notebookId', notebookId);
  return sortNotes(rows);
}
export function sortNotes(rows) {
  return rows.sort((a, b) => (b.pinned - a.pinned) || (b.classDate || '').localeCompare(a.classDate || '') || b.updatedAt - a.updatedAt);
}

export function noteText(note) {
  const div = document.createElement('div');
  const slides = note.blocks.filter((b) => b.slideText).map((b) => b.slideText).join('\n');
  return (note.blocks
    .filter((b) => b.type === 'text')
    .map((b) => {
      // Separar párrafos, títulos e ítems con saltos de línea (textContent los junta).
      div.innerHTML = b.html.replace(/<img[^>]*>/gi, '').replace(/<\/(p|div|h\d|li|pre|blockquote|tr)>|<br\s*\/?>/gi, '$&\n');
      return div.textContent || '';
    })
    .join('\n') + (slides ? `\n${slides}` : ''))
    .trim();
}
export function noteTitle(note, notebook) {
  if (note.title) return note.title;
  const first = noteText(note).split('\n').find((l) => l.trim());
  if (first) return first.slice(0, 80);
  return `Clase del ${fmtDate(note.classDate)}${notebook ? '' : ''}`;
}

// Abre (o crea) la nota de una materia para un día: "una nota por clase".
export async function noteForClass(notebookId, date) {
  const day = ymd(date);
  const existing = (await db.byIndex('notes', 'notebookId', notebookId)).find((n) => n.classDate === day && n.autoClass);
  if (existing) return existing;
  const nb = await db.get('notebooks', notebookId);
  const note = await createNote(notebookId, { classDate: day, title: `${nb?.name || 'Clase'} — ${fmtDate(day)}` });
  note.autoClass = true;
  await saveNote(note, { touch: false });
  return note;
}

export async function searchNotes(q) {
  const needle = normalize(q);
  if (!needle) return [];
  const notebooks = new Map((await db.all('notebooks')).map((n) => [n.id, n]));
  const out = [];
  for (const note of await db.all('notes')) {
    const text = noteText(note);
    const hay = normalize(`${note.title}\n${text}`);
    const i = hay.indexOf(needle);
    if (i >= 0) {
      out.push({ note, notebook: notebooks.get(note.notebookId), snippet: text.slice(Math.max(0, i - 40), i + 80) });
    }
  }
  return out.sort((a, b) => b.note.updatedAt - a.note.updatedAt);
}
export const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------- Calendario ----------
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };

// Todas las ocurrencias (clases, entregas, eventos) entre dos fechas.
export async function agenda(from, to) {
  const notebooks = await listNotebooks();
  const out = [];

  // 1) Horario semanal cargado a mano en cada materia.
  for (const nb of notebooks) {
    for (const slot of nb.schedule || []) {
      for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
        if (d.getDay() !== Number(slot.day)) continue;
        const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const start = day.getTime() + toMin(slot.start) * 60000;
        const end = day.getTime() + toMin(slot.end || slot.start) * 60000;
        if (nb.startdate && end < nb.startdate) continue;
        if (nb.enddate && start > nb.enddate + 86400000) continue;
        out.push({ id: `sch|${nb.id}|${start}`, kind: 'clase', title: nb.name, notebookId: nb.id, location: slot.room || '', start, end, source: 'horario' });
      }
    }
  }

  // 2) Calendarios iCal suscriptos (Google, Outlook, SIU, export del campus).
  const cals = (await db.getSetting('icsCalendars', [])) || [];
  for (const cal of cals) {
    if (!cal.events) continue;
    for (const ev of expandEvents(cal.events, from.getTime(), to.getTime())) {
      const nb = matchNotebook(notebooks, `${ev.title} ${ev.description}`);
      out.push({ ...ev, id: `ics|${cal.id}|${ev.id}`, kind: cal.kind || (nb ? 'clase' : 'evento'), notebookId: nb?.id || null, source: cal.name, color: cal.color });
    }
  }

  // 3) Eventos del campus (entregas, parciales, etc.).
  const campusEvents = (await db.getSetting('campusEvents', [])) || [];
  for (const ev of campusEvents) {
    if (ev.end < from.getTime() || ev.start >= to.getTime()) continue;
    const nb = notebooks.find((n) => n.courseId != null && n.courseId === ev.courseId);
    out.push({ ...ev, notebookId: nb?.id || null });
  }

  // Si una clase aparece en el horario y en un iCal, queda una sola.
  const seen = new Set();
  return out
    .sort((a, b) => a.start - b.start || (a.source === 'horario' ? 1 : -1))
    .filter((e) => {
      if (e.kind !== 'clase' || !e.notebookId) return true;
      const key = `${e.notebookId}|${Math.round(e.start / 900000)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function matchNotebook(notebooks, text) {
  const hay = normalize(text);
  let best = null;
  let bestScore = 0;
  for (const nb of notebooks) {
    if (nb.shortname && hay.includes(normalize(nb.shortname))) return nb;
    const words = normalize(nb.name).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (!words.length) continue;
    const score = words.filter((w) => hay.includes(w)).length / words.length;
    if (score > bestScore) { bestScore = score; best = nb; }
  }
  return bestScore >= 0.6 ? best : null;
}

export async function refreshIcs(api) {
  const cals = (await db.getSetting('icsCalendars', [])) || [];
  const errors = [];
  for (const cal of cals) {
    try {
      const { ics } = await api.post('/api/ics', { url: cal.url });
      cal.events = parseICS(ics);
      cal.syncedAt = Date.now();
      cal.error = null;
    } catch (err) {
      cal.error = err.message;
      errors.push(`${cal.name}: ${err.message}`);
    }
  }
  await db.setSetting('icsCalendars', cals);
  emit('change', { type: 'calendar' });
  return errors;
}

// ---------- Formato ----------
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export function fmtDate(s) {
  if (!s) return '';
  const d = typeof s === 'string' ? fromYmd(s) : new Date(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtTime(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtRelative(t) {
  const diff = Date.now() - t;
  if (diff < 60000) return 'recién';
  if (diff < 3600000) return `hace ${Math.round(diff / 60000)} min`;
  if (diff < 86400000) return `hace ${Math.round(diff / 3600000)} h`;
  return fmtDate(t);
}
export function fmtSize(b) {
  if (!b) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
