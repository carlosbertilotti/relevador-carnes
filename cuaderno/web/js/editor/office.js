// Abrir el material del campus dentro de Cuaderno para editarlo y anotarlo.
//  - PDF: cada página es una hoja para escribir encima.
//  - PowerPoint (.pptx): cada diapositiva se dibuja como hoja (texto, imágenes,
//    tablas y formas básicas) y además se guarda su texto para buscar y resumir.
//  - Word (.docx): se convierte a texto con formato editable.
// Lo que edites queda en la nota de Cuaderno; el archivo del campus no cambia.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { pageSizes } from './pdf.js';

const EMU_PER_PT = 12700;
const SLIDE_PX = 1600; // ancho con el que se dibuja cada diapositiva

export const kindOf = (name) => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'docx') return 'docx';
  if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return 'image';
  return null;
};

export const canOpen = (f) => !!kindOf(f.name);

// Abre (o crea la primera vez) la nota de un archivo del campus.
export async function openMaterial(fileId, onProgress = () => {}) {
  const f = await db.get('files', fileId);
  if (!f) throw new Error('Archivo desconocido');
  const existing = (await db.byIndex('notes', 'notebookId', f.notebookId)).find((n) => n.sourceFileId === fileId);
  if (existing) return existing;

  onProgress('Descargando…');
  const blob = await campus.download(fileId);
  onProgress('Preparando para editar…');
  const blocks = await blocksFromFile(f, blob);
  const note = await store.createNote(f.notebookId, {
    title: f.name.replace(/\.[^.]+$/, ''),
    classDate: store.ymd(f.modified || Date.now()),
    blocks,
  });
  note.sourceFileId = fileId;
  await store.saveNote(note, { touch: false });
  if (!f.seen) await db.put('files', { ...(await db.get('files', fileId)), seen: true });
  return note;
}

export async function blocksFromFile(f, blob) {
  switch (kindOf(f.name)) {
    case 'pdf': {
      const sizes = await pageSizes(f.id);
      return sizes.map((s) => store.newInkBlock({
        height: Math.round((store.PAPER_W * s.height) / s.width),
        pdf: { fileId: f.id, page: s.page, name: f.name },
      }));
    }
    case 'pptx': return pptxBlocks(f, blob);
    case 'docx': return [store.newTextBlock(await docxToHtml(blob)), store.newInkBlock()];
    case 'image': {
      const bmp = await createImageBitmap(blob);
      const blobId = `img:${db.uid()}`;
      await db.put('blobs', { id: blobId, blob });
      return [store.newInkBlock({ height: Math.round((store.PAPER_W * bmp.height) / bmp.width), image: { blobId } })];
    }
    default: throw new Error('Este tipo de archivo todavía no se puede abrir en Cuaderno');
  }
}

// ---------------- Word ----------------
let mammothLoading;
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.append(s);
  });
}

async function docxToHtml(blob) {
  mammothLoading ||= loadScript('/vendor/mammoth/mammoth.browser.min.js', 'mammoth');
  const mammoth = await mammothLoading;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  const { default: DOMPurify } = await import('/vendor/dompurify/purify.es.mjs');
  return DOMPurify.sanitize(value || '<p>(documento vacío)</p>');
}

// ---------------- PowerPoint ----------------
let jszipLoading;
const byTag = (el, tag) => (el ? [...el.getElementsByTagNameNS('*', tag)] : []);
const child = (el, tag) => (el ? [...el.children].find((c) => c.localName === tag) || null : null);
const children = (el, tag) => (el ? [...el.children].filter((c) => c.localName === tag) : []);

async function pptxBlocks(f, blob) {
  jszipLoading ||= loadScript('/vendor/jszip/jszip.min.js', 'JSZip');
  const JSZip = await jszipLoading;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const deck = await readDeck(zip);
  const blocks = [];
  for (let i = 0; i < deck.slides.length; i++) {
    const { canvas, text } = await renderSlide(zip, deck, deck.slides[i]);
    const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const blobId = `img:${db.uid()}`;
    await db.put('blobs', { id: blobId, blob: png });
    blocks.push(store.newInkBlock({
      height: Math.round((store.PAPER_W * deck.cy) / deck.cx),
      image: { blobId, name: `${f.name} · diapositiva ${i + 1}` },
      slideText: text,
    }));
  }
  if (!blocks.length) throw new Error('La presentación no tiene diapositivas');
  return blocks;
}

