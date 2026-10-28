// Manda "Mi día" de Cuaderno por Telegram: la agenda del campus, qué leer, qué hacer, lo
// atrasado y un adelanto de mañana. Lo corre GitHub Actions todas las mañanas
// (.github/workflows/cuaderno-dia.yml): lee la nube de Cuaderno (Supabase) con la clave de
// servicio que ya usa el relevamiento y manda con el mismo bot, a un grupo propio de Cuaderno.
//
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   TELEGRAM_CUADERNO_CHAT_ID  fija a mano el grupo (si no, el bot lo descubre solo; ver abajo)
//   DIA=AAAA-MM-DD   otro día en vez de hoy
//   DRY_RUN=1        imprime el mensaje en vez de mandarlo (sin tocar la red)
//   FIXTURE=x.json   datos de prueba ({ todos, events, notebooks }) en vez de la nube
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const TZ = 'America/Argentina/Buenos_Aires'; // la facultad (Montevideo tiene la misma hora)
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MAX_LATE = 5;
const MAX_TOMORROW = 6;
const TG_LIMIT = 4000; // Telegram corta en 4096
export const GROUP_RE = /cuaderno/i; // cómo se tiene que llamar el grupo para que el bot lo reconozca
export const GROUP_HINT = 'Para que esto llegue a un grupo propio: creá un grupo que se llame "Cuaderno" en Telegram, agregá al bot y escribí algo ahí. A la mañana siguiente empieza a mandar ahí.';

