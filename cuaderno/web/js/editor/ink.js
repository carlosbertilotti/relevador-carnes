// Hoja de escritura a mano. Lo mejor de cada app:
//  - trazo con presión y suavizado (GoodNotes / Notability, vía perfect-freehand)
//  - resaltador que no se oscurece al superponerse (Saber)
//  - "sólo lápiz": el dedo desplaza, el Apple Pencil escribe (GoodNotes)
//  - mantener el lápiz quieto al final convierte el trazo en línea recta (GoodNotes)
//  - hoja que crece sola al escribir abajo (Notability)
//  - lazo para seleccionar, mover, recolorear o borrar trazos (GoodNotes / Notability)
//  - trazos sincronizados con la grabación de audio (Notability)
//  - plantillas de hoja: rayada, cuadriculada, puntos, lisa y Cornell
import { getStroke } from '/vendor/perfect-freehand/index.mjs';
import { PAPER_W } from '../store.js';

const GROW_MARGIN = 160;
const GROW_STEP = 700;
const HOLD_TO_SNAP_MS = 550;

export const tools = {
  tool: 'pen', // pen | highlighter | eraser | lasso | none
  color: '#1c1c1e',
  size: 4,
  highlighterColor: '#ffd60a',
  highlighterSize: 22,
  eraserSize: 18,
  penOnly: false,
};

export function strokePath(stroke, last = true) {
  const pts = getStroke(stroke.points, {
    size: stroke.size,
    thinning: stroke.pressure === false ? 0.45 : 0.6,
    smoothing: 0.55,
    streamline: 0.45,
    simulatePressure: stroke.pressure === false,
    last,
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
  });
  const path = new Path2D();
  if (!pts.length) return path;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

function drawHighlighters(ctx, strokes, scale, alphaFor) {
  if (!strokes.length) return;
  const { width, height } = ctx.canvas;
  const off = new OffscreenCanvasOr(width, height);
  const octx = off.getContext('2d');
  // Agrupar por color y opacidad: dentro del grupo, los solapamientos no se acumulan.
  const groups = new Map();
  for (const s of strokes) {
    const a = alphaFor(s);
    const k = `${s.color}|${a}`;
    if (!groups.has(k)) groups.set(k, { color: s.color, alpha: a, list: [] });
    groups.get(k).list.push(s);
  }
  for (const g of groups.values()) {
    octx.clearRect(0, 0, width, height);
    octx.save();
    octx.scale(scale, scale);
    octx.strokeStyle = g.color;
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    for (const s of g.list) {
      octx.lineWidth = s.size;
      octx.beginPath();
      s.points.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
      if (s.points.length === 1) octx.lineTo(s.points[0][0] + 0.1, s.points[0][1]);
      octx.stroke();
    }
    octx.restore();
    ctx.save();
    ctx.globalAlpha = 0.38 * g.alpha;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }
}

function OffscreenCanvasOr(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function renderStrokes(ctx, strokes, scale, { alphaFor = () => 1, selected = null } = {}) {
  drawHighlighters(ctx, strokes.filter((s) => s.tool === 'highlighter'), scale, alphaFor);
  ctx.save();
  ctx.scale(scale, scale);
  for (const s of strokes) {
    if (s.tool === 'highlighter') continue;
    if (!s._path) s._path = strokePath(s);
    ctx.globalAlpha = alphaFor(s);
    ctx.fillStyle = s.color;
    ctx.fill(s._path);
    if (selected && selected.has(s)) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 3;
      ctx.stroke(s._path);
      ctx.restore();
    }
  }
  ctx.restore();
}

export function drawPaper(ctx, paper, heightUnits, scale, dark = false) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, width, height);
  ctx.scale(scale, scale);
  const line = dark ? '#c9d3e0' : '#d7dde6';
  const accent = '#f2b8b5';
  ctx.lineWidth = 1.2;
  const step = 42;
  if (paper === 'lined' || paper === 'cornell') {
    ctx.strokeStyle = line;
    for (let y = 120; y < heightUnits; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAPER_W, y); ctx.stroke();
    }
    ctx.strokeStyle = accent;
    const mx = paper === 'cornell' ? 290 : 90;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, heightUnits); ctx.stroke();
    if (paper === 'cornell') {
      const sy = heightUnits - 300;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(PAPER_W, sy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 100); ctx.lineTo(PAPER_W, 100); ctx.stroke();
      ctx.fillStyle = '#b8a9a9';
      ctx.font = '20px -apple-system, system-ui, sans-serif';
      ctx.fillText('Preguntas / ideas clave', 20, 130);
      ctx.fillText('Resumen', 20, sy + 32);
    }
  } else if (paper === 'grid') {
    ctx.strokeStyle = line;
    ctx.lineWidth = 0.9;
    for (let y = step; y < heightUnits; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAPER_W, y); ctx.stroke(); }
    for (let x = step; x < PAPER_W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, heightUnits); ctx.stroke(); }
  } else if (paper === 'dots') {
    ctx.fillStyle = '#b9c1cc';
    for (let y = step; y < heightUnits; y += step) {
      for (let x = step; x < PAPER_W; x += step) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  ctx.restore();
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function bbox(strokes) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s.points) {
    x0 = Math.min(x0, x - s.size / 2); y0 = Math.min(y0, y - s.size / 2);
    x1 = Math.max(x1, x + s.size / 2); y1 = Math.max(y1, y + s.size / 2);
  }
  return { x0, y0, x1, y1 };
}

