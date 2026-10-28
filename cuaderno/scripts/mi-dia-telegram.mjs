// Manda "Mi día" de Cuaderno por Telegram como imagen: la agenda del día (campus y tareas con
// hora), qué leer, qué hacer, lo atrasado y un adelanto de mañana. Lo corre GitHub Actions todas
// las mañanas (.github/workflows/cuaderno-dia.yml): lee la nube de Cuaderno (Supabase) con la
// clave de servicio que ya usa el relevamiento y manda con el mismo bot, a un tema propio
// "Cuaderno" que el bot crea solo dentro de su grupo (el de tg_config.group_chat_id).
//
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   TELEGRAM_CUADERNO_CHAT_ID[/_THREAD_ID]  fija a mano a dónde manda
//   PLAYWRIGHT_MODULE / CHROME_PATH  para dibujar la imagen (si falla, manda texto)
//   DIA=AAAA-MM-DD   otro día en vez de hoy
//   DRY_RUN=1        imprime el texto (y con OUT=x.png guarda la imagen) sin mandar nada
//   FIXTURE=x.json   datos de prueba ({ todos, events, notebooks }) en vez de la nube
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const TZ = 'America/Argentina/Buenos_Aires'; // la facultad (Montevideo tiene la misma hora)
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MAX_LATE = 5;
const MAX_TOMORROW = 6;
const TG_LIMIT = 4000; // Telegram corta en 4096
const TOPIC = 'Cuaderno';
export const HINT = 'No encontré el grupo del bot para crear el tema "Cuaderno": por ahora llega acá.';

