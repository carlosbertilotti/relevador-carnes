// Clase en vivo entre dispositivos: la compu mira la grabación y el iPad toma
// notas. El que maneja el video (▶, pausa, adelantar) avisa en qué minuto va;
// los demás siguen el mismo minuto sin tocar nada.
// El estado vive en Supabase (cuaderno_live_set / cuaderno_live_get) y la hora
// la pone el servidor, así no importa si los relojes de los equipos difieren.
import * as db from './db.js';
import { rpc, syncNow } from './sync.js';
import { emit } from './store.js';

const POLL_MS = 3000;
const STALE_MS = 6 * 3600 * 1000; // una clase pausada hace más de 6 h ya no cuenta

let deviceId = null;
let offset = 0; // hora local − hora del servidor
let last = null; // último estado visto
let polls = 0;

async function myId() {
  if (!deviceId) {
    deviceId = await db.getSetting('deviceId', null);
    if (!deviceId) { deviceId = db.uid('dev_'); await db.setSetting('deviceId', deviceId); }
  }
  return deviceId;
}

// Minuto de la clase ahora mismo, según el estado compartido.
export function liveTime(st, now = Date.now()) {
  if (!st) return 0;
  return st.playing ? st.pos + (now - offset - st.t0) : st.pos;
}

// Para el cronómetro local: Date.now() − base = minuto de la clase.
export function liveBase(st) {
  return st.t0 + offset - st.pos;
}

export async function announce(st) {
  const k = await db.getSetting('appKey', '');
  if (!k || !(await db.getSetting('syncEnabled', true))) return; // sin sincronización: nada que avisar
  try {
    const r = await rpc('cuaderno_live_set', { k, st: { ...st, from: await myId() } });
    if (r?.now) offset = Date.now() - r.now;
  } catch {
    // sin conexión: el video local sigue igual
  }
}

async function poll() {
  if (document.hidden || !navigator.onLine) return;
  const k = await db.getSetting('appKey', '');
  if (!k || !(await db.getSetting('syncEnabled', true))) return;
  let r;
  try {
    r = await rpc('cuaderno_live_get', { k });
  } catch {
    return;
  }
  if (!r) return;
  offset = Date.now() - r.now;
  const st = r.state;
  if (!st || (!st.playing && r.now - st.t0 > STALE_MS)) return;
  // Mientras hay clase, las notas se sincronizan más seguido (cada ~15 s).
  if (st.playing && ++polls % 5 === 0) syncNow().catch(() => {});
  if (st.from === (await myId())) { last = st; return; }
  if (last && last.t0 === st.t0 && last.from === st.from) return;
  const isNew = !last || last.noteId !== st.noteId || last.session !== st.session;
  last = st;
  emit('live', { ...st, isNew });
}

export function start() {
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}

export const current = () => last;