// Una hoja. `host` provee: onChange(block, before), recordingClock(), playback, onSeek(t), renderBackground(ctx, scale)
export class InkSheet {
  constructor(block, host) {
    this.block = block;
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'ink-block';
    this.el.dataset.blockId = block.id;
    this.sheet = document.createElement('div');
    this.sheet.className = 'sheet';
    this.bg = document.createElement('canvas');
    this.ink = document.createElement('canvas');
    this.live = document.createElement('canvas');
    this.bg.className = 'layer bg';
    this.ink.className = 'layer ink';
    this.live.className = 'layer live';
    this.sheet.append(this.bg, this.ink, this.live);
    this.el.append(this.sheet);
    this.selection = null;
    this.current = null;
    this.scale = 1;
    this.dpr = 1;
    this.bgDirty = true;
    this._bind();
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.el);
  }

  destroy() {
    this.resizeObs.disconnect();
    clearTimeout(this.holdTimer);
  }

  layout() {
    const w = this.el.clientWidth;
    if (!w) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.scale = (w / PAPER_W) * this.dpr;
    const cssH = (w * this.block.height) / PAPER_W;
    this.sheet.style.height = `${cssH}px`;
    for (const c of [this.bg, this.ink, this.live]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(cssH * this.dpr);
    }
    this.bgDirty = true;
    this.render();
  }

  async renderBackground() {
    const ctx = this.bg.getContext('2d');
    this.bgDirty = false;
    if (this.block.image && this.host.renderImage) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, this.bg.width, this.bg.height);
      await this.host.renderImage(this.block.image, this.bg);
    } else if (this.block.pdf && this.host.renderPdf) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, this.bg.width, this.bg.height);
      await this.host.renderPdf(this.block.pdf, this.bg);
    } else {
      drawPaper(ctx, this.block.paper, this.block.height, this.scale);
    }
  }

  render() {
    if (this.bgDirty) this.renderBackground();
    const ctx = this.ink.getContext('2d');
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    const pb = this.host.playback;
    const alphaFor = pb
      ? (s) => (s.rec === pb.recId && s.t > pb.time ? 0.18 : 1)
      : () => 1;
    renderStrokes(ctx, this.block.strokes, this.scale, { alphaFor, selected: this.selection?.set });
    this.renderLive();
  }

  renderLive() {
    const ctx = this.live.getContext('2d');
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (this.current) {
      this.current._path = null; // el trazo en curso cambia en cada movimiento
      renderStrokes(ctx, [this.current], this.scale);
    }
    if (this.lassoPath) {
      ctx.save();
      ctx.scale(this.scale, this.scale);
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.lassoPath.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.restore();
    }
    if (this.selection) {
      const b = bbox([...this.selection.set]);
      ctx.save();
      ctx.scale(this.scale, this.scale);
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x0 - 8, b.y0 - 8, b.x1 - b.x0 + 16, b.y1 - b.y0 + 16);
      ctx.restore();
    }
  }

  toLocal(e) {
    const r = this.sheet.getBoundingClientRect();
    const k = PAPER_W / r.width;
    const pressure = e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 0.5;
    return [+((e.clientX - r.left) * k).toFixed(1), +((e.clientY - r.top) * k).toFixed(1), +pressure.toFixed(3)];
  }

  _bind() {
    const s = this.sheet;
    // En iPad: si toca el Apple Pencil, no desplazar la página; el dedo sí desplaza.
    s.addEventListener('touchstart', (e) => { if (this._isStylus(e) && tools.tool !== 'none') e.preventDefault(); }, { passive: false });
    s.addEventListener('touchmove', (e) => { if (this._isStylus(e) && tools.tool !== 'none') e.preventDefault(); }, { passive: false });
    s.addEventListener('pointerdown', (e) => this._down(e));
    s.addEventListener('pointermove', (e) => this._move(e));
    s.addEventListener('pointerup', (e) => this._up(e));
    s.addEventListener('pointercancel', (e) => this._up(e, true));
    s.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _isStylus(e) {
    return [...e.touches].some((t) => t.touchType === 'stylus');
  }

  _accepts(e) {
    if (tools.tool === 'none') return false;
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0;
    return !tools.penOnly; // dedo
  }

  _down(e) {
    if (this.host.seekMode && this.host.playback) {
      const t = this._strokeTimeAt(this.toLocal(e));
      if (t != null) { this.host.onSeek(t); e.preventDefault(); }
      return;
    }
    if (!this._accepts(e)) return;
    if (this.pointerId != null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    s_capture(this.sheet, e.pointerId);
    const p = this.toLocal(e);
    this.host.onActivate?.(this);

    if (tools.tool === 'lasso') {
      if (this.selection) {
        const b = bbox([...this.selection.set]);
        if (p[0] > b.x0 - 20 && p[0] < b.x1 + 20 && p[1] > b.y0 - 20 && p[1] < b.y1 + 20) {
          this.dragging = { from: p, before: [...this.block.strokes], moved: [...this.selection.set].map((st) => ({ st, pts: st.points })) };
          return;
        }
        this.clearSelection();
      }
      this.lassoPath = [p];
      return;
    }
    if (tools.tool === 'eraser') {
      this.erasing = { before: [...this.block.strokes], removed: false };
      this._eraseAt(p);
      return;
    }
    const hl = tools.tool === 'highlighter';
    const clock = this.host.recordingClock?.();
    this.current = {
      tool: tools.tool,
      color: hl ? tools.highlighterColor : tools.color,
      size: hl ? tools.highlighterSize : tools.size,
      pressure: e.pointerType === 'pen' ? undefined : false,
      points: [p],
      ...(clock ? { rec: clock.recId, t: clock.time } : {}),
    };
    this._armHold();
    this.renderLive();
  }

  _move(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const pts = (events.length ? events : [e]).map((ev) => this.toLocal(ev));
    const p = pts[pts.length - 1];
    if (this.dragging) {
      const dx = p[0] - this.dragging.from[0];
      const dy = p[1] - this.dragging.from[1];
      for (const m of this.dragging.moved) {
        m.st.points = m.pts.map(([x, y, pr]) => [x + dx, y + dy, pr]);
        m.st._path = null;
      }
      this.render();
      return;
    }
    if (this.lassoPath) { this.lassoPath.push(...pts); this.renderLive(); return; }
    if (this.erasing) { for (const q of pts) this._eraseAt(q); return; }
    if (!this.current || this.snapped) return;
    const last = this.current.points[this.current.points.length - 1];
    const fresh = pts.filter((q) => dist2(q, last) > 0.25);
    if (!fresh.length) return;
    this.current.points.push(...fresh);
    this._armHold();
    this.renderLive();
  }

  _up(e, cancelled = false) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    clearTimeout(this.holdTimer);
    if (this.dragging) {
      // Mover = reemplazar los trazos por copias nuevas (así el deshacer funciona).
      const before = this.dragging.before;
      const moved = new Map(this.dragging.moved.map((m) => [m.st, { ...m.st, _path: null }]));
      for (const m of this.dragging.moved) m.st.points = m.pts; // restaurar los originales en el "antes"
      this.block.strokes = this.block.strokes.map((st) => moved.get(st) || st);
      this.selection = { set: new Set(moved.values()) };
      this.dragging = null;
      this._commit(before);
      return;
    }
    if (this.lassoPath) {
      const poly = this.lassoPath;
      this.lassoPath = null;
      if (poly.length > 3) {
        const set = new Set(this.block.strokes.filter((st) => {
          const inside = st.points.filter((q) => pointInPoly(q, poly)).length;
          return inside / st.points.length > 0.5;
        }));
        this.selection = set.size ? { set } : null;
        this.host.onSelection?.(this, this.selection);
      }
      this.render();
      return;
    }
    if (this.erasing) {
      const { before, removed } = this.erasing;
      this.erasing = null;
      if (removed) this._commit(before);
      return;
    }
    if (this.current && !cancelled) {
      const before = [...this.block.strokes];
      this.current._path = null;
      this.block.strokes = [...this.block.strokes, this.current];
      this.current = null;
      this.snapped = false;
      this._maybeGrow();
      this._commit(before);
    } else {
      this.current = null;
      this.snapped = false;
      this.renderLive();
    }
  }

  _armHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      const c = this.current;
      if (!c || c.points.length < 6 || c.tool === 'eraser') return;
      const a = c.points[0];
      const b = c.points[c.points.length - 1];
      if (Math.sqrt(dist2(a, b)) < 40) return;
      const pr = c.points.reduce((acc, q) => acc + q[2], 0) / c.points.length;
      const n = 24;
      c.points = Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, pr]);
      c._path = null;
      this.snapped = true;
      this.renderLive();
    }, HOLD_TO_SNAP_MS);
  }

  _eraseAt(p) {
    const r2 = (tools.eraserSize) ** 2;
    const keep = this.block.strokes.filter((st) => !st.points.some((q) => dist2(q, p) <= r2 + (st.size / 2) ** 2));
    if (keep.length !== this.block.strokes.length) {
      this.block.strokes = keep;
      this.erasing.removed = true;
      this.render();
    }
  }

  _strokeTimeAt(p) {
    let best = null;
    let bestD = 30 ** 2;
    const rec = this.host.playback?.recId;
    for (const st of this.block.strokes) {
      if (st.t == null || (rec && st.rec !== rec)) continue;
      for (const q of st.points) {
        const d = dist2(q, p);
        if (d < bestD) { bestD = d; best = st; }
      }
    }
    return best ? best.t : null;
  }

  _maybeGrow() {
    if (this.block.pdf || this.block.image) return;
    const maxY = Math.max(...this.block.strokes.at(-1).points.map((q) => q[1]));
    if (maxY > this.block.height - GROW_MARGIN) {
      this.block.height += GROW_STEP;
      this.layout();
    }
  }

  _commit(before) {
    this.render();
    this.host.onChange(this.block, before);
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.host.onSelection?.(this, null);
    this.render();
  }

  deleteSelection() {
    if (!this.selection) return;
    const before = [...this.block.strokes];
    this.block.strokes = this.block.strokes.filter((st) => !this.selection.set.has(st));
    this.selection = null;
    this.host.onSelection?.(this, null);
    this._commit(before);
  }

  recolorSelection(color) {
    if (!this.selection) return;
    const before = [...this.block.strokes];
    const map = new Map([...this.selection.set].map((st) => [st, { ...st, color, _path: st._path }]));
    this.block.strokes = this.block.strokes.map((st) => map.get(st) || st);
    this.selection = { set: new Set(map.values()) };
    this._commit(before);
  }

  duplicateSelection() {
    if (!this.selection) return;
    const before = [...this.block.strokes];
    const copies = [...this.selection.set].map((st) => ({ ...st, _path: null, points: st.points.map(([x, y, pr]) => [x + 30, y + 30, pr]) }));
    this.block.strokes = [...this.block.strokes, ...copies];
    this.selection = { set: new Set(copies) };
    this._commit(before);
  }

  // Imagen de la hoja (fondo + tinta), para exportar o imprimir.
  toDataURL() {
    const c = document.createElement('canvas');
    c.width = this.ink.width;
    c.height = this.ink.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.bg, 0, 0);
    ctx.drawImage(this.ink, 0, 0);
    return c.toDataURL('image/png');
  }
}

function s_capture(el, id) {
  try { el.setPointerCapture(id); } catch { /* el puntero ya se soltó */ }
}

// Los trazos se guardan sin los Path2D cacheados.
export function serializeStrokes(strokes) {
  return strokes.map(({ _path, ...rest }) => rest);
}
