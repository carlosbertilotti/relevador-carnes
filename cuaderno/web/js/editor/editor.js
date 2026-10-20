// Editor de una nota de clase.
// Una nota es una columna de bloques: texto con formato (como Notas de Apple,
// donde además funciona Scribble: escribís con el lápiz y se convierte en
// texto) y hojas para escribir a mano o anotar sobre los PDFs del campus.
import * as db from '../db.js';
import * as store from '../store.js';
import { isPdf, importLocalFile, download as downloadFile } from '../campus.js';
import { blocksFromFile, canOpen } from './office.js';
import { summarizeInBackground, noteNeedsSummary } from '../summary.js';
import { h, icon, popover, toast, modal, confirmDialog, debounce, prompt } from '../ui.js';
import { InkSheet, tools, serializeStrokes } from './ink.js';
import { renderPdfPage, forgetPdf } from './pdf.js';
import { Recorder, Player } from './audio.js';
import { VideoSession, fmtClock } from './video.js';
import * as live from '../live.js';

const PEN_COLORS = ['#1c1c1e', '#2f6fde', '#d0342c', '#23915a', '#8e44c9', '#e98a15'];
const HL_COLORS = ['#ffd60a', '#7ee081', '#ff9fc6', '#7cc8ff', '#ffb35c'];
const PEN_SIZES = [2.5, 4, 7];
const TOOL_NAMES = { pen: 'Lapicera', highlighter: 'Resaltador', eraser: 'Goma', lasso: 'Lazo' };
const PAPERS = [['lined', 'Rayada'], ['grid', 'Cuadriculada'], ['dots', 'Puntos'], ['blank', 'Lisa'], ['cornell', 'Cornell']];

export async function openEditor(root, noteId, { back, watch = false } = {}) {
  const note = await db.get('notes', noteId);
  if (!note) { root.replaceChildren(h('div.empty', 'La nota no existe.')); return () => {}; }
  const notebook = await db.get('notebooks', note.notebookId);
  const saved = await db.getSetting('tools', null);
  if (saved) Object.assign(tools, saved, { tool: saved.tool === 'none' ? 'none' : saved.tool });
  // En la compu (sin pantalla táctil) la nota se abre para escribir con el teclado.
  if (!navigator.maxTouchPoints) tools.tool = 'none';
  const ed = new Editor(root, note, notebook, back);
  await ed.mount();
  if (watch || note.video?.open) ed.openVideo({ quiet: true });
  return () => ed.destroy();
}

class Editor {
  constructor(root, note, notebook, back) {
    this.root = root;
    this.note = note;
    this.notebook = notebook;
    this.back = back;
    this.sheets = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.playback = null;
    this.seekMode = false;
    this.save = debounce(() => this._save(), 500);
    this.recorder = new Recorder();
    this.player = null;
  }

  // ---- host API para InkSheet ----
  onChange(block, before) {
    this._hideSidebarOnWrite();
    this.undoStack.push({ kind: 'strokes', blockId: block.id, before, after: block.strokes });
    this.redoStack = [];
    this._syncUndo();
    this.save();
  }
  // Al empezar a escribir se esconde la barra de materias para tener más hoja
  // (una vez por nota: si la volvés a mostrar, queda visible).
  _hideSidebarOnWrite() {
    if (this._autoHid) return;
    this._autoHid = true;
    document.body.classList.add('sidebar-hidden');
  }

