// "Ver clase": tomar notas mirando la grabación de la clase.
//  - Grabación de Zoom (link del campus): Zoom no deja mostrarla dentro de otra
//    página, así que se abre en Zoom y Cuaderno lleva un cronómetro a la par.
//  - Video descargado (.mp4): se reproduce dentro de la nota.
// En los dos casos cada trazo y cada marca "⏱" guarda el minuto del video;
// tocando un trazo o una marca se vuelve a ese momento.
import * as db from '../db.js';
import { h, icon, toast, prompt } from '../ui.js';

export const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh ? `${hh}:` : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
};

export function parseClock(str) {
  const parts = String(str).trim().split(':').map((p) => Number(p));
  if (!parts.length || parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

export class VideoSession {
  // note.video: { url?, title?, blobId?, pos? }
  constructor(note, { onChange, onMark, onTime, onClose, onSeekMode, onAnnounce, pos }) {
    this.note = note;
    this.onChange = onChange;
    this.onMark = onMark;
    this.onTime = onTime;
    this.onClose = onClose;
    this.onSeekMode = onSeekMode;
    this.onAnnounce = onAnnounce;
    this.applying = 0; // mientras se aplica un cambio de otro dispositivo, no se reenvía
    this.seekMode = false;
    this.clockBase = null; // Date.now() - pos cuando el cronómetro corre
    this.pos = pos ?? note.video?.pos ?? 0;
    this.el = h('div.video-panel');
    this.render();
    this.tick = setInterval(() => this.paint(), 500);
  }

  get info() { return this.note.video || (this.note.video = {}); }
  get hasFile() { return !!this.videoEl; }

  running() {
    return this.videoEl ? !this.videoEl.paused : this.clockBase != null;
  }

  time() {
    if (this.videoEl) return this.videoEl.currentTime * 1000;
    return this.clockBase != null ? Date.now() - this.clockBase : this.pos;
  }

  // Reloj para los trazos: sólo mientras la clase corre o está pausada a mitad.
  clock() {
    if (!this.running() && this.time() === 0) return null;
    return { recId: 'video', time: Math.round(this.time()) };
  }

  play() {
    if (this.videoEl) { this.videoEl.play().catch(() => {}); return; }
    if (this.clockBase == null) this.clockBase = Date.now() - this.pos;
    this.paint();
    this.announce();
  }

  pause({ announce = true } = {}) {
    if (this.videoEl) { this.videoEl.pause(); return; }
    if (this.clockBase != null) { this.pos = Date.now() - this.clockBase; this.clockBase = null; }
    this.save();
    this.paint();
    if (announce) this.announce();
  }

  // Avisa a los otros dispositivos en qué minuto va la clase.
  announce() {
    if (Date.now() < this.applying) return;
    if (this.running()) this.session ||= `s${Date.now().toString(36)}`;
    this.onAnnounce?.({ playing: this.running(), pos: Math.round(this.time()), session: this.session || null });
  }

  // Sigue lo que hace otro dispositivo (la compu con la grabación).
  applyRemote(st, { base, time }) {
    this.applying = Date.now() + 1500;
    this.session = st.session || this.session;
    if (this.videoEl) {
      this.videoEl.muted = true; // el audio sale de la compu
      if (Math.abs(this.videoEl.currentTime * 1000 - time) > 1500) this.videoEl.currentTime = time / 1000;
      if (st.playing && this.videoEl.paused) this.videoEl.play().catch(() => {});
      if (!st.playing && !this.videoEl.paused) this.videoEl.pause();
    } else if (st.playing) {
      this.clockBase = base;
    } else {
      this.clockBase = null;
      this.pos = time;
    }
    this.following = true;
    this.followEl && (this.followEl.hidden = false);
    this.paint();
    this.onTime?.(this.time());
  }

  // Volver a un minuto desde una marca o un trazo: sólo en este dispositivo.
  // Los botones de la barra (±10 s, Ajustar) sí mueven la clase en todos.
  seek(ms, { announce = false } = {}) {
    ms = Math.max(0, ms);
    if (this.videoEl) {
      this.videoEl.currentTime = ms / 1000;
      this.videoEl.play().catch(() => {});
    } else {
      this.pos = ms;
      if (this.clockBase != null) this.clockBase = Date.now() - ms;
      if (!announce) toast(`Minuto ${fmtClock(ms)}: llevá la grabación de Zoom a ese momento`);
    }
    this.paint();
    this.onTime?.(this.time());
    if (announce) this.announce();
  }

  // El minuto se guarda sólo en este dispositivo: guardar la nota entera
  // pisaría lo que se está escribiendo en el otro (gana la última versión).
  save() {
    db.setSetting(`videoPos:${this.note.id}`, Math.round(this.time()));
  }

  openZoom() {
    if (!this.info.url) return;
    window.open(this.info.url, '_blank', 'noopener');
    if (!this.running()) toast('Cuando arranque el video en Zoom, tocá ▶ acá para que el cronómetro vaya a la par');
  }

  async loadFile(file) {
    const blobId = `vid:${db.uid()}`;
    await db.put('blobs', { id: blobId, blob: file });
    this.info.blobId = blobId;
    this.info.fileName = file.name;
    this.save();
    this.onChange?.();
    await this.attachFile();
    toast('Video cargado. Queda guardado sólo en este dispositivo (los videos son muy pesados para sincronizar).');
  }

  async attachFile() {
    if (!this.info.blobId) return false;
    const row = await db.get('blobs', this.info.blobId);
    if (!row?.blob) return false;
    this.url && URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(row.blob);
    this.render();
    this.videoEl.currentTime = (this.info.pos || 0) / 1000;
    return true;
  }

  render() {
    const hasFileHere = !!this.url;
    if (hasFileHere && this.videoEl?.dataset.src === this.url) {
      // mismo video: no se recrea (seguiría reproduciendo desde donde estaba)
    } else if (hasFileHere) {
      this.videoEl = h('video.class-video', { src: this.url, controls: true, playsInline: true, preload: 'metadata', dataset: { src: this.url } });
      this.videoEl.addEventListener('timeupdate', () => { this.paint(); this.onTime?.(this.time()); });
      this.videoEl.addEventListener('pause', () => { this.save(); this.announce(); });
      this.videoEl.addEventListener('play', () => this.announce());
      this.videoEl.addEventListener('seeked', () => this.announce());
    } else {
      this.videoEl = null;
    }
    this.timeEl = h('span.video-time');
    this.followEl = h('span.video-follow', { hidden: !this.following, title: 'El minuto lo maneja el otro dispositivo (la compu con la grabación)' }, '⇄ en vivo');
    this.playBtn = h('button.icon-btn', { type: 'button', title: 'Reproducir / pausar', onclick: () => (this.running() ? this.pause() : this.play()) }, icon('play'));
    const fileIn = h('input', { type: 'file', accept: 'video/*', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) this.loadFile(f); } });
    this.el.replaceChildren(
      this.videoEl,
      h('div.video-bar',
        h('strong.video-title', icon('video'), this.info.title || 'Grabación de la clase'),
        this.info.url ? h('button.btn.small', { type: 'button', onclick: () => this.openZoom() }, 'Abrir en Zoom') : null,
        hasFileHere ? null : this.playBtn,
        h('button.btn.small', { type: 'button', title: 'Atrás 10 segundos', onclick: () => this.seek(this.time() - 10000, { announce: true }) }, '−10 s'),
        this.timeEl,
        this.followEl,
        h('button.btn.small', { type: 'button', title: 'Adelante 10 segundos', onclick: () => this.seek(this.time() + 10000, { announce: true }) }, '+10 s'),
        hasFileHere ? null : h('button.btn.small', { type: 'button', title: 'Poner el cronómetro en el minuto que muestra Zoom', onclick: async () => {
          const v = await prompt('¿En qué minuto está la grabación?', { value: fmtClock(this.time()), placeholder: 'mm:ss', ok: 'Ajustar' });
          const ms = v && parseClock(v);
          if (ms != null) this.seek(ms, { announce: true });
        } }, 'Ajustar'),
        h(`button.btn.small${this.seekMode ? '.active' : ''}`, { type: 'button', title: 'Tocá un trazo para volver a ese minuto', onclick: () => { this.seekMode = !this.seekMode; this.onSeekMode?.(this.seekMode); this.render(); } }, this.seekMode ? 'Tocá un trazo…' : 'Ir a un trazo'),
        h('button.btn.small.primary', { type: 'button', title: 'Marcar este minuto en la nota', onmousedown: (e) => e.preventDefault(), onclick: () => this.onMark?.(Math.round(this.time())) }, '⏱ Marcar'),
        hasFileHere ? null : h('label.btn.small.ghost', { title: 'Si descargaste la grabación, se reproduce dentro de Cuaderno' }, 'Cargar video', fileIn),
        h('button.icon-btn', { type: 'button', title: 'Cerrar', onclick: () => this.close() }, icon('close'))));
    this.paint();
  }

  paint() {
    if (!this.timeEl) return;
    this.timeEl.textContent = fmtClock(this.time());
    this.timeEl.classList.toggle('on', this.running());
    if (this.playBtn && !this.videoEl) this.playBtn.replaceChildren(icon(this.running() ? 'pause' : 'play'));
    if (!this.videoEl && this.running()) this.onTime?.(this.time());
  }

  close() {
    this.pause();
    this.destroy();
    this.onClose?.();
  }

  destroy() {
    clearInterval(this.tick);
    if (this.clockBase != null) { this.pos = Date.now() - this.clockBase; this.clockBase = null; this.save(); }
    this.url && URL.revokeObjectURL(this.url);
  }
}