// ---------- Fechas (AAAA-MM-DD en la zona de la facultad) ----------
export const ymd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const hhmm = (ms) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const noon = (day) => new Date(`${day}T12:00:00Z`);
export function plusDays(day, n) { const d = noon(day); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const weekday = (day) => DAYS[noon(day).getUTCDay()];
export const longDate = (day) => { const d = noon(day); return `${weekday(day)} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`; };
const shortDate = (day) => { const d = noon(day); return `${weekday(day).slice(0, 3).toLowerCase()} ${d.getUTCDate()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// ---------- Datos ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shortName = (name) => String(name || '').replace(/\s*\[.*\]\s*$/, '');
export const fmtMinutes = (m) => { const hs = Math.floor(m / 60); const r = m % 60; return hs ? (r ? `${hs} h ${r} min` : `${hs} h`) : `${r} min`; };
const STOP = new Set(['para', 'clase', 'prof', 'desde', 'antes', 'entre', 'sobre', 'hasta', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'online']);
const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));

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

// "12:00 a 14:30 · Leadership Lab" → hora "12:00 a 14:30" y texto "Leadership Lab".
export function splitTime(title) {
  const m = /^((?:antes de las |desde las )?\d{1,2}:\d{2}(?:\s*(?:a|-|–)\s*\d{1,2}:\d{2})?)\s*·\s*(.+)$/i.exec(String(title || ''));
  return m ? { time: m[1], text: m[2] } : { time: null, text: String(title || '') };
}
const sortKey = (time) => { const m = /(\d{1,2}):(\d{2})/.exec(time || ''); const v = m ? Number(m[1]) * 60 + Number(m[2]) : 0; return /^antes/i.test(time || '') ? v - 0.5 : v; };

// Un evento del campus que ya está como tarea (misma hora y alguna palabra en común) no se repite.
function sameThing(ev, t) {
  const { time, text } = splitTime(t.title);
  if (!time || hhmm(ev.start) !== (/(\d{1,2}:\d{2})/.exec(time)?.[1] || '').padStart(5, '0')) return false;
  const a = words(ev.title);
  return words(text).some((w) => a.some((x) => x.startsWith(w) || w.startsWith(x))); // "entrega" ~ "entregar"
}

// El día armado en secciones; lo usan el texto y la imagen.
export function buildDay(raw, day) {
  const { todos, events, nbById } = normalize(raw);
  const tomorrow = plusDays(day, 1);
  const subject = (t) => { const nb = nbById.get(t.notebookId); return nb ? { name: shortName(nb.name), color: nb.color || '#8a8f98' } : null; };
  const item = (t) => { const { time, text } = splitTime(t.title); return { time, text, read: !!t.read, minutes: t.minutes || null, due: t.due, subject: subject(t) }; };
  const agendaOf = (d) => {
    const ofDay = todos.filter((t) => t.due === d);
    const evs = events
      .filter((e) => e && e.start && ymd(e.start) === d && !ofDay.some((t) => sameThing(e, t)))
      .map((e) => ({ time: e.allDay ? 'Todo el día' : hhmm(e.start), text: e.title, campus: true }));
    const timed = ofDay.filter((t) => !t.done && splitTime(t.title).time).map(item);
    return [...evs, ...timed].sort((a, b) => sortKey(a.time) - sortKey(b.time));
  };
  const pending = todos.filter((t) => !t.done);
  const untimed = (d) => pending.filter((t) => t.due === d && !splitTime(t.title).time);
  const reads = untimed(day).filter((t) => t.read).map(item);
  const late = pending.filter((t) => t.due && t.due < day);
  const nextItems = untimed(tomorrow).map(item);
  return {
    day,
    title: longDate(day),
    agenda: agendaOf(day),
    reads,
    readMinutes: reads.reduce((n, t) => n + (t.minutes || 0), 0),
    tasks: untimed(day).filter((t) => !t.read).map(item),
    late: late.slice(0, MAX_LATE).map(item),
    lateMore: Math.max(0, late.length - MAX_LATE),
    tomorrow: { day: tomorrow, label: shortDate(tomorrow), agenda: agendaOf(tomorrow), items: nextItems.slice(0, MAX_TOMORROW), more: Math.max(0, nextItems.length - MAX_TOMORROW) },
  };
}

// ---------- Texto (respaldo si la imagen no sale) ----------
export function buildMessage(raw, day, { hint = false } = {}) {
  const d = buildDay(raw, day);
  const line = (it, { withDue = false } = {}) => {
    const meta = [it.subject?.name, withDue && it.due ? shortDate(it.due) : null, it.minutes ? fmtMinutes(it.minutes) : null].filter(Boolean);
    return `• ${it.time ? `${esc(it.time)} · ` : ''}${it.read ? '📖 ' : ''}${esc(it.text)}${meta.length ? ` — <i>${esc(meta.join(' · '))}</i>` : ''}`;
  };
  const parts = [`📒 <b>${d.title}</b>`];
  if (d.agenda.length) parts.push(`🗓 <b>Agenda</b>\n${d.agenda.map((a) => line(a)).join('\n')}`);
  if (d.reads.length) parts.push(`📖 <b>Para leer</b>${d.readMinutes ? ` <i>(${fmtMinutes(d.readMinutes)})</i>` : ''}\n${d.reads.map((t) => line(t)).join('\n')}`);
  if (d.tasks.length) parts.push(`✅ <b>Para hacer</b>\n${d.tasks.map((t) => line(t)).join('\n')}`);
  if (!d.agenda.length && !d.reads.length && !d.tasks.length) parts.push('Nada pendiente para hoy. 🙌');
  if (d.late.length) parts.push(`⏰ <b>Atrasadas (${d.late.length + d.lateMore})</b>\n${d.late.map((t) => line(t, { withDue: true })).join('\n')}${d.lateMore ? `\n<i>… y ${d.lateMore} más en Tareas</i>` : ''}`);
  const tm = d.tomorrow;
  if (tm.agenda.length || tm.items.length) parts.push(`➡️ <b>Mañana, ${tm.label}</b>\n${[...tm.agenda, ...tm.items].map((t) => line(t)).join('\n')}${tm.more ? `\n<i>… y ${tm.more} más</i>` : ''}`);
  if (hint) parts.push(`<i>${HINT}</i>`);
  return parts.join('\n\n');
}

// Para acompañar la imagen: una línea con lo principal.
export function buildCaption(raw, day) {
  const d = buildDay(raw, day);
  const bits = [
    d.agenda.length ? `${d.agenda.length} en agenda` : null,
    d.reads.length ? `${d.reads.length} para leer` : null,
    d.tasks.length ? `${d.tasks.length} para hacer` : null,
    d.late.length ? `${d.late.length + d.lateMore} atrasada${d.late.length + d.lateMore === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return `📒 <b>${d.title}</b>${bits.length ? ` · ${bits.join(' · ')}` : ' · nada pendiente'}`;
}

// ---------- Imagen ----------
export function buildHtml(raw, day) {
  const d = buildDay(raw, day);
  const row = (it, { withDue = false } = {}) => {
    const meta = [withDue && it.due ? shortDate(it.due) : null, it.minutes ? fmtMinutes(it.minutes) : null].filter(Boolean).join(' · ');
    return `<li class="row${it.campus ? ' campus' : ''}${it.time ? '' : ' notime'}" style="--c:${esc(it.subject?.color || (it.campus ? '#2f6fde' : '#8a8f98'))}">
      ${it.time ? `<span class="time">${esc(it.time)}</span>` : ''}
      <span class="body"><span class="text">${it.read ? '<span class="tag">LEER</span>' : ''}${esc(it.text)}</span>
      ${it.subject || meta || it.campus ? `<span class="meta">${it.campus ? 'Campus' : ''}${it.subject ? `<i class="dot"></i>${esc(it.subject.name)}` : ''}${meta ? `<span class="sep">${esc(meta)}</span>` : ''}</span>` : ''}</span>
    </li>`;
  };
  const section = (title, items, opts = {}) => (items.length ? `<section class="${opts.cls || ''}"><h2>${title}${opts.note ? `<small>${esc(opts.note)}</small>` : ''}</h2><ul>${items.map((it) => row(it, opts)).join('')}</ul>${opts.more ? `<p class="more">… y ${opts.more} más</p>` : ''}</section>` : '');
  const tm = d.tomorrow;
  const empty = !d.agenda.length && !d.reads.length && !d.tasks.length;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    :root { --ink:#1c1c1e; --muted:#6b6b70; --line:#ececef; --accent:#9a6412; --late:#b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f1ea; font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", "DejaVu Sans", Arial, sans-serif; color: var(--ink); }
    #card { width: 720px; padding: 30px 34px 26px; background: #f4f1ea; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 34px; letter-spacing: -.02em; }
    header .brand { font-size: 15px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; }
    section { background: #fff; border-radius: 16px; padding: 14px 20px 8px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
    section.late h2 { color: var(--late); }
    section.next { background: #faf8f4; box-shadow: none; border: 1px dashed #ddd6c8; }
    h2 { margin: 0 0 6px; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; justify-content: space-between; }
    h2 small { font-size: 14px; text-transform: none; letter-spacing: 0; color: var(--accent); font-weight: 600; }
    ul { list-style: none; margin: 0; padding: 0; }
    .row { display: grid; grid-template-columns: 112px 1fr; gap: 12px; padding: 10px 0 10px 12px; border-top: 1px solid var(--line); border-left: 4px solid var(--c); margin-left: -20px; padding-left: 16px; }
    .row:first-child { border-top: 0; }
    .row.notime { grid-template-columns: 1fr; }
    .row.campus { --c: #2f6fde; }
    .time { font-weight: 700; font-size: 17px; font-variant-numeric: tabular-nums; color: var(--ink); line-height: 1.3; }
    .body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .text { font-size: 18px; line-height: 1.32; }
    .meta { font-size: 14px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); display: inline-block; }
    .sep::before { content: "·"; margin: 0 6px 0 2px; }
    .meta > .sep:first-child::before { content: none; margin: 0; }
    .tag { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #fff; background: var(--c); border-radius: 5px; padding: 2px 6px; margin-right: 8px; vertical-align: 2px; }
    .more { margin: 4px 0 8px; color: var(--muted); font-size: 14px; }
    .empty { font-size: 20px; padding: 18px 0 14px; }
  </style></head><body><div id="card">
    <header><h1>${esc(d.title)}</h1><span class="brand">Cuaderno · Mi día</span></header>
    ${section('Agenda', d.agenda)}
    ${section('Para leer', d.reads, { note: d.readMinutes ? fmtMinutes(d.readMinutes) : '' })}
    ${section('Para hacer', d.tasks)}
    ${empty ? '<section><p class="empty">Nada pendiente para hoy.</p></section>' : ''}
    ${section(`Atrasadas · ${d.late.length + d.lateMore}`, d.late, { cls: 'late', withDue: true, more: d.lateMore })}
    ${section(`Mañana, ${esc(tm.label)}`, [...tm.agenda, ...tm.items], { cls: 'next', more: tm.more })}
  </div></body></html>`;
}

export async function renderPng(html, env = process.env) {
  const mod = await import(env.PLAYWRIGHT_MODULE || 'playwright-core');
  const { chromium } = mod.chromium ? mod : mod.default;
  const browser = await chromium.launch(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : { channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 600 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    return await page.locator('#card').screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

// Ancho y alto de un PNG (para saber si Telegram lo acepta como foto).
export const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

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

// ---------- Nube y bot ----------
function supabase(env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY');
  const call = async (path, init = {}) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 || r.status === 201 ? null : r.json();
  };
  return {
    docs: (q) => call(`cuaderno_docs?${q}`),
    savedChat: async () => (await call('cuaderno_bot?id=eq.1&select=chat_id,thread_id,title'))[0] || null,
    saveChat: (c) => call('cuaderno_bot?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ id: 1, chat_id: String(c.id), thread_id: c.thread || null, title: c.title || null, updated_at: new Date().toISOString() }]) }),
    forgetChat: () => call('cuaderno_bot?id=eq.1', { method: 'DELETE' }),
    // El grupo del bot (con temas) que ya usan las otras apps; sólo se lee.
    botGroup: async () => (await call('tg_config?clave=eq.group_chat_id&select=valor'))[0]?.valor || null,
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
    const isForm = body instanceof FormData;
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: isForm ? undefined : { 'Content-Type': 'application/json' }, body: isForm ? body : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { const e = new Error(`Telegram ${r.status}: ${j.description || 'sin detalle'}`); e.status = r.status; e.migrateTo = j.parameters?.migrate_to_chat_id; throw e; }
    return j.result;
  };
  const where = (c) => ({ chat_id: c.id, ...(c.thread ? { message_thread_id: Number(c.thread) } : {}) });
  return {
    createTopic: (chatId, name) => call('createForumTopic', { chat_id: chatId, name, icon_color: 16766590 }),
    sendText: async (c, text) => { for (const part of chunk(text)) await call('sendMessage', { ...where(c), text: part, parse_mode: 'HTML', disable_web_page_preview: true }); },
    sendImage: async (c, png, caption) => {
      const { width, height } = pngSize(png);
      const asPhoto = width + height <= 10000 && height / width <= 20 && png.length < 10e6;
      const fd = new FormData();
      for (const [k, v] of Object.entries({ ...where(c), caption, parse_mode: 'HTML' })) fd.append(k, String(v));
      fd.append(asPhoto ? 'photo' : 'document', new Blob([png], { type: 'image/png' }), 'mi-dia.png');
      await call(asPhoto ? 'sendPhoto' : 'sendDocument', fd);
    },
  };
}

// A dónde manda: lo fijado a mano, el tema guardado, o un tema "Cuaderno" nuevo en el grupo del bot.
async function resolveChat(env, sb, tg) {
  if (env.TELEGRAM_CUADERNO_CHAT_ID) return { id: env.TELEGRAM_CUADERNO_CHAT_ID, thread: env.TELEGRAM_CUADERNO_THREAD_ID || null, own: true };
  const saved = await sb.savedChat().catch((err) => { console.warn(`No pude leer el tema guardado: ${err.message}`); return null; });
  if (saved) return { id: saved.chat_id, thread: saved.thread_id, title: saved.title, own: true, saved: true };
  const group = await sb.botGroup().catch((err) => { console.warn(`No pude leer el grupo del bot: ${err.message}`); return null; });
  if (group) {
    try {
      const topic = await tg.createTopic(group, TOPIC);
      const c = { id: group, thread: topic.message_thread_id, title: TOPIC, own: true, fresh: true };
      await sb.saveChat(c).catch((err) => console.warn(`No pude guardar el tema: ${err.message}`));
      return c;
    } catch (err) {
      console.warn(`No pude crear el tema "${TOPIC}" en el grupo del bot: ${err.message}`);
    }
  }
  if (!env.TELEGRAM_CHAT_ID) throw new Error('No hay a dónde mandar: ni tema de Cuaderno ni TELEGRAM_CHAT_ID');
  return { id: env.TELEGRAM_CHAT_ID, thread: null, own: false };
}

export async function main(env = process.env) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(env.DIA || '') ? env.DIA : ymd(Date.now());
  if (env.DRY_RUN) {
    const raw = env.FIXTURE ? JSON.parse(fs.readFileSync(env.FIXTURE, 'utf8')) : await fromCloud(supabase(env));
    const text = buildMessage(raw, day);
    console.log(text);
    if (env.OUT) { fs.writeFileSync(env.OUT, await renderPng(buildHtml(raw, day), env)); console.log(`\nImagen: ${env.OUT}`); }
    return text;
  }
  const sb = supabase(env);
  const tg = telegram(env);
  const raw = env.FIXTURE ? JSON.parse(fs.readFileSync(env.FIXTURE, 'utf8')) : await fromCloud(sb);
  let png = null;
  try { png = await renderPng(buildHtml(raw, day), env); } catch (err) { console.warn(`No pude dibujar la imagen (${err.message}); va como texto.`); }

  const deliver = async (c) => {
    if (c.fresh) await tg.sendText(c, '👋 Este es el tema de Cuaderno: acá llega "Mi día" cada mañana, con la agenda del campus, qué leer y qué hacer.');
    const caption = buildCaption(raw, day) + (c.own ? '' : `\n<i>${HINT}</i>`);
    if (png) await tg.sendImage(c, png, caption);
    else await tg.sendText(c, buildMessage(raw, day, { hint: !c.own }));
  };

  let chat = await resolveChat(env, sb, tg);
  try {
    await deliver(chat);
  } catch (err) {
    if (err.migrateTo) { // el grupo pasó a supergrupo y cambió de id
      chat = { ...chat, id: String(err.migrateTo) };
      if (chat.own) await sb.saveChat(chat).catch(() => {});
      await deliver(chat);
    } else if (chat.saved && [400, 403].includes(err.status)) {
      // Borraron el tema (o echaron al bot): se olvida y se arma de nuevo.
      console.warn(`El tema guardado no anda (${err.message}); armo uno nuevo.`);
      await sb.forgetChat().catch(() => {});
      chat = await resolveChat(env, sb, tg);
      await deliver(chat);
    } else if (chat.own && env.TELEGRAM_CHAT_ID && [400, 403].includes(err.status)) {
      console.warn(`No pude mandar al tema (${err.message}); va al chat de siempre.`);
      chat = { id: env.TELEGRAM_CHAT_ID, thread: null, own: false };
      await deliver(chat);
    } else {
      throw err;
    }
  }
  console.log(`Mi día del ${day} mandado ${png ? 'como imagen' : 'como texto'} ${chat.own ? 'al tema de Cuaderno' : 'al chat de siempre'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
