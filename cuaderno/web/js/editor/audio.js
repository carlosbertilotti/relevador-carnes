// Grabación de la clase sincronizada con lo que escribís (Notability):
// cada trazo guarda en qué segundo de la grabación se hizo. Al reproducir,
// lo que todavía "no se escribió" aparece tenue y tocando un trazo se salta
// a ese momento del audio.
import { h, icon } from '../ui.js';
import { uid } from '../db.js';

export class Recorder {
  get active() { return !!this.mr; }

  clock() {
    return this.mr ? { recId: this.id, time: Date.now() - this.startedAt } : null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('el navegador no permite grabar (¿la app está en https?)');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    this.mr = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined);
    this.chunks = [];
    this.mr.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.id = uid('rec_');
    this.startedAt = Date.now();
    this.mr.start(5000);
  }

  stop() {
    if (!this.mr) return Promise.resolve(null);
    const mr = this.mr;
    return new Promise((resolve) => {
      mr.onstop = () => {
        this.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: mr.mimeType || 'audio/webm' });
        const out = { id: this.id, blob, startedAt: this.startedAt, duration: Date.now() - this.startedAt };
        this.mr = null;
        resolve(out);
      };
      mr.stop();
    });
  }
}

export class Player {
  constructor(blob, rec, { onTime, onClose, onSeekMode, onDelete }) {
    this.url = URL.createObjectURL(blob);
    this.audio = new Audio(this.url);
    this.rec = rec;
    this.onTime = onTime;
    this.onClose = onClose;
    this.playBtn = h('button.icon-btn', { type: 'button', onclick: () => (this.audio.paused ? this.play() : this.audio.pause()) }, icon('pause'));
    this.range = h('input.range', { type: 'range', min: 0, max: Math.round(rec.duration / 1000), value: 0, oninput: () => this.seek(this.range.value * 1000) });
    this.time = h('span.player-time', '0:00');
    this.speed = 1;
    const speedBtn = h('button.btn.small', { type: 'button', onclick: () => {
      this.speed = this.speed === 1 ? 1.5 : this.speed === 1.5 ? 2 : 1;
      this.audio.playbackRate = this.speed;
      speedBtn.textContent = `${this.speed}×`;
    } }, '1×');
    const seekToggle = h('label.check', h('input', { type: 'checkbox', onchange: (e) => onSeekMode(e.target.checked) }), 'Tocar un trazo para ir a ese momento');
    this.el = h('div.player',
      this.playBtn,
      h('button.btn.small', { type: 'button', onclick: () => this.seek(Math.max(0, this.audio.currentTime * 1000 - 15000)) }, '−15 s'),
      this.range,
      this.time,
      speedBtn,
      seekToggle,
      h('button.icon-btn', { type: 'button', title: 'Borrar grabación', onclick: async () => { if (await onDelete()) this.destroy(); } }, icon('trash')),
      h('button.icon-btn', { type: 'button', title: 'Cerrar', onclick: () => this.destroy() }, icon('close')));
    this.audio.addEventListener('play', () => this.playBtn.replaceChildren(icon('pause')));
    this.audio.addEventListener('pause', () => this.playBtn.replaceChildren(icon('play')));
    this.audio.addEventListener('timeupdate', () => this.tick());
  }

  tick() {
    const ms = this.audio.currentTime * 1000;
    this.range.value = Math.round(ms / 1000);
    const s = Math.floor(ms / 1000);
    this.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.onTime(ms);
  }

  play() { this.audio.play().catch(() => {}); }

  seek(ms) {
    this.audio.currentTime = ms / 1000;
    this.tick();
    if (this.audio.paused) this.play();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.audio.pause();
    URL.revokeObjectURL(this.url);
    this.onClose();
  }
}
