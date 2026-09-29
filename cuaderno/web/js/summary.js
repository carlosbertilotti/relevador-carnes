// Resúmenes con IA: uno por clase (se guarda en la nota y se rehace sólo si la
// nota cambió) y uno general por materia que junta los de todas las clases.
import * as db from './db.js';
import * as store from './store.js';
import { api } from './campus.js';
import { drawPaper, renderStrokes } from './editor/ink.js';
import { renderPdfPage, pdfText } from './editor/pdf.js';

const IMG_W = 1100;
const MAX_IMAGES = 12;
const MAX_BODY = 3_600_000; // margen bajo el límite de 4,5 MB de Vercel

const hasContent = (note) => store.noteText(note).length > 20 || note.blocks.some((b) => b.type === 'ink' && b.strokes.length);
export const noteNeedsSummary = (note) => hasContent(note) && (!note.summary || note.summary.at < note.updatedAt);

// Dibuja una hoja (fondo + tinta) fuera de pantalla y la devuelve como JPEG en base64.
async function sheetJpeg(block) {
  const canvas = document.createElement('canvas');
  canvas.width = IMG_W;
  canvas.height = Math.round((IMG_W * block.height) / store.PAPER_W);
  const ctx = canvas.getContext('2d');
  const scale = IMG_W / store.PAPER_W;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (block.pdf) {
    await renderPdfPage(block.pdf, canvas);
  } else if (block.image) {
    const row = await db.get('blobs', block.image.blobId);
    if (row?.blob) ctx.drawImage(await createImageBitmap(row.blob), 0, 0, canvas.width, canvas.height);
  } else {
    drawPaper(ctx, block.paper, block.height, scale);
  }
  renderStrokes(ctx, block.strokes, scale);
  const url = canvas.toDataURL('image/jpeg', 0.72);
  return url.slice(url.indexOf(',') + 1);
}

async function notePayload(note) {
  let texto = store.noteText(note);
  // Texto de los PDFs que estén en la nota (sirve aunque no tengan anotaciones).
  const pdfIds = [...new Set(note.blocks.filter((b) => b.pdf).map((b) => b.pdf.fileId))];
  for (const id of pdfIds) {
    try {
      const t = await pdfText(id, 40);
      if (t.trim()) texto += `\n\n[Texto del PDF]\n${t.slice(0, 25_000)}`;
    } catch { /* PDF sin texto o no descargado */ }
  }
  const sheets = note.blocks.filter((b) => b.type === 'ink' && b.strokes.length);
  const imagenes = [];
  let size = texto.length;
  for (const b of sheets.slice(0, MAX_IMAGES)) {
    const data = await sheetJpeg(b);
    if (size + data.length > MAX_BODY) break;
    size += data.length;
    imagenes.push({ data, etiqueta: b.pdf ? `${b.pdf.name} pág. ${b.pdf.page} anotada` : b.image ? `${b.image.name || 'imagen'} anotada` : 'hoja escrita a mano' });
  }
  if (sheets.length > imagenes.length) texto += `\n\n(Hay ${sheets.length - imagenes.length} hoja(s) escritas a mano más que no se incluyeron.)`;
  return { titulo: note.title || store.noteTitle(note), fecha: note.classDate || '', texto, imagenes };
}

// ¿El servidor tiene configurada la IA? (se consulta una vez por sesión)
let aiCheck;
export function aiAvailable() {
  aiCheck ||= fetch('/api/health').then((r) => r.json()).then((j) => !!j.ai).catch(() => false);
  return aiCheck;
}

export async function summarizeInBackground(note, materia) {
  if (!navigator.onLine || !(await aiAvailable())) return;
  try { await summarizeNote(note, materia); } catch { /* se reintenta al abrir la pestaña Resumen */ }
}

export async function summarizeNote(note, materia) {
  const nota = await notePayload(note);
  const { markdown } = await api.post('/api/resumen', { mode: 'nota', materia, nota });
  const fresh = await db.get('notes', note.id);
  if (!fresh) return null;
  fresh.summary = { md: markdown, at: fresh.updatedAt, madeAt: Date.now() };
  await store.saveNote(fresh, { touch: false });
  return fresh;
}

// Actualiza lo que haga falta y devuelve el resumen de la materia.
export async function updateNotebookSummary(nbId, { onProgress = () => {}, force = false } = {}) {
  const nb = await db.get('notebooks', nbId);
  const notes = (await store.notesOf(nbId)).filter(hasContent)
    .sort((a, b) => (a.classDate || '').localeCompare(b.classDate || '') || a.createdAt - b.createdAt);
  if (!notes.length) return { nb, notes, empty: true };

  const stale = notes.filter((n) => force || noteNeedsSummary(n));
  let i = 0;
  const failures = [];
  for (const n of stale) {
    onProgress(`Resumiendo clase ${++i} de ${stale.length}: ${n.title || store.noteTitle(n)}…`);
    try {
      Object.assign(n, await summarizeNote(n, nb.name));
    } catch (err) {
      if (err.status === 503 || err.code === 'appkey') throw err; // falta configurar: no tiene sentido seguir
      failures.push(`${n.title || store.noteTitle(n)}: ${err.message}`);
    }
  }

  const done = notes.filter((n) => n.summary?.md);
  const basis = done.map((n) => `${n.id}:${n.summary.madeAt}`).join('|');
  if (done.length && (force || !nb.summary || nb.summary.basis !== basis)) {
    onProgress('Armando el resumen de la materia…');
    const { markdown } = await api.post('/api/resumen', {
      mode: 'materia',
      materia: nb.name,
      notas: done.map((n) => ({ titulo: n.title || store.noteTitle(n), fecha: n.classDate || '', resumen: n.summary.md })),
    });
    nb.summary = { md: markdown, at: Date.now(), basis, count: done.length };
    await store.saveNotebook(nb);
  }
  return { nb, notes, failures };
}

// ---------- Markdown + fórmulas ----------
let libs;
async function loadLibs() {
  libs ||= Promise.all([
    import('/vendor/marked/marked.esm.js'),
    import('/vendor/katex/katex.mjs'),
    import('/vendor/dompurify/purify.es.mjs'),
  ]).then(([m, k, d]) => {
    if (!document.querySelector('link[data-katex]')) {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/katex/katex.min.css' });
      link.dataset.katex = '1';
      document.head.append(link);
    }
    return { marked: m.marked, katex: k.default, DOMPurify: d.default };
  });
  return libs;
}

export async function renderMarkdown(md) {
  const { marked, katex, DOMPurify } = await loadLibs();
  const math = [];
  const keep = (tex, display) => {
    let html;
    try {
      html = katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: 'html' });
    } catch {
      html = `<code>${tex.replace(/</g, '&lt;')}</code>`;
    }
    math.push(html);
    return `@@KX${math.length - 1}@@`;
  };
  const src = String(md)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => keep(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(t, false))
    .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_, t) => keep(t, false));
  const html = marked.parse(src, { gfm: true, breaks: false })
    .replace(/@@KX(\d+)@@/g, (_, i) => math[+i]);
  return DOMPurify.sanitize(html);
}