// ---------- Fechas (AAAA-MM-DD en la zona de la facultad) ----------
export const ymd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const hhmm = (ms) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const noon = (day) => new Date(`${day}T12:00:00Z`);
export function plusDays(day, n) { const d = noon(day); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const weekday = (day) => DAYS[noon(day).getUTCDay()];
const longDate = (day) => { const d = noon(day); return `${weekday(day)} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`; };
const shortDate = (day) => { const d = noon(day); return `${weekday(day).slice(0, 3).toLowerCase()} ${d.getUTCDate()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// ---------- Datos ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shortName = (name) => String(name || '').replace(/\s*\[.*\]\s*$/, '');
const fmtMinutes = (m) => { const hs = Math.floor(m / 60); const r = m % 60; return hs ? (r ? `${hs} h ${r} min` : `${hs} h`) : `${r} min`; };

// Las tareas viven en la nube como filas kv "todo:<id>" con { value: {...} }.
export function normalize({ todos, events, notebooks }) {
  const nbById = new Map((notebooks || []).map((r) => [r.id, r.data || {}]));
  const list = (todos || [])
    .filter((r) => String(r.id).startsWith('todo:') && r.data?.value && typeof r.data.value === 'object')
    .map((r) => ({ ...r.data.value, id: String(r.id).slice(5) }));
  list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));
  const evs = Array.isArray(events?.value) ? events.value : Array.isArray(events) ? events : [];
  return { todos: list, events: evs, nbById };
}

// ---------- Mensaje ----------
export function buildMessage(raw, day, { groupHint = false } = {}) {
  const { todos, events, nbById } = normalize(raw);
  const tomorrow = plusDays(day, 1);
  const pending = todos.filter((t) => !t.done);
  const line = (t, { withDue = false } = {}) => {
    const nb = nbById.get(t.notebookId);
    const meta = [nb ? shortName(nb.name) : null, withDue && t.due ? shortDate(t.due) : null, t.minutes ? fmtMinutes(t.minutes) : null].filter(Boolean);
    return `• ${t.read ? '📖 ' : ''}${esc(t.title)}${meta.length ? ` — <i>${esc(meta.join(' · '))}</i>` : ''}`;
  };
  const eventsOf = (d) => events
    .filter((e) => e && e.start && ymd(e.start) === d)
    .sort((a, b) => a.start - b.start)
    .map((e) => `• ${e.allDay ? 'Todo el día' : hhmm(e.start)} · ${esc(e.title)}`);

  const reads = pending.filter((t) => t.due === day && t.read);
  const tasks = pending.filter((t) => t.due === day && !t.read);
  const late = pending.filter((t) => t.due && t.due < day);
  const today = eventsOf(day);
  const next = pending.filter((t) => t.due === tomorrow);
  const nextEvents = eventsOf(tomorrow);

  // Primero la agenda del campus (clases, vencimientos), después lo que hay que leer y hacer.
  const parts = [`📒 <b>${longDate(day)}</b>`];
  if (today.length) parts.push(`🎓 <b>Campus</b>\n${today.join('\n')}`);
  if (reads.length) {
    const mins = reads.reduce((n, t) => n + (t.minutes || 0), 0);
    parts.push(`📖 <b>Para leer</b>${mins ? ` <i>(${fmtMinutes(mins)})</i>` : ''}\n${reads.map((t) => line(t)).join('\n')}`);
  }
  if (tasks.length) parts.push(`✅ <b>Para hacer</b>\n${tasks.map((t) => line(t)).join('\n')}`);
  if (!reads.length && !tasks.length && !today.length) parts.push('Nada pendiente para hoy. 🙌');
  if (late.length) {
    const extra = late.length > MAX_LATE ? `\n<i>… y ${late.length - MAX_LATE} más en Tareas</i>` : '';
    parts.push(`⏰ <b>Atrasadas (${late.length})</b>\n${late.slice(0, MAX_LATE).map((t) => line(t, { withDue: true })).join('\n')}${extra}`);
  }
  if (next.length || nextEvents.length) {
    const extra = next.length > MAX_TOMORROW ? `\n<i>… y ${next.length - MAX_TOMORROW} más</i>` : '';
    parts.push(`➡️ <b>Mañana, ${shortDate(tomorrow)}</b>\n${[...nextEvents, ...next.slice(0, MAX_TOMORROW).map((t) => line(t))].join('\n')}${extra}`);
  }
  if (groupHint) parts.push(`<i>${GROUP_HINT}</i>`);
  return parts.join('\n\n');
}

// Telegram acepta 4096 caracteres por mensaje: se corta en los saltos de línea.
export function chunk(text, limit = TG_LIMIT) {
  const out = [];
  let cur = '';
  for (const ln of text.split('\n')) {
    if (cur && cur.length + ln.length + 1 > limit) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${ln}` : ln;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- A dónde manda: el grupo "Cuaderno" ----------
// Un bot no puede crear grupos. Carlos crea uno que se llame "Cuaderno", agrega al bot y escribe
// algo; la próxima corrida lo encuentra entre las novedades del bot (getUpdates), lo guarda en
// Supabase (tabla cuaderno_bot) y de ahí en más manda ahí. Mientras no haya grupo, manda al chat
// del relevamiento con la nota de cómo armarlo.

// Entre las novedades del bot, el grupo "Cuaderno" más reciente al que lo agregaron o donde escribieron.
export function pickGroup(updates) {
  let best = null;
  for (const u of updates || []) {
    const chat = u.message?.chat || u.my_chat_member?.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type) || !GROUP_RE.test(chat.title || '')) continue;
    if (u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status)) continue;
    const date = u.message?.date || u.my_chat_member?.date || 0;
    if (!best || date >= best.date) best = { id: String(chat.id), title: chat.title, date };
  }
  return best;
}

// ---------- Nube y bot ----------
function supabase(env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY');
  const call = async (path, init = {}) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  };
  return {
    docs: (q) => call(`cuaderno_docs?${q}`),
    savedChat: async () => (await call('cuaderno_bot?id=eq.1&select=chat_id,title'))[0] || null,
    saveChat: (g) => call('cuaderno_bot?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ id: 1, chat_id: g.id, title: g.title || null, updated_at: new Date().toISOString() }]) }),
  };
}

async function fromCloud(sb) {
  const [kv, notebooks] = await Promise.all([
    sb.docs('store=eq.kv&deleted=is.false&select=id,data'),
    sb.docs('store=eq.notebooks&deleted=is.false&select=id,data'),
  ]);
  return { todos: kv.filter((r) => r.id.startsWith('todo:')), events: kv.find((r) => r.id === 'campusEvents')?.data || null, notebooks };
}

