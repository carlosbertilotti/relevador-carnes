// Editor de una nota de clase.
// Una nota es una columna de bloques: texto con formato (como Notas de Apple,
// donde además funciona Scribble: escribís con el lápiz y se convierte en
// texto) y hojas para escribir a mano o anotar sobre los PDFs del campus.
import * as db from '../db.js';
import * as store from '../store.js';
import { isPdf, importLocalFile } from '../campus.js';
import { h, icon, popover, toast, modal, confirmDialog, debounce } from '../ui.js';
import { InkSheet, tools, serializeStrokes } from './ink.js';
import { renderPdfPage, pageSizes } from './pdf.js';
import { Recorder, Player } from './audio.js';

const PEN_COLORS = ['#1c1c1e', '#2f6fde', '#d0342c', '#23915a', '#8e44c9', '#e98a15'];
const HL_COLORS = ['#ffd60a', '#7ee081', '#ff9fc6', '#7cc8ff', '#ffb35c'];
const PEN_SIZES = [2.5, 4, 7];
const PAPERS = [['lined', 'Rayada'], ['grid', 'Cuadriculada'], ['dots', 'Puntos'], ['blank', 'Lisa'], ['cornell', 'Cornell']];

export async function openEditor(root, noteId, { back }) {
  const note = await db.get('notes', noteId);
  if (!note) { root.replaceChildren(h('div.empty', 'La nota no existe.')); return () => {}; }
  const notebook = await db.get('notebooks', note.notebookId);
  const saved = await db.getSetting('tools', null);
  if (saved) Object.assign(tools, saved, { tool: saved.tool === 'none' ? 'none' : saved.tool });
  const ed = new Editor(root, note, notebook, back);
  await ed.mount();
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
    this.undoStack.push({ kind: 'strokes', blockId: block.id, before, after: block.strokes });
    this.redoStack = [];
    this._syncUndo();
    this.save();
  }
  recordingClock() { return this.recorder.clock(); }
  renderPdf(ref, canvas) { return renderPdfPage(ref, canvas); }
  onSeek(t) { this.player?.seek(t); }
  onActivate(sheet) {
    for (const s of this.sheets.values()) if (s !== sheet) s.clearSelection();
  }
  onSelection(sheet, sel) {
    this.activeSelection = sel ? sheet : null;
    this._renderSelectionBar();
  }

  async mount() {
    const n = this.note;
    this.titleInput = h('input.note-title', {
      value: n.title,
      placeholder: `${this.notebook?.name || 'Clase'} — ${store.fmtDate(n.classDate)}`,
      oninput: () => { n.title = this.titleInput.value; this.save(); },
    });
    this.dateInput = h('input.note-date', { type: 'date', value: n.classDate || '', onchange: () => { n.classDate = this.dateInput.value; this.save(); } });
    this.recBtn = h('button.icon-btn.rec', { type: 'button', title: 'Grabar la clase', onclick: () => this.toggleRecording() }, icon('mic'));
    this.recTime = h('span.rec-time');
    const header = h('header.editor-head',
      h('button.icon-btn', { type: 'button', 'aria-label': 'Volver', onclick: () => this.back() }, icon('back')),
      h('div.editor-titles',
        h('div.crumb', { style: { color: this.notebook?.color } }, this.notebook?.name || ''),
        this.titleInput),
      this.dateInput,
      h('div.spacer'),
      this.recTime,
      this.recBtn,
      h('button.icon-btn', { type: 'button', title: 'Grabaciones', onclick: (e) => this.showRecordings(e.currentTarget) }, icon('play')),
      h('button.icon-btn', { type: 'button', title: 'Exportar / imprimir', onclick: () => this.exportPdf() }, icon('share')),
      h('button.icon-btn', { type: 'button', title: 'Más', onclick: (e) => this.moreMenu(e.currentTarget) }, icon('more')));

    this.toolbar = h('div.toolbar');
    this.blocksEl = h('div.blocks');
    this.playerBar = h('div.player-bar', { hidden: true });
    this.selectionBar = h('div.selection-bar', { hidden: true });
    this.scroller = h('div.editor-scroll', this.blocksEl,
      h('div.add-row',
        h('button.btn.ghost', { type: 'button', onclick: () => this.addBlock('text') }, icon('text'), 'Texto'),
        h('button.btn.ghost', { type: 'button', onclick: () => this.addBlock('ink') }, icon('sheet'), 'Hoja'),
        h('button.btn.ghost', { type: 'button', onclick: () => this.insertMaterial() }, icon('pdf'), 'Material'),
        h('button.btn.ghost', { type: 'button', onclick: () => this.insertImage() }, icon('image'), 'Foto')));
    this.root.replaceChildren(h('div.editor', header, this.toolbar, this.selectionBar, this.scroller, this.playerBar));
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
    // Primer contacto con el Apple Pencil: activar "sólo lápiz" automáticamente.
    this._onPen = (e) => {
      if (e.pointerType === 'pen' && !tools.penOnly && !this._penAuto) {
        this._penAuto = true;
        tools.penOnly = true;
        this.persistTools();
        this.renderToolbar();
        toast('Lápiz detectado: el dedo ahora desplaza y el lápiz escribe');
      }
    };
    document.addEventListener('pointerdown', this._onPen, true);
    if (!this.note.blocks.length) this.addBlock('text');
  }

  destroy() {
    this.save.flush();
    if (this.recorder.active) this.recorder.stop().then((r) => r && this._addRecording(r));
    this.player?.destroy();
    for (const s of this.sheets.values()) s.destroy();
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('visibilitychange', this._onVis);
    document.removeEventListener('pointerdown', this._onPen, true);
  }

  _inText(el) {
    return el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  async _save() {
    const n = this.note;
    const copy = { ...n, blocks: n.blocks.map((b) => (b.type === 'ink' ? { ...b, strokes: serializeStrokes(b.strokes) } : b)) };
    await store.saveNote(copy);
    n.updatedAt = copy.updatedAt;
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
          title: t.penOnly ? 'Sólo el lápiz escribe (el dedo desplaza)' : 'El dedo también escribe',
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
    if (name !== 'none') this.lastInkTool = name;
    if (name !== 'lasso') for (const s of this.sheets.values()) s.clearSelection();
    tools.tool = name;
    if (name !== 'none' && document.activeElement?.isContentEditable) document.activeElement.blur();
    this.persistTools();
    this.renderToolbar();
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

  renderBlock(b) {
    if (b.type === 'text') {
      const el = h('div.text-block', {
        contentEditable: 'true',
        spellcheck: true,
        dataset: { blockId: b.id, placeholder: this.note.blocks[0] === b ? 'Empezá a escribir… (con el lápiz también: Scribble lo pasa a texto)' : 'Texto' },
        html: b.html,
      });
      el.addEventListener('input', () => { b.html = el.innerHTML; this.save(); });
      el.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text/plain');
        if (text == null) return;
        e.preventDefault();
        document.execCommand('insertText', false, text);
      });
      el.addEventListener('click', (e) => {
        const li = e.target.closest('ul.checklist > li');
        if (li && e.offsetX < 26) {
          li.toggleAttribute('data-checked');
          b.html = el.innerHTML;
          this.save();
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !el.textContent && this.note.blocks.length > 1 && !el.querySelector('img,table')) {
          e.preventDefault();
          this.removeBlock(b.id, { confirm: false });
        }
      });
      return h('div.block', { dataset: { blockId: b.id } }, el);
    }
    const sheet = new InkSheet(b, this);
    this.sheets.set(b.id, sheet);
    const label = b.pdf ? `${b.pdf.name || 'PDF'} · pág. ${b.pdf.page}` : (PAPERS.find(([k]) => k === b.paper)?.[1] || 'Hoja');
    const menuBtn = h('button.block-menu', { type: 'button', onclick: (e) => this.blockMenu(e.currentTarget, b) }, label, icon('more'));
    return h('div.block.ink', { dataset: { blockId: b.id } }, menuBtn, sheet.el);
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
      ...(b.pdf ? [] : PAPERS.map(([k, label]) => ({ label, icon: 'sheet', active: b.paper === k, onClick: () => { b.paper = k; this.sheets.get(b.id).bgDirty = true; this.sheets.get(b.id).render(); this.save(); } }))),
      !b.pdf && { label: 'Alargar hoja', icon: 'plus', onClick: () => { b.height += 700; this.sheets.get(b.id).layout(); this.save(); } },
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
      const url = await downscale(file, 1600);
      const last = this.note.blocks.at(-1);
      const target = last?.type === 'text' ? last : this.addBlock('text');
      target.html += `<p><img src="${url}" alt="${file.name.replace(/"/g, '')}"></p><p><br></p>`;
      this.renderBlocks();
      this.save();
    };
    input.click();
  }

  async insertMaterial() {
    const files = (await db.all('files')).filter((f) => f.notebookId === this.note.notebookId && f.downloaded && isPdf(f));
    const list = h('div.picker', files.length
      ? files.sort((a, b) => b.modified - a.modified).map((f) => h('button.picker-item', {
        type: 'button',
        onclick: async () => { m.close(); await this.insertPdfPages(f.id, f.name); },
      }, icon('pdf'), h('div', h('div', f.name), h('small', [f.section, f.module].filter(Boolean).join(' · ')))))
      : h('p.muted', 'No hay PDFs descargados de esta materia. Sincronizá el campus o importá un PDF desde "Foto".'));
    const m = modal('Anotar material de la materia', list, { wide: true });
  }

  async insertPdfPages(fileId, name) {
    toast('Preparando el PDF…');
    try {
      const sizes = await pageSizes(fileId);
      const blocks = sizes.map((s) => store.newInkBlock({
        height: Math.round((store.PAPER_W * s.height) / s.width),
        pdf: { fileId, page: s.page, name },
      }));
      this._blocksOp(() => { this.note.blocks = [...this.note.blocks, ...blocks]; });
      this.blocksEl.querySelector(`[data-block-id="${blocks[0].id}"]`)?.scrollIntoView({ behavior: 'smooth' });
      if (tools.tool === 'none') this.setTool(this.lastInkTool || 'pen');
      const f = await db.get('files', fileId);
      if (f && !f.seen) await db.put('files', { ...f, seen: true });
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  _renderSelectionBar() {
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

  // ---------- Exportar ----------
  exportPdf() {
    const printable = h('div.print-root',
      h('h1.print-title', this.note.title || this.titleInput.placeholder),
      h('p.print-meta', `${this.notebook?.name || ''} · ${store.fmtDate(this.note.classDate)}`),
      this.note.blocks.map((b) => (b.type === 'text'
        ? h('div.print-text', { html: b.html })
        : h('img.print-sheet', { src: this.sheets.get(b.id).toDataURL() }))));
    document.body.append(printable);
    document.body.classList.add('printing');
    const done = () => { printable.remove(); document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 100);
  }

  moreMenu(anchor) {
    const n = this.note;
    popover(anchor, [
      { label: n.pinned ? 'Desfijar' : 'Fijar arriba', icon: 'pin', onClick: () => { n.pinned = !n.pinned; this.save(); } },
      { label: 'Exportar PDF / imprimir', icon: 'share', onClick: () => this.exportPdf() },
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
  return c.toDataURL('image/jpeg', 0.85);
}
