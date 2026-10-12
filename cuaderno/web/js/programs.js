// Texto de los documentos clave de las materias en curso (programa, reglas,
// consignas): se extrae en el dispositivo y se sincroniza como texto liviano
// ("programText:<fileId>"), así se puede leer desde cualquier lado sin bajar
// los PDFs enteros. También lo usa "Para esta clase".
import * as db from './db.js';
import * as store from './store.js';
import { download } from './campus.js';
import { loadPdf } from './editor/pdf.js';
import { docxText } from './editor/office.js';

const KEY_DOC = /(programa|syllabus|cronograma|plan de clases|trading game|consigna|reglas)/i;
const DAY = 86400000;
const VERSION = 2;
const MAX_SIZE = 15 * 1024 * 1024;
const MAX_CHARS = 120000;

export const isKeyDoc = (f) => !f.local && KEY_DOC.test(`${f.name} ${f.module || ''}`)
  && /\.(pdf|docx|doc)$/i.test(f.name) && (f.size || 0) <= MAX_SIZE;

// Materias con clases, ayudantías, exámenes o entregas cerca (las que se están cursando).
export async function activeNotebookIds(now = Date.now()) {
  const notebooks = await store.listNotebooks();
  const events = ((await db.getSetting('campusEvents', [])) || []).map((e) => store.classifyCampusEvent(e, notebooks));
  return new Set(events.filter((e) => e.notebookId && e.start > now - 30 * DAY && e.start < now + 120 * DAY).map((e) => e.notebookId));
}

async function pdfToText(fileId, maxPages = 40) {
  const doc = await loadPdf(fileId);
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  return out.join('\n\n');
}

// Word 97-2003 (.doc): no hay lector en el navegador; se rescatan los tramos de
// texto legibles (el documento guarda el texto como UTF-16 o como Windows-1252).
export function docBinaryText(buf) {
  const bytes = new Uint8Array(buf);
  const ok = (c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || (c >= 0xa0 && c <= 0x17f) || (c >= 0x2010 && c <= 0x2026);
  const runs = (codes) => {
    const out = [];
    let cur = '';
    for (const c of codes) {
      if (ok(c)) cur += String.fromCharCode(c);
      else { if (cur.length >= 6) out.push(cur); cur = ''; }
    }
    if (cur.length >= 6) out.push(cur);
    return out.filter((r) => (r.match(/[A-Za-zÁÉÍÓÚáéíóúÑñ]/g) || []).length >= r.length * 0.5).join('\n');
  };
  const u16 = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) u16.push(bytes[i] | (bytes[i + 1] << 8));
  const cp = new TextDecoder('windows-1252').decode(bytes);
  const a = runs(u16);
  const b = runs([...cp].map((ch) => ch.charCodeAt(0)));
  return (a.length >= b.length ? a : b).replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
}

async function textOf(f, blob) {
  if (/\.pdf$/i.test(f.name)) return pdfToText(f.id);
  if (/\.docx$/i.test(f.name)) return docxText(blob);
  return docBinaryText(await blob.arrayBuffer());
}

let running = null;
export function extractKeyDocs(opts) {
  if (!running) running = run(opts).finally(() => { running = null; });
  return running;
}

async function run({ force = false } = {}) {
  const active = await activeNotebookIds();
  const files = (await db.all('files')).filter((f) => active.has(f.notebookId) && isKeyDoc(f));
  const done = [];
  for (const f of files) {
    const key = `programText:${f.id}`;
    const cached = await db.getSetting(key, null);
    if (!force && cached?.v === VERSION && cached.modified === (f.modified || 0)) continue;
    const base = { v: VERSION, modified: f.modified || 0, name: f.name, notebookId: f.notebookId, at: Date.now() };
    let blob;
    try {
      blob = await download(f.id);
    } catch {
      continue; // sin conexión o sin campus en este dispositivo: se reintenta la próxima vez
    }
    try {
      const text = (await textOf(f, blob)).slice(0, MAX_CHARS);
      await db.setSetting(key, { ...base, text, chars: text.length });
      done.push(f.name);
    } catch (err) {
      // El archivo no se pudo leer: se deja constancia para no reintentar en cada arranque.
      await db.setSetting(key, { ...base, text: '', error: err.message });
    }
  }
  return done;
}