function telegram(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Falta TELEGRAM_BOT_TOKEN');
  const call = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { const e = new Error(`Telegram ${r.status}: ${j.description || 'sin detalle'}`); e.status = r.status; e.migrateTo = j.parameters?.migrate_to_chat_id; throw e; }
    return j.result;
  };
  return {
    updates: () => call('getUpdates', { allowed_updates: ['message', 'my_chat_member'], limit: 100 }),
    send: async (chatId, text) => { for (const part of chunk(text)) await call('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true }); },
  };
}

// El grupo fijado a mano, el guardado, o el que aparece entre las novedades del bot.
async function resolveChat(env, sb, tg) {
  if (env.TELEGRAM_CUADERNO_CHAT_ID) return { id: env.TELEGRAM_CUADERNO_CHAT_ID, group: true };
  const saved = await sb.savedChat().catch((err) => { console.warn(`No pude leer el grupo guardado: ${err.message}`); return null; });
  const found = await tg.updates().then(pickGroup).catch((err) => { console.warn(`No pude revisar las novedades del bot: ${err.message}`); return null; });
  if (found && found.id !== saved?.chat_id) {
    await sb.saveChat(found).catch((err) => console.warn(`No pude guardar el grupo: ${err.message}`));
    return { id: found.id, title: found.title, group: true, fresh: true };
  }
  if (saved) return { id: saved.chat_id, title: saved.title, group: true };
  if (!env.TELEGRAM_CHAT_ID) throw new Error('No hay grupo de Cuaderno ni TELEGRAM_CHAT_ID');
  return { id: env.TELEGRAM_CHAT_ID, group: false };
}

export async function main(env = process.env) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(env.DIA || '') ? env.DIA : ymd(Date.now());
  if (env.DRY_RUN) {
    const raw = env.FIXTURE ? JSON.parse(fs.readFileSync(env.FIXTURE, 'utf8')) : await fromCloud(supabase(env));
    const text = buildMessage(raw, day, { groupHint: !env.TELEGRAM_CUADERNO_CHAT_ID });
    console.log(text);
    return text;
  }
  const sb = supabase(env);
  const tg = telegram(env);
  const raw = env.FIXTURE ? JSON.parse(fs.readFileSync(env.FIXTURE, 'utf8')) : await fromCloud(sb);
  let chat = await resolveChat(env, sb, tg);
  const text = buildMessage(raw, day, { groupHint: !chat.group });
  const sendTo = async (c) => {
    try {
      if (c.fresh) await tg.send(c.id, '👋 Soy el bot de Cuaderno. A partir de ahora mando acá "Mi día" cada mañana: la agenda del campus, qué leer y qué hacer.');
      await tg.send(c.id, text);
    } catch (err) {
      if (err.migrateTo) { // el grupo pasó a supergrupo y cambió de id
        const moved = { id: String(err.migrateTo), title: c.title };
        await sb.saveChat(moved).catch(() => {});
        await tg.send(moved.id, text);
        return;
      }
      throw err;
    }
  };
  try {
    await sendTo(chat);
  } catch (err) {
    // Si el grupo ya no está (lo borraron o echaron al bot), que el mensaje igual llegue.
    if (!chat.group || !env.TELEGRAM_CHAT_ID || ![400, 403].includes(err.status)) throw err;
    console.warn(`No pude mandar al grupo (${err.message}); va al chat de siempre.`);
    chat = { id: env.TELEGRAM_CHAT_ID, group: false };
    await tg.send(chat.id, `${buildMessage(raw, day, { groupHint: true })}\n\n<i>(No pude mandar al grupo Cuaderno: ${esc(err.message)})</i>`);
  }
  console.log(`Mi día del ${day} mandado ${chat.group ? 'al grupo' : 'al chat de siempre'} (${text.length} caracteres)`);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