async function xml(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  return new DOMParser().parseFromString(await file.async('string'), 'application/xml');
}

function resolvePath(from, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function rels(zip, path) {
  const dir = path.split('/').slice(0, -1).join('/');
  const name = path.split('/').pop();
  const doc = await xml(zip, `${dir}/_rels/${name}.rels`);
  const out = {};
  for (const r of byTag(doc, 'Relationship')) {
    out[r.getAttribute('Id')] = { type: r.getAttribute('Type') || '', path: resolvePath(path, r.getAttribute('Target')) };
  }
  return out;
}

async function readDeck(zip) {
  const pres = await xml(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('El archivo no parece un PowerPoint (.pptx)');
  const size = byTag(pres, 'sldSz')[0];
  const cx = Number(size?.getAttribute('cx') || 12192000);
  const cy = Number(size?.getAttribute('cy') || 6858000);
  const presRels = await rels(zip, 'ppt/presentation.xml');
  const slides = byTag(pres, 'sldId').map((s) => presRels[s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')]?.path).filter(Boolean);
  return { cx, cy, slides };
}

// Posición heredada de los "placeholders" del diseño/patrón de diapositivas.
function placeholderKey(sp) {
  const ph = byTag(child(sp, 'nvSpPr') || child(sp, 'nvPicPr') || sp, 'ph')[0];
  if (!ph) return null;
  return { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') };
}

function findPlaceholder(doc, key) {
  if (!doc || !key) return null;
  const sps = byTag(doc, 'sp');
  return sps.find((sp) => { const k = placeholderKey(sp); return k && key.idx != null && k.idx === key.idx; })
    || sps.find((sp) => { const k = placeholderKey(sp); return k && k.type === key.type; })
    || (key.type === 'ctrTitle' ? sps.find((sp) => placeholderKey(sp)?.type === 'title') : null)
    || (key.type === 'subTitle' ? sps.find((sp) => placeholderKey(sp)?.type === 'body') : null);
}

function xfrmOf(el) {
  if (!el) return null;
  const holder = child(el, 'spPr') || child(el, 'grpSpPr');
  const x = holder ? child(holder, 'xfrm') : child(el, 'xfrm');
  const off = x && child(x, 'off');
  const ext = x && child(x, 'ext');
  if (!off || !ext) return null;
  return { x: +off.getAttribute('x'), y: +off.getAttribute('y'), w: +ext.getAttribute('cx'), h: +ext.getAttribute('cy') };
}

function colorOf(fillParent) {
  const solid = child(fillParent, 'solidFill');
  const srgb = solid && child(solid, 'srgbClr');
  return srgb ? `#${srgb.getAttribute('val')}` : null;
}

async function renderSlide(zip, deck, path) {
  const k = SLIDE_PX / deck.cx;
  const canvas = document.createElement('canvas');
  canvas.width = SLIDE_PX;
  canvas.height = Math.round(deck.cy * k);
  const ctx = canvas.getContext('2d');
  const slide = await xml(zip, path);
  const slideRels = await rels(zip, path);
  const layoutPath = Object.values(slideRels).find((r) => r.type.endsWith('/slideLayout'))?.path;
  const layout = layoutPath ? await xml(zip, layoutPath) : null;
  const masterPath = layoutPath ? Object.values(await rels(zip, layoutPath)).find((r) => r.type.endsWith('/slideMaster'))?.path : null;
  const master = masterPath ? await xml(zip, masterPath) : null;

  // Fondo
  const bgOf = (doc) => { const bg = byTag(doc, 'bgPr')[0]; return bg ? colorOf(bg) : null; };
  ctx.fillStyle = bgOf(slide) || bgOf(layout) || bgOf(master) || '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texts = [];
  const tree = byTag(slide, 'spTree')[0];
  let stackY = 0.06 * deck.cy; // para formas sin posición conocida

  const drawShape = async (el) => {
    const kind = el.localName;
    if (kind === 'grpSp') { for (const c of el.children) await drawShape(c); return; }
    const key = placeholderKey(el);
    let box = xfrmOf(el) || xfrmOf(findPlaceholder(layout, key)) || xfrmOf(findPlaceholder(master, key));

    if (kind === 'pic') {
      const embed = byTag(el, 'blip')[0];
      const rid = embed?.getAttribute('r:embed') || embed?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      const media = rid && slideRels[rid] && zip.file(slideRels[rid].path);
      if (media && box && /\.(png|jpe?g|gif|bmp|webp)$/i.test(slideRels[rid].path)) {
        try {
          const bmp = await createImageBitmap(await media.async('blob'));
          ctx.drawImage(bmp, box.x * k, box.y * k, box.w * k, box.h * k);
        } catch { /* imagen en un formato que el navegador no lee (EMF/WMF) */ }
      }
      return;
    }

    if (kind === 'graphicFrame') {
      const rows = byTag(el, 'tr').map((tr) => byTag(tr, 'tc').map((tc) => byTag(tc, 't').map((t) => t.textContent).join('')));
      if (!rows.length) return;
      box ||= { x: 0.05 * deck.cx, y: stackY, w: 0.9 * deck.cx, h: rows.length * 0.06 * deck.cy };
      const colW = (box.w * k) / Math.max(...rows.map((r) => r.length));
      const rowH = (box.h * k) / rows.length;
      ctx.strokeStyle = '#999';
      ctx.fillStyle = '#222';
      ctx.font = `${Math.max(12, Math.min(rowH * 0.45, 28))}px Helvetica, Arial, sans-serif`;
      rows.forEach((r, i) => r.forEach((cell, j) => {
        const x = box.x * k + j * colW;
        const y = box.y * k + i * rowH;
        ctx.strokeRect(x, y, colW, rowH);
        wrapText(ctx, cell, x + 6, y + 6, colW - 12, rowH - 12, parseFloat(ctx.font));
      }));
      texts.push(rows.map((r) => r.join(' | ')).join('\n'));
      return;
    }

    if (kind !== 'sp') return;
    const spPr = child(el, 'spPr');
    const fill = spPr && colorOf(spPr);
    const txBody = child(el, 'txBody');
    const paras = txBody ? children(txBody, 'p') : [];
    const lines = paras.map((p) => ({
      text: byTag(p, 't').map((t) => t.textContent).join(''),
      rPr: byTag(p, 'rPr')[0] || byTag(p, 'endParaRPr')[0],
      lvl: +(child(p, 'pPr')?.getAttribute('lvl') || 0),
      bullet: !!byTag(child(p, 'pPr'), 'buChar')[0] || (key && key.type === 'body'),
    })).filter((l) => l.text.trim());

    if (!box) {
      if (!lines.length) return;
      const isTitle = key && /title/i.test(key.type);
      box = { x: 0.06 * deck.cx, y: isTitle ? 0.05 * deck.cy : stackY, w: 0.88 * deck.cx, h: isTitle ? 0.15 * deck.cy : 0.6 * deck.cy };
    }
    stackY = Math.max(stackY, box.y + box.h);
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(box.x * k, box.y * k, box.w * k, box.h * k); }
    if (!lines.length) return;

    const isTitle = key && /title/i.test(key.type);
    let y = box.y * k + 8;
    for (const l of lines) {
      const sz = +(l.rPr?.getAttribute('sz') || (isTitle ? 3200 : 2000));
      const px = Math.max(10, (sz / 100) * EMU_PER_PT * k);
      const bold = l.rPr?.getAttribute('b') === '1' || isTitle;
      ctx.font = `${bold ? 'bold ' : ''}${px}px Helvetica, Arial, sans-serif`;
      ctx.fillStyle = (l.rPr && colorOf(l.rPr)) || '#1f1f1f';
      const indent = l.lvl * px * 1.2 + (l.bullet && !isTitle ? px * 1.1 : 0);
      if (l.bullet && !isTitle) ctx.fillText('•', box.x * k + l.lvl * px * 1.2 + 4, y + px);
      y = wrapText(ctx, l.text, box.x * k + indent + 4, y, box.w * k - indent - 8, Infinity, px) + px * 0.35;
    }
    texts.push(lines.map((l) => `${'  '.repeat(l.lvl)}${l.bullet && !isTitle ? '• ' : ''}${l.text}`).join('\n'));
  };

  for (const el of tree ? [...tree.children] : []) await drawShape(el);
  return { canvas, text: texts.join('\n') };
}

// Dibuja texto con salto de línea; devuelve la posición y siguiente.
function wrapText(ctx, text, x, y, maxW, maxH, lineH) {
  const words = String(text).split(/\s+/);
  let line = '';
  let yy = y;
  const lh = lineH * 1.2;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy + lineH);
      line = w;
      yy += lh;
      if (yy - y > maxH) return yy;
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, yy + lineH); yy += lh; }
  return yy;
}
