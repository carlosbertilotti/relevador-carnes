// Vista semanal: clases, entregas y eventos. Tocar una clase abre su nota.
import * as store from '../store.js';
import { h, icon } from '../ui.js';
import { go } from '../router.js';

const HOUR_PX = 56;

export async function renderCalendar(root, { date } = {}) {
  const ref = date ? store.fromYmd(date) : new Date();
  const monday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - ((ref.getDay() + 6) % 7));
  const end = new Date(monday.getTime() + 7 * 86400000);
  const [items, notebooks] = await Promise.all([store.agenda(monday, end), store.listNotebooks()]);
  const nbById = new Map(notebooks.map((n) => [n.id, n]));

  const timed = items.filter((e) => !e.allDay);
  const minH = Math.min(8, ...timed.map((e) => new Date(e.start).getHours()));
  const maxH = Math.max(21, ...timed.map((e) => new Date(e.end).getHours() + 1));
  const days = Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  const todayKey = store.ymd();
  const nav = (d) => { const x = new Date(monday); x.setDate(x.getDate() + d); go(`/calendario/${store.ymd(x)}`); };

  const col = (d) => {
    const key = store.ymd(d);
    const dayItems = timed.filter((e) => store.ymd(e.start) === key);
    const allDay = items.filter((e) => e.allDay && store.ymd(e.start) === key);
    return h(`div.cal-col${key === todayKey ? '.today' : ''}`,
      h('div.cal-day', { onclick: () => go(`/hoy/${key}`) }, h('span', store.DAYS[d.getDay()].slice(0, 3)), h('strong', d.getDate())),
      h('div.cal-allday', allDay.map((e) => h('div.cal-chip', { title: e.title }, e.title))),
      h('div.cal-body', { style: { height: `${(maxH - minH) * HOUR_PX}px` } },
        layout(dayItems).map(({ ev, lane, lanes }) => {
          const nb = nbById.get(ev.notebookId);
          const s = new Date(ev.start);
          const top = ((s.getHours() - minH) + s.getMinutes() / 60) * HOUR_PX;
          const height = Math.max(22, ((ev.end - ev.start) / 3600000) * HOUR_PX - 2);
          return h(`button.cal-event.${ev.kind}`, {
            type: 'button',
            style: { top: `${top}px`, height: `${height}px`, left: `${(lane / lanes) * 100}%`, width: `${100 / lanes}%`, '--c': nb?.color || ev.color || '#8a8f98' },
            title: `${ev.title}${ev.location ? ` — ${ev.location}` : ''}`,
            onclick: async () => {
              if (ev.kind === 'clase' && nb) { const n = await store.noteForClass(nb.id, ev.start); go(`/nota/${n.id}`); }
              else if (ev.url) window.open(ev.url, '_blank');
              else go(`/hoy/${key}`);
            },
          }, height < 40
            ? h('strong', `${store.fmtTime(ev.start)} ${label(ev, nb)}`)
            : [h('strong', label(ev, nb)), h('span', `${store.fmtTime(ev.start)}${ev.location ? ` · ${ev.location}` : ''}`)]);
        })));
  };

  root.replaceChildren(h('div.page.calendar',
    h('header.page-head',
      h('div', h('p.eyebrow', 'Calendario'), h('h1', `Semana del ${store.fmtDate(monday)} al ${store.fmtDate(days[6])}`)),
      h('div.head-actions',
        h('button.icon-btn', { type: 'button', 'aria-label': 'Semana anterior', onclick: () => nav(-7) }, icon('back')),
        h('button.btn.small', { type: 'button', onclick: () => go('/calendario') }, 'Esta semana'),
        h('button.icon-btn.flip', { type: 'button', 'aria-label': 'Semana siguiente', onclick: () => nav(7) }, icon('back')))),
    items.length ? null : h('p.muted', 'No hay nada cargado esta semana. Agregá el horario de tus materias o suscribí un calendario desde "Campus y calendarios".'),
    h('div.cal-scroll',
      h('div.cal-grid',
        h('div.cal-hours',
          h('div.cal-day.spacer'), h('div.cal-allday'),
          h('div.cal-body', { style: { height: `${(maxH - minH) * HOUR_PX}px` } },
            Array.from({ length: maxH - minH }, (_, i) => h('span', { style: { top: `${i * HOUR_PX}px` } }, `${minH + i}:00`)))),
        days.map(col)))));

  // Llevar la vista al primer evento de la semana (o a la hora actual si es antes).
  const scroller = root.querySelector('.cal-scroll');
  const firstH = Math.min(new Date().getHours(), ...timed.map((e) => new Date(e.start).getHours()));
  if (scroller && firstH > minH) scroller.scrollTop = (firstH - minH - 0.5) * HOUR_PX;
}

const label = (ev, nb) => (ev.kind === 'clase' ? nb?.name || ev.title : ev.title);

// Reparte eventos superpuestos en carriles.
function layout(evs) {
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = [];
    for (const ev of cluster) {
      let lane = lanes.findIndex((end) => end <= ev.start);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = ev.end;
      out.push({ ev, lane, lanes: 0 });
    }
    for (const o of out.slice(-cluster.length)) o.lanes = lanes.length;
    cluster = [];
  };
  for (const ev of evs) {
    if (ev.start >= clusterEnd && cluster.length) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  if (cluster.length) flush();
  return out;
}
