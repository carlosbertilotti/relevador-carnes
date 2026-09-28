// PDFs del campus como fondo de hojas para anotar encima (GoodNotes / Notability).
import { getBlob } from '../campus.js';

let lib;
async function pdfjs() {
  if (!lib) {
    lib = await import('/vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return lib;
}

const docs = new Map();
export async function loadPdf(fileId) {
  if (!docs.has(fileId)) {
    docs.set(fileId, (async () => {
      const blob = await getBlob(fileId);
      if (!blob) throw new Error('El PDF todavía no se descargó');
      const { getDocument } = await pdfjs();
      return getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    })());
  }
  try {
    return await docs.get(fileId);
  } catch (err) {
    docs.delete(fileId);
    throw err;
  }
}

// Tamaño de cada página, para crear hojas con la proporción correcta.
export async function pageSizes(fileId) {
  const doc = await loadPdf(fileId);
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    out.push({ page: i, width: vp.width, height: vp.height });
  }
  return out;
}

const rendering = new WeakMap();
export async function renderPdfPage({ fileId, page }, canvas) {
  rendering.get(canvas)?.cancel();
  try {
    const doc = await loadPdf(fileId);
    const p = await doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: canvas.width / base.width });
    const task = p.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
    rendering.set(canvas, task);
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#999';
    ctx.font = `${Math.round(canvas.width / 30)}px system-ui`;
    ctx.fillText('No se pudo mostrar esta página del PDF', canvas.width * 0.08, canvas.height * 0.1);
  }
}

// Texto del PDF, para poder buscar dentro del material.
export async function pdfText(fileId, maxPages = 60) {
  const doc = await loadPdf(fileId);
  const parts = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    parts.push(tc.items.map((it) => it.str).join(' '));
  }
  return parts.join('\n');
}