  recordingClock() { return this.recorder.clock() || this.video?.clock() || null; }
  renderPdf(ref, canvas) { return renderPdfPage(ref, canvas); }
  async renderImage(ref, canvas) {
    const bmp = await imageBitmap(ref.blobId);
    if (bmp) canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  }
  async drawPhoto(ph, ctx, scale) {
    const bmp = await imageBitmap(ph.blobId);
    if (!bmp) return;
    // Recorte (en proporciones de la imagen original) y giro en cuartos de vuelta; el
    // marco (x, y, w, h) es lo que se ve, ya recortado y girado.
    const { sx, sy, sw, sh, rot } = photoGeom(ph, bmp);
    const swap = rot % 2 === 1;
    const dw = (swap ? ph.h : ph.w) * scale;
    const dh = (swap ? ph.w : ph.h) * scale;
    ctx.save();
    ctx.translate((ph.x + ph.w / 2) * scale, (ph.y + ph.h / 2) * scale);
    ctx.rotate((rot * Math.PI) / 2);
    ctx.drawImage(bmp, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  onPhotosChange(block, before) {
    this.undoStack.push({ kind: 'photos', blockId: block.id, before, after: block.photos });
    this.redoStack = [];
    this._syncUndo();
    this.save();
  }
  onPhotoSelect(sheet, ph) {
    this.activePhoto = ph ? sheet : null;
    if (ph) this.activeSelection = null;
    this._renderSelectionBar();
  }
  onSeek(t) {
    if (this.playback?.recId === 'video') this.video?.seek(t);
    else this.player?.seek(t);
  }
  onActivate(sheet) {
    for (const s of this.sheets.values()) if (s !== sheet) s.clearSelection();
  }
  onSelection(sheet, sel) {
    this.activeSelection = sel ? sheet : null;
    this._renderSelectionBar();
  }

  get personal() { return store.isPersonal(this.notebook); }

  // Lo que depende de dónde está la nota (materia o carpeta de "Personal"): se
  // vuelve a aplicar al moverla, acá o desde otro dispositivo.
  _applyNotebookUi() {
    const personal = this.personal; // nota de "Personal": sin grabación de clase, material ni corrección
    this.crumbEl.textContent = this.notebook?.name || '';
    this.crumbEl.style.color = this.notebook?.color || '';
    this.titleInput.placeholder = personal ? 'Título' : `${this.notebook?.name || 'Clase'} — ${store.fmtDate(this.note.classDate)}`;
    this.recBtn.title = personal ? 'Grabar audio' : 'Grabar la clase';
    this.watchBtn.hidden = personal;
    this.materialBtn.hidden = personal;
    const sb = document.getElementById('sidebar');
    if (sb) { sb.dataset.noteNotebook = this.note.notebookId || ''; sb.dataset.notePersonal = personal ? '1' : ''; }
  }

  async mount() {
    const n = this.note;
    this.titleInput = h('input.note-title', {
      value: n.title,
      oninput: () => { n.title = this.titleInput.value; this.save(); },
    });
    this.dateInput = h('input.note-date', { type: 'date', value: n.classDate || '', onchange: () => { n.classDate = this.dateInput.value; this.save(); } });
    this.recBtn = h('button.icon-btn.rec', { type: 'button', onclick: () => this.toggleRecording() }, icon('mic'));
    this.watchBtn = h('button.btn.small.watch-btn', { type: 'button', title: 'Ver la grabación de la clase y tomar notas', onclick: () => this.openVideo() }, icon('video'), h('span', 'Ver clase'));
    this.materialBtn = h('button.btn.ghost', { type: 'button', onclick: () => this.insertMaterial() }, icon('pdf'), 'Material');
    this.recTime = h('span.rec-time');
    const header = h('header.editor-head',
      h('button.icon-btn', { type: 'button', title: 'Mostrar / esconder las materias', 'aria-label': 'Mostrar u ocultar materias', onclick: () => { this._autoHid = true; document.body.classList.toggle('sidebar-hidden'); } }, icon('sidebar')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Volver', onclick: () => this.back() }, icon('back')),
      h('div.editor-titles',
        this.crumbEl = h('div.crumb'),
        this.titleInput),
      this.dateInput,
      h('div.spacer'),
      this.recTime,
      this.recBtn,
      this.watchBtn,
      h('button.icon-btn', { type: 'button', title: 'Grabaciones de audio', onclick: (e) => this.showRecordings(e.currentTarget) }, icon('list')),
      h('button.icon-btn', { type: 'button', title: 'Exportar / imprimir', onclick: () => this.exportPdf() }, icon('share')),
      h('button.icon-btn', { type: 'button', title: 'Más', onclick: (e) => this.moreMenu(e.currentTarget) }, icon('more')));

    this.toolbar = h('div.toolbar');
    this.blocksEl = h('div.blocks');
    this.playerBar = h('div.player-bar', { hidden: true });
    this.selectionBar = h('div.selection-bar', { hidden: true });
    this.videoBar = h('div.video-slot', { hidden: true });
    this.scroller = h('div.editor-scroll', this.blocksEl,
      h('div.add-row',
        h('button.btn.ghost', { type: 'button', onclick: () => this.addBlock('text') }, icon('text'), 'Texto'),
        h('button.btn.ghost', { type: 'button', onclick: () => this.addBlock('ink') }, icon('sheet'), 'Hoja'),
        this.materialBtn,
        h('button.btn.ghost', { type: 'button', onclick: () => this.insertImage() }, icon('image'), 'Foto')));
    this.root.replaceChildren(h('div.editor', header, this.videoBar, this.toolbar, this.selectionBar, this.scroller, this.playerBar));
    this._applyNotebookUi();
    this.renderToolbar();
    this.renderBlocks();

    this._onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !this._inText(e.target)) {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
      }
    };
    document.addEventListener('keydown', this._onKey);
    this._onVis = () => { if (document.hidden) this.save.flush(); };
    document.addEventListener('visibilitychange', this._onVis);
    this._onPen = (e) => {
      if (e.pointerType !== 'pen') return;
      // Primer contacto con el Apple Pencil: activar "sólo lápiz" automáticamente.
      if (!tools.penOnly && !this._penAuto) {
        this._penAuto = true;
        tools.penOnly = true;
        this.persistTools();
        this.renderToolbar();
        toast('Lápiz detectado: el dedo desplaza y el lápiz escribe. Dos toques con el dedo: herramienta anterior', { ms: 5000 });
      }
      // Como en Notas de Apple: escribiendo con el teclado, apoyar el lápiz en una hoja
      // pasa solo a dibujar (este aviso llega antes que el de la hoja, así el trazo arranca).
      if (tools.tool === 'none' && e.target.closest?.('.sheet') && !(this.seekMode && this.playback)) this.setTool(this.lastInkTool || 'pen');
    };
    document.addEventListener('pointerdown', this._onPen, true);
    this._bindDoubleTap();
    // Pegar una foto (⌘V o "Pegar" en el iPad): va a la hoja, no al texto.
    this._onPaste = (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      this.addPhoto(file);
    };
    document.addEventListener('paste', this._onPaste, true);
    // Arrastrar una imagen (del Finder, de otra ventana) y soltarla en la nota.
    this._onDragOver = (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'))) e.preventDefault(); };
    this._onDrop = (e) => {
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      (async () => { for (const f of files) await this.addPhoto(f); })();
    };
    this.scroller.addEventListener('dragover', this._onDragOver);
    this.scroller.addEventListener('drop', this._onDrop);
    // Cambios que llegan de otro dispositivo mientras la nota está abierta.
    this._onRemote = async (e) => {
      const d = e.detail || {};
      if (!d.remote && d.type !== 'campus') return;
      if (d.type === 'blob' || d.type === 'file') {
        const blobId = d.type === 'file' ? `file:${d.id}` : d.id;
        const fileId = blobId.startsWith('file:') ? blobId.slice(5) : null;
        bitmaps.delete(blobId);
        if (fileId) forgetPdf(fileId);
        for (const s of this.sheets.values()) {
          if (s.block.image?.blobId === blobId || (fileId && s.block.pdf?.fileId === fileId) || s.block.photos?.some((p) => p.blobId === blobId)) { s.bgDirty = true; s.render(); }
        }
        return;
      }
      if (d.type === 'campus' || d.type === 'sync') {
        // Llegó la conexión del campus o datos nuevos: reintentar los PDFs que no se
        // pudieron mostrar (los que sí se mostraron están en memoria y se redibujan rápido).
        for (const s of this.sheets.values()) if (s.block.pdf) { s.bgDirty = true; s.render(); }
        if (d.type === 'campus') return;
      }
      if (d.type !== 'note' || d.id !== this.note.id) return;
      const fresh = await db.get('notes', this.note.id);
      if (!fresh || (fresh._mod || 0) <= (this.note._mod || 0)) return;
      Object.assign(this.note, fresh);
      if (fresh.notebookId !== this.notebook?.id) { // la movieron a otra carpeta o materia desde otro dispositivo
        this.notebook = (await db.get('notebooks', fresh.notebookId)) || null;
        this._applyNotebookUi();
      }
      this.titleInput.value = fresh.title || '';
      this.undoStack = [];
      this.redoStack = [];
      this.renderBlocks();
      this._syncUndo();
      toast('Nota actualizada desde otro dispositivo');
    };
    store.bus.addEventListener('change', this._onRemote);
    // Clase en vivo: la compu maneja el minuto y esta nota lo sigue.
    this._onLive = async (e) => {
      const st = e.detail;
      if (!this._isMine(st)) return;
      if (!this.video) { if (!st.playing) return; await this.openVideo({ quiet: true }); }
      this._followLive(st);
    };
    store.bus.addEventListener('live', this._onLive);
    if (!this.note.blocks.length) this.addBlock('text');
    await this._moveTextImagesToSheets();
    this._mergeTextIntoEmptySheet();
    // Nota vacía en la compu: el cursor queda en el texto, listo para escribir.
    const first = this.note.blocks[0];
    const empty = !store.noteText(this.note) && !this.note.blocks.some((b) => b.strokes?.length || b.photos?.length);
    if (!navigator.maxTouchPoints && tools.tool === 'none' && (first?.type === 'text' || store.isPlainSheet(first)) && empty) {
      this.blocksEl.querySelector('.text-block')?.focus();
    }
  }

  destroy() {
    this.save.flush();
    // Si la nota cambió, se re-resume en segundo plano para la pestaña Resumen
    // (las notas personales no tienen resumen: no se mandan a la IA).
    if (this.dirty && !this.personal) {
      const id = this.note.id;
      const materia = this.notebook?.name || '';
      setTimeout(async () => {
        const n = await db.get('notes', id);
        if (n && noteNeedsSummary(n)) summarizeInBackground(n, materia);
      }, 1500);
    }
    if (this.recorder.active) this.recorder.stop().then((r) => r && this._addRecording(r));
    this.player?.destroy();
    this.video?.destroy();
    for (const s of this.sheets.values()) s.destroy();
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('visibilitychange', this._onVis);
    document.removeEventListener('pointerdown', this._onPen, true);
    document.removeEventListener('paste', this._onPaste, true);
    this.scroller.removeEventListener('dragover', this._onDragOver);
    this.scroller.removeEventListener('drop', this._onDrop);
    store.bus.removeEventListener('change', this._onRemote);
    store.bus.removeEventListener('live', this._onLive);
  }

  _inText(el) {
    return el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  async _save() {
    const n = this.note;
    const copy = { ...n, blocks: n.blocks.map((b) => (b.type === 'ink' ? { ...b, strokes: serializeStrokes(b.strokes) } : b)) };
    await store.saveNote(copy);
    n.updatedAt = copy.updatedAt;
    n._mod = copy._mod;
    this.dirty = true;
  }

  persistTools() {
    db.setSetting('tools', { ...tools });
  }

  // ---------- Barra de herramientas ----------
  renderToolbar() {
    const t = tools;
    const mode = t.tool === 'none' ? 'text' : 'ink';
    const seg = h('div.segmented',
      h(`button${mode === 'text' ? '.active' : ''}`, { type: 'button', onclick: () => this.setTool('none') }, icon('text'), h('span', 'Texto')),
      h(`button${mode === 'ink' ? '.active' : ''}`, { type: 'button', onclick: () => this.setTool(this.lastInkTool || 'pen') }, icon('pen'), h('span', 'Lápiz')));

    let group;
    if (mode === 'text') {
      const fmt = (cmd, arg) => (e) => { e.preventDefault(); document.execCommand(cmd, false, arg); this._afterFormat(); };
      const keep = (e) => e.preventDefault(); // no perder la selección al tocar un botón
      group = h('div.tool-group',
        h('button.tbtn.style-btn', { type: 'button', onmousedown: keep, onclick: (e) => this.styleMenu(e.currentTarget) }, 'Aa'),
        h('button.tbtn', { type: 'button', title: 'Negrita', onmousedown: keep, onclick: fmt('bold') }, h('b', 'B')),
        h('button.tbtn', { type: 'button', title: 'Cursiva', onmousedown: keep, onclick: fmt('italic') }, h('i', 'I')),
        h('button.tbtn', { type: 'button', title: 'Subrayado', onmousedown: keep, onclick: fmt('underline') }, h('u', 'U')),
        h('button.tbtn', { type: 'button', title: 'Tachado', onmousedown: keep, onclick: fmt('strikeThrough') }, h('s', 'S')),
        h('button.tbtn', { type: 'button', title: 'Resaltar', onmousedown: keep, onclick: fmt('hiliteColor', '#fff3a3') }, h('span.hl-sample', 'ab')),
        h('div.vsep'),
        h('button.tbtn', { type: 'button', title: 'Lista de verificación', onmousedown: keep, onclick: (e) => { e.preventDefault(); this.checklist(); } }, icon('checklist')),
        h('button.tbtn', { type: 'button', title: 'Viñetas', onmousedown: keep, onclick: fmt('insertUnorderedList') }, icon('list')),
        h('button.tbtn', { type: 'button', title: 'Numerada', onmousedown: keep, onclick: fmt('insertOrderedList') }, icon('numlist')),
        h('button.tbtn', { type: 'button', title: 'Tabla', onmousedown: keep, onclick: (e) => { e.preventDefault(); this.insertTable(); } }, icon('table')));
    } else {
      const toolBtn = (name, ic, title) => h(`button.tbtn${t.tool === name ? '.active' : ''}`, { type: 'button', title, onclick: () => this.setTool(name) }, icon(ic));
      const colors = t.tool === 'highlighter' ? HL_COLORS : PEN_COLORS;
      const current = t.tool === 'highlighter' ? t.highlighterColor : t.color;
      const colorBtns = (t.tool === 'pen' || t.tool === 'highlighter' || t.tool === 'lasso')
        ? h('div.swatches', colors.map((c) => h(`button.swatch${c === current ? '.active' : ''}`, {
          type: 'button',
          style: { background: c },
          'aria-label': `Color ${c}`,
          onclick: () => this.setColor(c),
        })), h('label.swatch.custom', { title: 'Otro color' }, h('input', { type: 'color', value: current, oninput: (e) => this.setColor(e.target.value) })))
        : null;
      const sizes = t.tool === 'pen'
        ? h('div.sizes', PEN_SIZES.map((s) => h(`button.size${Math.abs(t.size - s) < 0.01 ? '.active' : ''}`, { type: 'button', onclick: () => { t.size = s; this.persistTools(); this.renderToolbar(); } }, h('span', { style: { width: `${s * 2.2}px`, height: `${s * 2.2}px` } }))))
        : t.tool === 'highlighter'
          ? h('div.sizes', [14, 22, 34].map((s) => h(`button.size${t.highlighterSize === s ? '.active' : ''}`, { type: 'button', onclick: () => { t.highlighterSize = s; this.persistTools(); this.renderToolbar(); } }, h('span.hl', { style: { width: `${s / 1.6}px`, height: `${s / 1.6}px` } }))))
          : t.tool === 'eraser'
            ? h('div.sizes', [10, 18, 36].map((s) => h(`button.size${t.eraserSize === s ? '.active' : ''}`, { type: 'button', onclick: () => { t.eraserSize = s; this.persistTools(); this.renderToolbar(); } }, h('span.er', { style: { width: `${s / 1.5}px`, height: `${s / 1.5}px` } }))))
            : null;
      group = h('div.tool-group',
        toolBtn('pen', 'pen', 'Lapicera'),
        toolBtn('highlighter', 'highlighter', 'Resaltador'),
        toolBtn('eraser', 'eraser', 'Goma (borra trazos enteros)'),
        toolBtn('lasso', 'lasso', 'Lazo: seleccionar y mover'),
        h('div.vsep'),
        colorBtns,
        sizes,
        h('div.vsep'),
        h(`button.tbtn.pen-only${t.penOnly ? '.active' : ''}`, {
          type: 'button',
          title: t.penOnly ? 'Sólo el lápiz escribe (el dedo desplaza; dos toques con el dedo vuelven a la herramienta anterior)' : 'El dedo también escribe',
          onclick: () => { t.penOnly = !t.penOnly; this.persistTools(); this.renderToolbar(); toast(t.penOnly ? 'Sólo lápiz: el dedo desplaza' : 'Ahora también podés escribir con el dedo'); },
        }, icon(t.penOnly ? 'pencilOnly' : 'hand')));
    }
    this.undoBtn = h('button.tbtn', { type: 'button', title: 'Deshacer', onclick: () => this.undo() }, icon('undo'));
    this.redoBtn = h('button.tbtn', { type: 'button', title: 'Rehacer', onclick: () => this.redo() }, icon('redo'));
    this.toolbar.replaceChildren(seg, group, h('div.spacer'), this.undoBtn, this.redoBtn);
    this.root.querySelector('.editor')?.classList.toggle('ink-mode', mode === 'ink');
    this._syncUndo();
  }

  setTool(name) {
    if (name !== 'none') {
      this.lastInkTool = name;
      if (tools.tool !== 'none' && tools.tool !== name) tools.prevTool = tools.tool;
    }
    if (name !== 'lasso') for (const s of this.sheets.values()) s.clearSelection();
    tools.tool = name;
    if (name !== 'none' && document.activeElement?.isContentEditable) document.activeElement.blur();
    this.persistTools();
    this.renderToolbar();
  }

  // Como el doble toque del Apple Pencil en Notas ("cambiar entre la herramienta
  // actual y la última usada"). Sin herramienta anterior, alterna con la goma.
  swapTool() {
    const cur = tools.tool;
    if (cur === 'none') return;
    const next = tools.prevTool && tools.prevTool !== cur && TOOL_NAMES[tools.prevTool] ? tools.prevTool : cur === 'eraser' ? 'pen' : 'eraser';
    this.setTool(next);
    this._toolHud?.remove();
    this._toolHud = toast(TOOL_NAMES[next], { ms: 1100 });
  }

  // Safari no les pasa a las páginas web el doble toque del Apple Pencil (es sólo
  // para apps nativas), así que el mismo gesto se hace con el dedo: dos toques
  // rápidos sobre la hoja. Sólo cuando el dedo no escribe ("sólo lápiz").
  _bindDoubleTap() {
    const fingers = new Set();
    let down = null;
    let lastTap = null;
    const sc = this.scroller;
    sc.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      fingers.add(e.pointerId);
      down = fingers.size === 1 && e.target.closest?.('.sheet') ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
      if (fingers.size > 1) lastTap = null;
    });
    sc.addEventListener('pointercancel', (e) => { fingers.delete(e.pointerId); down = null; lastTap = null; });
    sc.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      fingers.delete(e.pointerId);
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || fingers.size) return;
      if (tools.tool === 'none' || !tools.penOnly || (this.seekMode && this.playback)) { lastTap = null; return; }
      if (e.timeStamp - d.t > 300 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) { lastTap = null; return; }
      if (lastTap && d.t - lastTap.t < 400 && Math.hypot(d.x - lastTap.x, d.y - lastTap.y) < 40) {
        lastTap = null;
        this.swapTool();
        return;
      }
      lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    });
  }

  setColor(c) {
    if (tools.tool === 'highlighter') tools.highlighterColor = c;
    else tools.color = c;
    if (tools.tool === 'lasso' && this.activeSelection) this.activeSelection.recolorSelection(c);
    this.persistTools();
    this.renderToolbar();
  }

  _syncUndo() {
    if (this.undoBtn) this.undoBtn.disabled = !this.undoStack.length;
    if (this.redoBtn) this.redoBtn.disabled = !this.redoStack.length;
  }

  undo() { this._step(this.undoStack, this.redoStack, 'before'); }
  redo() { this._step(this.redoStack, this.undoStack, 'after'); }
  _step(from, to, key) {
    const op = from.pop();
    if (!op) return;
    to.push(op);
    if (op.kind === 'strokes') {
      const block = this.note.blocks.find((b) => b.id === op.blockId);
      const sheet = this.sheets.get(op.blockId);
      if (block && sheet) { block.strokes = op[key]; sheet.selection = null; sheet.render(); }
    } else if (op.kind === 'photos') {
      const block = this.note.blocks.find((b) => b.id === op.blockId);
      const sheet = this.sheets.get(op.blockId);
      if (block && sheet) { block.photos = op[key]; sheet.photoSel = null; this.onPhotoSelect(sheet, null); sheet.bgDirty = true; sheet.render(); }
    } else if (op.kind === 'blocks') {
      this.note.blocks = op[key];
      this.renderBlocks();
    }
    this._syncUndo();
    this.save();
  }

  // ---------- Bloques ----------
  renderBlocks() {
    for (const s of this.sheets.values()) s.destroy();
    this.sheets.clear();
    this.blocksEl.replaceChildren(...this.note.blocks.map((b) => this.renderBlock(b)));
  }

  // Lo que se hace con un texto editable (bloque suelto o capa de texto de una hoja).
  _bindText(el, b, { onInput = null, removable = false } = {}) {
    el.addEventListener('input', () => { b.html = el.innerHTML; this.save(); this._hideSidebarOnWrite(); onInput?.(); });
    // Tocar el texto para escribir con el teclado pasa la barra a "Texto" (negrita, listas…).
    el.addEventListener('focus', () => { if (tools.tool !== 'none') this.setTool('none'); });
    el.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text == null) return;
      e.preventDefault();
      document.execCommand('insertText', false, text);
    });
    el.addEventListener('click', (e) => {
      const ts = e.target.closest('.ts');
      if (ts) { e.preventDefault(); this.jumpTo(Number(ts.dataset.t)); return; }
      // Links (Zoom, videos, campus): se abren en otra pestaña con un toque.
      const a = e.target.closest('a[href]');
      if (a && /^https?:/i.test(a.getAttribute('href'))) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
      const li = e.target.closest('ul.checklist > li');
      if (li && e.offsetX < 26) {
        li.toggleAttribute('data-checked');
        b.html = el.innerHTML;
        this.save();
      }
    });
    if (removable) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !el.textContent && this.note.blocks.length > 1 && !el.querySelector('img,table')) {
          e.preventDefault();
          this.removeBlock(b.id, { confirm: false });
        }
      });
    }
  }

  // Capa de texto de una hoja de papel: lo tipeado va sobre los renglones y lo dibujado, encima.
  pageText(sheet) {
    const b = sheet.block;
    const first = store.isPlainSheet(b) && this.note.blocks.find(store.isPlainSheet) === b && !this.note.blocks.some((x) => x.type === 'text');
    const el = h('div.text-block.page-text', {
      contentEditable: 'true',
      spellcheck: true,
      dataset: { blockId: b.id, ...(first ? { placeholder: 'Escribí con el teclado o dibujá con el lápiz…' } : {}) },
      html: b.html || '',
    });
    this._bindText(el, b, { onInput: () => sheet.fitText() });
    // Con el lápiz elegido, el dedo desplaza (y el doble toque cambia de herramienta): no abre el teclado.
    // Para escribir con el teclado se elige "Texto"; ya en modo texto, tocar pone el cursor.
    el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && tools.tool !== 'none') e.preventDefault(); });
    return el;
  }

  // La hoja creció porque el texto llegó abajo.
  onSheetGrow() { this.save(); }

  renderBlock(b) {
    if (b.type === 'text') {
      const el = h('div.text-block', {
        contentEditable: 'true',
        spellcheck: true,
        dataset: { blockId: b.id, placeholder: this.note.blocks[0] === b ? 'Escribí con el teclado o con el lápiz (Scribble lo pasa a texto)…' : 'Texto' },
        html: b.html,
      });
      this._bindText(el, b, { removable: true });
      return h(`div.block.text.paper-${this._textPaper()}`, { dataset: { blockId: b.id } }, el);
    }
    const sheet = new InkSheet(b, this);
    this.sheets.set(b.id, sheet);
    const label = b.pdf ? `${b.pdf.name || 'PDF'} · pág. ${b.pdf.page}` : b.image ? (b.image.name || 'Imagen') : (PAPERS.find(([k]) => k === b.paper)?.[1] || 'Hoja');
    const menuBtn = h('button.block-menu', { type: 'button', onclick: (e) => this.blockMenu(e.currentTarget, b) }, label, icon('more'));
    return h('div.block.ink', { dataset: { blockId: b.id } }, menuBtn, sheet.el);
  }

  // El texto va sobre papel, con el mismo rayado que la hoja de la nota (o como una
  // página lisa, de documento, si la nota es sólo texto).
  _textPaper() {
    const sheet = this.note.blocks.find((x) => x.type === 'ink' && !x.pdf && !x.image);
    if (!sheet) return 'doc';
    return sheet.paper === 'cornell' || !sheet.paper ? 'lined' : sheet.paper;
  }
  _refreshTextPaper() {
    const cls = `paper-${this._textPaper()}`;
    for (const el of this.blocksEl.querySelectorAll('.block.text')) {
      el.className = `block text ${cls}`;
    }
  }

  _blocksOp(mutate) {
    const before = [...this.note.blocks];
    mutate();
    this.undoStack.push({ kind: 'blocks', before, after: [...this.note.blocks] });
    this.redoStack = [];
    this.renderBlocks();
    this._syncUndo();
    this.save();
  }

  addBlock(type, opts = {}) {
    const paper = this.note.blocks.filter((b) => b.type === 'ink' && !b.pdf).at(-1)?.paper;
    const block = type === 'text' ? store.newTextBlock() : store.newInkBlock({ paper: paper || 'lined', ...opts });
    this._blocksOp(() => { this.note.blocks = [...this.note.blocks, block]; });
    const el = this.blocksEl.querySelector(`[data-block-id="${block.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (type === 'text') setTimeout(() => el?.querySelector('.text-block')?.focus(), 250);
    else if (tools.tool === 'none') this.setTool(this.lastInkTool || 'pen');
    return block;
  }

  async removeBlock(id, { confirm = true } = {}) {
    const b = this.note.blocks.find((x) => x.id === id);
    if (confirm && b?.type === 'ink' && b.strokes.length && !(await confirmDialog('Eliminar hoja', 'Se borra la hoja con todo lo escrito. Podés deshacerlo.', { ok: 'Eliminar', danger: true }))) return;
    this._blocksOp(() => { this.note.blocks = this.note.blocks.filter((x) => x.id !== id); });
  }

  blockMenu(anchor, b) {
    const idx = this.note.blocks.indexOf(b);
    const move = (d) => this._blocksOp(() => {
      const arr = [...this.note.blocks];
      const [x] = arr.splice(idx, 1);
      arr.splice(Math.max(0, Math.min(arr.length, idx + d)), 0, x);
      this.note.blocks = arr;
    });
    popover(anchor, [
      ...(b.pdf || b.image ? [] : PAPERS.map(([k, label]) => ({ label, icon: 'sheet', active: b.paper === k, onClick: () => { b.paper = k; this.sheets.get(b.id).applyPaper(); this._refreshTextPaper(); this.save(); } }))),
      !b.pdf && !b.image && { label: 'Alargar hoja', icon: 'plus', onClick: () => { b.height += 700; this.sheets.get(b.id).layout(); this.save(); } },
      '-',
      idx > 0 && { label: 'Subir', onClick: () => move(-1) },
      idx < this.note.blocks.length - 1 && { label: 'Bajar', onClick: () => move(1) },
      { label: 'Limpiar hoja', icon: 'eraser', onClick: () => { const before = b.strokes; b.strokes = []; this.sheets.get(b.id).render(); this.onChange(b, before); } },
      { label: 'Eliminar hoja', icon: 'trash', danger: true, onClick: () => this.removeBlock(b.id) },
    ]);
  }

  styleMenu(anchor) {
    const apply = (tag) => { document.execCommand('formatBlock', false, tag); this._afterFormat(); };
    popover(anchor, [
      { label: 'Título', onClick: () => apply('h1') },
      { label: 'Encabezado', onClick: () => apply('h2') },
      { label: 'Subencabezado', onClick: () => apply('h3') },
      { label: 'Cuerpo', onClick: () => apply('p') },
      { label: 'Monoespaciado', onClick: () => apply('pre') },
      { label: 'Cita', onClick: () => apply('blockquote') },
    ]);
  }

  _afterFormat() {
    const el = document.activeElement?.closest?.('.text-block') || window.getSelection()?.anchorNode?.parentElement?.closest('.text-block');
    if (!el) return;
    const b = this.note.blocks.find((x) => x.id === el.dataset.blockId);
    if (b) { b.html = el.innerHTML; this.save(); }
  }

  checklist() {
    const sel = window.getSelection();
    const inList = sel?.anchorNode?.parentElement?.closest('ul');
    if (inList?.classList.contains('checklist')) {
      document.execCommand('insertUnorderedList');
    } else {
      if (!inList) document.execCommand('insertUnorderedList');
      const ul = window.getSelection()?.anchorNode?.parentElement?.closest('ul') || window.getSelection()?.anchorNode?.closest?.('ul');
      ul?.classList.add('checklist');
    }
    this._afterFormat();
  }

  insertTable() {
    const cells = (tag) => `<tr>${`<${tag}><br></${tag}>`.repeat(3)}</tr>`;
    document.execCommand('insertHTML', false, `<table class="note-table">${cells('th')}${cells('td')}${cells('td')}</table><p><br></p>`);
    this._afterFormat();
  }

  async insertImage() {
    const input = h('input', { type: 'file', accept: 'image/*,application/pdf' });
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.type === 'application/pdf') {
        const id = await importLocalFile(file, this.note.notebookId);
        await this.insertPdfPages(id, file.name);
        return;
      }
      await this.addPhoto(file);
    };
    input.click();
  }

  // ---------- Fotos dentro de la hoja (GoodNotes) ----------
  // La foto se pega en la hoja que se está viendo y se puede escribir encima.
  async addPhoto(file, { block: target = null, y = null } = {}) {
    let blob;
    try {
      blob = await downscale(file, 1600);
    } catch {
      toast('No se pudo leer la imagen', { error: true });
      return null;
    }
    const blobId = `img:${db.uid()}`;
    await db.put('blobs', { id: blobId, blob });
    const bmp = await imageBitmap(blobId);
    let sheet = target ? this.sheets.get(target.id) : this._visibleSheet();
    let block = sheet?.block;
    if (!block) {
      block = this.addBlock('ink');
      sheet = this.sheets.get(block.id);
    }
    const w = Math.min(store.PAPER_W * 0.7, bmp?.width || 600);
    const hgt = bmp ? (w * bmp.height) / bmp.width : w * 0.75;
    if (y == null) {
      // Arriba de lo que se ve de la hoja (con un margen), no al principio de todo.
      const r = sheet?.sheet.getBoundingClientRect();
      const top = r ? Math.max(0, (this.scroller.getBoundingClientRect().top - r.top) * (store.PAPER_W / r.width)) : 0;
      y = top + 60;
    }
    const ph = { id: db.uid('ph_'), blobId, x: Math.round((store.PAPER_W - w) / 2), y: Math.round(y), w: Math.round(w), h: Math.round(hgt) };
    const before = block.photos || [];
    block.photos = [...before, ph];
    sheet?.fitHeight(ph.y + ph.h);
    if (sheet) { sheet.bgDirty = true; sheet.render(); }
    this.onPhotosChange(block, before);
    // Queda seleccionada: se mueve, se cambia de tamaño, se recorta o se gira enseguida.
    if (sheet) {
      const was = this.lastInkTool; // "Lápiz" sigue volviendo a la herramienta de antes
      this.setTool('lasso');
      this.lastInkTool = was || 'pen';
      sheet.selectPhoto(ph);
    }
    return ph;
  }

  // Cambiar una foto = reemplazarla por una copia nueva (así el deshacer funciona).
  _updatePhoto(sheet, ph, patch) {
    const before = sheet.block.photos || [];
    const next = { ...ph, ...patch };
    sheet.block.photos = before.map((x) => (x === ph ? next : x));
    sheet.fitHeight(next.y + next.h);
    sheet.photoSel = next;
    sheet.bgDirty = true;
    sheet.render();
    this.onPhotosChange(sheet.block, before);
    this._renderSelectionBar();
    return next;
  }

  async rotatePhoto(sheet) {
    const ph = sheet.photoSel;
    if (!ph) return;
    // Un cuarto de vuelta: el marco se da vuelta alrededor de su centro (mismo tamaño en la hoja).
    const w = Math.min(ph.h, store.PAPER_W * 1.2);
    const h2 = (w * ph.w) / ph.h;
    const cx = ph.x + ph.w / 2;
    const cy = ph.y + ph.h / 2;
    this._updatePhoto(sheet, ph, { rot: ((ph.rot || 0) + 1) % 4, w: Math.round(w), h: Math.round(h2), x: Math.round(cx - w / 2), y: Math.max(0, Math.round(cy - h2 / 2)) });
  }

  // Recortar: se ve la foto entera con un marco que se arrastra de las esquinas y los lados.
  // El recorte no destruye la foto: se puede volver a abrir y agrandar.
  async cropPhoto(sheet) {
    const ph = sheet.photoSel;
    const bmp = ph && (await imageBitmap(ph.blobId));
    if (!bmp) { toast('No se pudo abrir la foto', { error: true }); return; }
    const rot = ((ph.rot || 0) % 4 + 4) % 4;
    const swap = rot % 2 === 1;
    const imgW = swap ? bmp.height : bmp.width; // la foto como se ve (girada)
    const imgH = swap ? bmp.width : bmp.height;
    const maxW = Math.min(560, window.innerWidth - 120);
    const k = Math.min(maxW / imgW, 380 / imgH);
    const cw = Math.max(40, Math.round(imgW * k));
    const ch = Math.max(40, Math.round(imgH * k));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = h('canvas.crop-canvas', { width: Math.round(cw * dpr), height: Math.round(ch * dpr), style: { width: `${cw}px`, height: `${ch}px` } });
    const ctx = canvas.getContext('2d');
    const full = { x: 0, y: 0, w: 1, h: 1 };
    // Marco en coordenadas de lo que se ve (0 a 1), a partir del recorte actual.
    let r = fromSource(ph.crop || full, rot);
    const MIN = 0.04;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate((rot * Math.PI) / 2);
      const dw = swap ? ch : cw;
      const dh = swap ? cw : ch;
      ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      const x = r.x * cw; const y = r.y * ch; const w = r.w * cw; const hh = r.h * ch;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, cw, y);
      ctx.fillRect(0, y + hh, cw, ch - y - hh);
      ctx.fillRect(0, y, x, hh);
      ctx.fillRect(x + w, y, cw - x - w, hh);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, hh);
      ctx.lineWidth = 0.6;
      for (const f of [1 / 3, 2 / 3]) { // tercios, como guía
        ctx.beginPath(); ctx.moveTo(x + w * f, y); ctx.lineTo(x + w * f, y + hh); ctx.moveTo(x, y + hh * f); ctx.lineTo(x + w, y + hh * f); ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 2;
      for (const [hx, hy] of handlePoints(r)) {
        ctx.beginPath(); ctx.arc(hx * cw, hy * ch, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    };

    let drag = null;
    // Los toques se escuchan en un marco más grande que la imagen: así las manijas de las
    // esquinas (que quedan medio afuera) se pueden agarrar bien, también con el dedo.
    const stage = h('div.crop-stage', canvas);
    const pos = (e) => { const b = canvas.getBoundingClientRect(); return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height]; };
    stage.addEventListener('pointerdown', (e) => {
      const [u, v] = pos(e);
      const reach = 18 / Math.min(cw, ch);
      let hit = null;
      let best = reach * reach;
      for (const [name, hx, hy] of handlePoints(r, true)) {
        const d = (hx - u) ** 2 + (hy - v) ** 2;
        if (d <= best) { best = d; hit = name; }
      }
      if (!hit && u > r.x && u < r.x + r.w && v > r.y && v < r.y + r.h) hit = 'move';
      if (!hit) return;
      drag = { hit, u, v, r: { ...r } };
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [u, v] = pos(e);
      const du = u - drag.u;
      const dv = v - drag.v;
      const o = drag.r;
      let x0 = o.x; let y0 = o.y; let x1 = o.x + o.w; let y1 = o.y + o.h;
      if (drag.hit === 'move') {
        const nx = Math.min(1 - o.w, Math.max(0, o.x + du));
        const ny = Math.min(1 - o.h, Math.max(0, o.y + dv));
        x0 = nx; x1 = nx + o.w; y0 = ny; y1 = ny + o.h;
      } else {
        if (drag.hit.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, o.x + du));
        if (drag.hit.includes('e')) x1 = Math.max(x0 + MIN, Math.min(1, o.x + o.w + du));
        if (drag.hit.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, o.y + dv));
        if (drag.hit.includes('s')) y1 = Math.max(y0 + MIN, Math.min(1, o.y + o.h + dv));
      }
      r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      draw();
    });
    const end = () => { drag = null; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    draw();

    const m = modal('Recortar foto', h('div.crop-box', stage, h('p.muted.crop-hint', 'Arrastrá las esquinas y los lados; el marco se mueve desde adentro.')), {
      actions: [
        { label: 'Cancelar', value: null },
        { label: 'Restablecer', onClick: () => { r = { ...full }; draw(); return false; } },
        { label: 'Recortar', primary: true, value: 'ok' },
      ],
      wide: true,
    });
    if ((await m.done) !== 'ok') return;
    const src = toSource(r, rot);
    const cur = ph.crop || full;
    if (Math.abs(src.x - cur.x) + Math.abs(src.y - cur.y) + Math.abs(src.w - cur.w) + Math.abs(src.h - cur.h) < 1e-4) return;
    const probe = { ...ph, crop: src };
    const g = photoGeom(probe, bmp);
    const aspect = swap ? g.sh / g.sw : g.sw / g.sh; // ancho / alto de lo que se ve
    const w = Math.min(ph.w, store.PAPER_W * 1.2);
    // Si el recorte es más "alto" que la hoja permite, se achica el ancho en vez de salir de la hoja.
    this._updatePhoto(sheet, ph, { crop: src, w: Math.round(w), h: Math.round(w / aspect) });
  }

  // La hoja que más se ve en pantalla.
  _visibleSheet() {
    const view = this.scroller.getBoundingClientRect();
    let best = null;
    let bestArea = 0;
    for (const s of this.sheets.values()) {
      if (s.block.image) continue; // las diapositivas ya ocupan toda la hoja
      const r = s.sheet.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top));
      if (area > bestArea) { bestArea = area; best = s; }
    }
    return best;
  }

  // Las notas hechas con el formato anterior tenían el texto arriba y una hoja aparte debajo.
  // Si la hoja todavía está vacía, el texto pasa a la hoja: una sola página para escribir y dibujar.
  _mergeTextIntoEmptySheet() {
    const [a, b] = this.note.blocks;
    if (this.note.blocks.length !== 2 || a?.type !== 'text' || !store.isPlainSheet(b)) return false;
    if (b.strokes?.length || b.photos?.length || (b.html || '').trim()) return false;
    const merged = { ...b, html: a.html || '' };
    this.note.blocks = [merged];
    this.renderBlocks();
    this.save();
    return true;
  }

  // Mismo cambio, a pedido, para cualquier nota: cada texto suelto pasa a la hoja que le sigue
  // (o a la anterior, si no hay otra). No se toca lo dibujado.
  mergeTextIntoSheets() {
    const blocks = this.note.blocks;
    const sheets = blocks.filter(store.isPlainSheet);
    if (!sheets.length || !blocks.some((x) => x.type === 'text')) { toast('No hay texto suelto para pasar a una hoja'); return; }
    const parts = new Map(sheets.map((x) => [x.id, { before: [], after: [] }]));
    blocks.forEach((x, i) => {
      if (x.type !== 'text') return;
      const next = blocks.slice(i + 1).find(store.isPlainSheet);
      const prev = [...blocks.slice(0, i)].reverse().find(store.isPlainSheet);
      if (next) parts.get(next.id).before.push(x.html || '');
      else parts.get(prev.id).after.push(x.html || '');
    });
    this._blocksOp(() => {
      this.note.blocks = blocks.filter((x) => x.type !== 'text').map((x) => {
        const p = parts.get(x.id);
        if (!p || (!p.before.length && !p.after.length)) return x;
        return { ...x, html: [...p.before, x.html || '', ...p.after].join('') };
      });
    });
    toast('El texto pasó a la hoja');
  }

  // Fotos que quedaron pegadas en el texto (versiones anteriores): pasan a la hoja.
  async _moveTextImagesToSheets() {
    let moved = 0;
    for (const tb of [...this.note.blocks]) {
      if (tb.type !== 'text' || !/<img[^>]+src="data:image/i.test(tb.html || '')) continue;
      const doc = new DOMParser().parseFromString(`<div>${tb.html}</div>`, 'text/html');
      const imgs = [...doc.querySelectorAll('img[src^="data:image"]')];
      const idx = this.note.blocks.indexOf(tb);
      let target = [...this.note.blocks.slice(0, idx)].reverse().find((b) => b.type === 'ink' && !b.image && !b.pdf)
        || this.note.blocks.slice(idx + 1).find((b) => b.type === 'ink' && !b.image && !b.pdf);
      if (!target) {
        target = store.newInkBlock({ paper: 'lined' });
        this.note.blocks.splice(idx, 0, target);
        this.renderBlocks();
      }
      for (const img of imgs) {
        const file = await (await fetch(img.src)).blob();
        const bottom = Math.max(0, ...(target.strokes || []).flatMap((st) => st.points.map((q) => q[1])), ...(target.photos || []).map((p) => p.y + p.h));
        await this.addPhoto(file, { block: target, y: bottom + 50 });
        const p = img.closest('p');
        if (p && !p.textContent.trim() && p.querySelectorAll('img').length === 1) p.remove(); else img.remove();
        moved++;
      }
      tb.html = doc.body.firstElementChild.innerHTML.replace(/^(<p><br><\/p>)+$/, '');
    }
    if (moved) {
      this.renderBlocks();
      this.save();
      toast(moved === 1 ? 'La foto pasó a la hoja: ya le podés escribir encima' : `${moved} fotos pasaron a la hoja`);
    }
  }

  async insertMaterial() {
    const files = (await db.all('files')).filter((f) => f.notebookId === this.note.notebookId && canOpen(f));
    const list = h('div.picker', files.length
      ? files.sort((a, b) => b.modified - a.modified).map((f) => h('button.picker-item', {
        type: 'button',
        onclick: async () => { m.close(); await this.insertPdfPages(f.id, f.name); },
      }, icon(isPdf(f) ? 'pdf' : 'file'), h('div', h('div', f.name), h('small', [f.section, f.module].filter(Boolean).join(' · ')))))
      : h('p.muted', 'No hay material de esta materia para abrir. Sincronizá el campus o importá un archivo desde "Foto".'));
    const m = modal('Anotar material de la materia', list, { wide: true });
  }

  async insertPdfPages(fileId, name) {
    toast('Preparando el material…');
    try {
      const f = await db.get('files', fileId);
      const blocks = await blocksFromFile(f, await downloadFile(fileId));
      this._blocksOp(() => { this.note.blocks = [...this.note.blocks, ...blocks]; });
      this.blocksEl.querySelector(`[data-block-id="${blocks[0].id}"]`)?.scrollIntoView({ behavior: 'smooth' });
      if (tools.tool === 'none') this.setTool(this.lastInkTool || 'pen');
      if (f && !f.seen) await db.put('files', { ...(await db.get('files', fileId)), seen: true });
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  _renderSelectionBar() {
    if (this.activePhoto?.photoSel) {
      const ps = this.activePhoto;
      this.selectionBar.hidden = false;
      this.selectionBar.replaceChildren(
        h('span', 'Foto: arrastrala para moverla; el punto azul cambia el tamaño'),
        h('button.btn.small', { type: 'button', onclick: () => this.cropPhoto(ps) }, icon('crop'), 'Recortar'),
        h('button.btn.small', { type: 'button', onclick: () => this.rotatePhoto(ps) }, icon('rotate'), 'Girar'),
        h('button.btn.small.danger', { type: 'button', onclick: () => ps.deletePhoto() }, icon('trash'), 'Borrar foto'),
        h('button.btn.small', { type: 'button', onclick: () => ps.selectPhoto(null) }, 'Listo'));
      return;
    }
    const sheet = this.activeSelection;
    this.selectionBar.hidden = !sheet;
    if (!sheet) return;
    this.selectionBar.replaceChildren(
      h('span', `${sheet.selection.set.size} trazo(s) seleccionados — arrastralos para mover`),
      h('button.btn.small', { type: 'button', onclick: () => sheet.duplicateSelection() }, 'Duplicar'),
      h('button.btn.small.danger', { type: 'button', onclick: () => sheet.deleteSelection() }, icon('trash'), 'Borrar'),
      h('button.btn.small', { type: 'button', onclick: () => sheet.clearSelection() }, 'Listo'));
  }

  // ---------- Audio (Notability) ----------
  async toggleRecording() {
    if (this.recorder.active) {
      const rec = await this.recorder.stop();
      this.recBtn.classList.remove('on');
      this.recBtn.replaceChildren(icon('mic'));
      clearInterval(this.recTimer);
      this.recTime.textContent = '';
      if (rec) await this._addRecording(rec);
      return;
    }
    try {
      await this.recorder.start();
    } catch (err) {
      toast(`No se pudo usar el micrófono: ${err.message}`, { error: true });
      return;
    }
    this.recBtn.classList.add('on');
    this.recBtn.replaceChildren(icon('stop'));
    this.recTimer = setInterval(() => { this.recTime.textContent = fmtDur(this.recorder.clock()?.time || 0); }, 500);
    toast('Grabando. Lo que escribas queda sincronizado con el audio.');
  }

  async _addRecording(rec) {
    const blobId = `rec:${rec.id}`;
    await db.put('blobs', { id: blobId, blob: rec.blob });
    this.note.recordings = [...(this.note.recordings || []), { id: rec.id, blobId, startedAt: rec.startedAt, duration: rec.duration }];
    await this._save();
    toast('Grabación guardada');
  }

  showRecordings(anchor) {
    const recs = this.note.recordings || [];
    if (!recs.length) { toast('Todavía no grabaste esta clase. Tocá el micrófono.'); return; }
    popover(anchor, recs.map((r, i) => ({
      label: `Grabación ${i + 1} — ${new Date(r.startedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
      hint: fmtDur(r.duration),
      icon: 'play',
      onClick: () => this.play(r),
    })));
  }

  async play(r) {
    const row = await db.get('blobs', r.blobId);
    if (!row) { toast('No se encontró el audio', { error: true }); return; }
    this.player?.destroy();
    this.player = new Player(row.blob, r, {
      onTime: (ms) => {
        this.playback = { recId: r.id, time: ms };
        for (const s of this.sheets.values()) s.render();
      },
      onClose: () => {
        this.playback = null;
        this.seekMode = false;
        this.playerBar.hidden = true;
        for (const s of this.sheets.values()) s.render();
      },
      onSeekMode: (on) => { this.seekMode = on; },
      onDelete: async () => {
        if (!(await confirmDialog('Borrar grabación', 'Se elimina el audio (lo escrito queda).', { ok: 'Borrar', danger: true }))) return false;
        this.note.recordings = this.note.recordings.filter((x) => x.id !== r.id);
        await db.del('blobs', r.blobId);
        await this._save();
        return true;
      },
    });
    this.playerBar.replaceChildren(this.player.el);
    this.playerBar.hidden = false;
    this.player.play();
  }

  // ---------- Ver la clase (grabación de Zoom o video descargado) ----------
  openVideo(opts) {
    if (this.video) return Promise.resolve(this.video);
    this._opening ||= this._openVideo(opts).finally(() => { this._opening = null; });
    return this._opening;
  }

  async _openVideo({ quiet = false } = {}) {
    const info = this.note.video || {};
    if (!info.url && !info.blobId && !quiet) {
      const url = await prompt('Link de la grabación (Zoom)', { placeholder: 'https://…zoom.us/rec/… — o dejalo vacío y cargá el video', ok: 'Abrir' }).catch(() => null);
      if (url === null) return null;
      if (url && /^https?:\/\//i.test(url)) info.url = url;
    }
    const typed = info.url && info.url !== this.note.video?.url;
    this.note.video = { ...info, open: true };
    if (typed) this.save(); // link nuevo: se guarda en la nota (el resto del panel no toca la nota)
    this.player?.destroy();
    this.player = null;
    this.playerBar.hidden = true;
    const pos = await db.getSetting(`videoPos:${this.note.id}`, null);
    this.video = new VideoSession(this.note, {
      pos,
      onChange: () => this.save(),
      onAnnounce: (st) => live.announce({
        ...st,
        noteId: this.note.id,
        notebookId: this.note.notebookId,
        title: this.note.title || this.notebook?.name || '',
        url: this.note.video?.url || null,
      }),
      onMark: (ms) => this.insertMark(ms),
      onTime: (ms) => {
        this.playback = { recId: 'video', time: ms };
        for (const s of this.sheets.values()) if (s.block.strokes?.some((st) => st.rec === 'video')) s.render();
      },
      onSeekMode: (on) => { this.seekMode = on; },
      onClose: () => {
        this.video = null;
        this.note.video = { ...this.note.video, open: false };
        this.playback = null;
        this.seekMode = false;
        this.videoBar.hidden = true;
        this.videoBar.replaceChildren();
        for (const s of this.sheets.values()) s.render();
      },
    });
    this.playback = { recId: 'video', time: this.video.time() };
    this.videoBar.replaceChildren(this.video.el);
    this.videoBar.hidden = false;
    await this.video.attachFile();
    // Si la clase ya está corriendo en otro dispositivo, arrancar en ese minuto.
    const st = live.current();
    if (st && this._isMine(st)) this._followLive(st);
    return this.video;
  }

  _isMine(st) {
    return st.noteId === this.note.id || (st.url && st.url === this.note.video?.url);
  }

  _followLive(st) {
    this.video?.applyRemote(st, { base: live.liveBase(st), time: live.liveTime(st) });
  }

  async jumpTo(ms) {
    if (!Number.isFinite(ms)) return;
    const v = this.video || (await this.openVideo({ quiet: true }));
    v?.seek(ms);
  }

  // "⏱ 12:34" en el texto: donde está el cursor, o al final de la nota.
  insertMark(ms) {
    const chip = `<span class="ts" contenteditable="false" data-t="${Math.round(ms)}">⏱ ${fmtClock(ms)}</span>&nbsp;`;
    const sel = document.getSelection();
    const inText = sel?.rangeCount && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('.text-block');
    if (inText) {
      document.execCommand('insertHTML', false, chip);
      return;
    }
    // Al final de la última hoja de papel (el texto va ahí) o, si no hay, de un texto suelto.
    let block = [...this.note.blocks].reverse().find((b) => b.type === 'text' || store.isPlainSheet(b));
    if (!block || (block.type === 'text' && this.note.blocks[this.note.blocks.length - 1] !== block)) {
      block = store.newTextBlock();
      this.note.blocks.push(block);
      this.blocksEl.append(this.renderBlock(block));
    }
    block.html = `${block.html || ''}<p>${chip}</p>`;
    const el = this.blocksEl.querySelector(`.text-block[data-block-id="${block.id}"]`);
    if (el) {
      el.innerHTML = block.html;
      this.sheets.get(block.id)?.fitText();
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el.lastElementChild || el);
      r.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    this.save();
  }

  // ---------- Exportar ----------
  exportPdf() {
    const printable = h('div.print-root',
      h('h1.print-title', this.note.title || (this.personal ? store.noteTitle(this.note, this.notebook) : this.titleInput.placeholder)),
      h('p.print-meta', `${this.notebook?.name || ''} · ${store.fmtDate(this.note.classDate)}`),
      this.note.blocks.map((b) => {
        if (b.type === 'text') return h('div.print-text', { html: b.html });
        const sheet = this.sheets.get(b.id);
        if (!(store.isPlainSheet(b) && (b.html || '').replace(/<[^>]+>/g, '').trim())) return h('img.print-sheet', { src: sheet.toDataURL() });
        // Hoja con texto tipeado: papel, texto y tinta en capas, como en pantalla.
        return h('div.print-page', { dataset: { paper: b.paper || 'lined' } },
          h('img.print-bg', { src: sheet.bgDataURL() }),
          h('div.text-block.page-text', { html: b.html }),
          h('img.print-ink', { src: sheet.inkDataURL() }));
      }));
    document.body.append(printable);
    document.body.classList.add('printing');
    const done = () => { printable.remove(); document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 100);
  }

  // Manda una copia de las hojas (como imágenes chicas) a la nube, para que se
  // puedan corregir desde afuera sin bajar todos los trazos.
  async sendForCorrection() {
    await this._save();
    const stamp = Date.now().toString(36);
    const pages = [];
    const texts = [];
    for (const b of this.note.blocks) {
      if (b.type === 'text') { if (b.html?.replace(/<[^>]+>/g, '').trim()) texts.push(b.html); continue; }
      if (store.isPlainSheet(b) && b.html?.replace(/<[^>]+>/g, '').trim()) texts.push(b.html);
      const sheet = this.sheets.get(b.id);
      if (!sheet) continue;
      const blob = await sheet.toJpeg();
      const id = `corr:${this.note.id}:${stamp}:${pages.length + 1}`;
      await db.put('blobs', { id, blob });
      pages.push(id);
    }
    for (const old of this.note.correction?.pages || []) await db.del('blobs', old).catch(() => {});
    this.note.correction = { at: Date.now(), pages, texts, title: this.note.title };
    await this._save();
    toast(`Enviado a corregir: ${pages.length} hoja(s). Cuando termine de subir, avisale a Claude.`);
    // Subir ya (si la sincronización está configurada; si no, no molestar pidiendo la clave).
    if (await db.getSetting('appKey', '')) import('../sync.js').then((s) => s.syncNow()).catch(() => {});
  }

  // Mover la nota a una carpeta personal o a una materia (lo de la nota viaja con ella).
  async moveTo() {
    const all = await store.listNotebooks();
    let folders = all.filter(store.isPersonal);
    // Sin carpetas todavía: se ofrece "Notas", que se crea recién si se elige.
    if (!folders.length) folders = [{ id: store.PERSONAL_DEFAULT_ID, name: 'Notas', color: '#8a8f98', kind: 'personal', create: true }];
    const subjects = all.filter((nb) => !store.isPersonal(nb) && (nb.status || 'cursando') !== 'pasada');
    const pick = async (nb) => {
      m.close();
      const target = nb.create ? await store.defaultPersonalFolder() : nb;
      this.note.notebookId = target.id;
      this.notebook = target;
      this._applyNotebookUi();
      this.save();
      await this.save.flush();
      store.emit('change', { type: 'note', id: this.note.id });
      toast(`Movida a ${store.isPersonal(target) ? 'Personal › ' : ''}${target.name}`);
    };
    const item = (nb) => h('button.picker-item', { type: 'button', disabled: nb.id === this.note.notebookId, onclick: () => pick(nb) },
      h('span.dot', { style: { background: nb.color || '#8a8f98' } }), h('div', h('div', nb.name), nb.id === this.note.notebookId ? h('small', 'está acá') : null));
    const m = modal('Mover a…', h('div.picker',
      h('h3.picker-title', 'Personal'), folders.map(item),
      subjects.length ? [h('h3.picker-title', 'Materias'), subjects.map(item)] : null));
  }

  moreMenu(anchor) {
    const n = this.note;
    popover(anchor, [
      { label: n.pinned ? 'Desfijar' : 'Fijar arriba', icon: 'pin', onClick: () => { n.pinned = !n.pinned; this.save(); } },
      { label: 'Exportar PDF / imprimir', icon: 'share', onClick: () => this.exportPdf() },
      this.note.blocks.some((x) => x.type === 'text') && this.note.blocks.some(store.isPlainSheet)
        ? { label: 'Pasar el texto a la hoja', icon: 'sheet', onClick: () => this.mergeTextIntoSheets() } : null,
      { label: this.personal ? 'Mover a otra carpeta o materia' : 'Mover a otra materia o a Personal', icon: 'notes', onClick: () => this.moveTo() },
      this.personal ? null : { label: 'Enviar a corregir', icon: 'check', onClick: () => this.sendForCorrection() },
      '-',
      { label: 'Eliminar nota', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDialog('Eliminar nota', 'Se borra la nota, sus hojas y grabaciones.', { ok: 'Eliminar', danger: true }))) return;
        this.save = Object.assign(() => {}, { flush: () => {} });
        await store.deleteNote(n.id);
        this.back();
      } },
    ]);
  }
}

export function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh ? `${hh}:` : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

async function downscale(file, max) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
}

// Geometría de una foto: recorte (proporciones de la original) y giro (cuartos de vuelta).
function photoGeom(ph, bmp) {
  const c = ph.crop || { x: 0, y: 0, w: 1, h: 1 };
  return { sx: c.x * bmp.width, sy: c.y * bmp.height, sw: c.w * bmp.width, sh: c.h * bmp.height, rot: (((ph.rot || 0) % 4) + 4) % 4 };
}
// Un rectángulo de la foto original (0 a 1) a lo que se ve una vez girada, y de vuelta.
function mapPoint(x, y, rot) { return [[x, y], [1 - y, x], [1 - x, 1 - y], [y, 1 - x]][rot]; }
function unmapPoint(u, v, rot) { return [[u, v], [v, 1 - u], [1 - u, 1 - v], [1 - v, u]][rot]; }
function boxOf(a, b) { return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) }; }
function fromSource(c, rot) { return boxOf(mapPoint(c.x, c.y, rot), mapPoint(c.x + c.w, c.y + c.h, rot)); }
function toSource(r, rot) { return boxOf(unmapPoint(r.x, r.y, rot), unmapPoint(r.x + r.w, r.y + r.h, rot)); }
// Las 8 manijas del marco de recorte (esquinas y puntos medios de los lados).
function handlePoints(r, named = false) {
  const xs = [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = [r.y, r.y + r.h / 2, r.y + r.h];
  const names = [['nw', 0, 0], ['n', 1, 0], ['ne', 2, 0], ['w', 0, 1], ['e', 2, 1], ['sw', 0, 2], ['s', 1, 2], ['se', 2, 2]];
  return names.map(([n, i, j]) => (named ? [n, xs[i], ys[j]] : [xs[i], ys[j]]));
}

const bitmaps = new Map();
function imageBitmap(blobId) {
  if (!bitmaps.has(blobId)) {
    bitmaps.set(blobId, db.get('blobs', blobId).then((row) => (row?.blob ? createImageBitmap(row.blob) : null)).catch(() => null));
  }
  return bitmaps.get(blobId);
}
