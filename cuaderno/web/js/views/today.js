// "Mi día": las clases de hoy con su nota lista para abrir, lo nuevo del
// campus, las entregas que se vienen y las últimas notas.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { h, icon, toast } from '../ui.js';
import { go } from '../router.js';
import { showClassPlan, readingsSummary } from './classplan.js';

export async function renderToday(root, { date } = {}) {
  const day = date ? store.fromYmd(date) : new Date();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start.getTime() + 86400000);
  const isToday = store.ymd(start) === store.ymd(new Date());
  const [items, upcoming, notebooks, notes, files, acc] = await Promise.all([
    store.agenda(start, end),
    store.agenda(end, new Date(end.getTime() + 14 * 86400000)),
    store.listNotebooks(),
    db.all('notes'),
    db.all('files'),
    campus.account(),
  ]);
  const nbById = new Map(notebooks.map((n) => [n.id, n]));
  const classes = items.filter((e) => e.kind === 'clase');
  const others = items.filter((e) => e.kind !== 'clase');
  const deadlines = upcoming.filter((e) => e.kind === 'entrega').slice(0, 6);
  const fresh = files.filter((f) => !f.seen && !f.local).sort((a, b) => b.addedAt - a.addedAt).slice(0, 8);
  const recent = store.sortNotes(notes.slice()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);

  const shift = (d) => { const x = new Date(start); x.setDate(x.getDate() + d); go(`/hoy/${store.ymd(x)}`); };
  const now = Date.now();

  const classCard = (ev) => {
    const nb = nbById.get(ev.notebookId);
    const live = now >= ev.start && now <= ev.end;
    const existing = notes.find((n) => n.notebookId === ev.notebookId && n.classDate === store.ymd(ev.start));
    // Debajo de la clase: qué hay que leer (se completa solo).
    const reading = h('div.class-reading');
    if (nb) {
      readingsSummary(nb, ev).then((p) => {
        if (!p) return;
        const names = p.readings.map((f) => f.name.replace(/\.[^.]+$/, ''));
        reading.replaceChildren(
          h('span', p.n ? `Clase ${p.n}${p.total ? ` de ${p.total}` : ''}` : 'Esta clase', names.length ? ` · para leer: ${names.slice(0, 3).join(' · ')}${names.length > 3 ? ` (+${names.length - 3})` : ''}` : p.excerpt ? ' · ver lo que dice el programa' : ''),
          h('button.btn.small.ghost', { type: 'button', onclick: () => showClassPlan(ev, nb) }, icon('book'), 'Qué leer'));
      });
    }
    return h(`article.class-card${live ? '.live' : ''}`, { style: { '--c': nb?.color || '#8a8f98' } },
      h('div.class-time', h('strong', store.fmtTime(ev.start)), h('span', store.fmtTime(ev.end))),
      h('div.class-info',
        h('h3', nb?.name || ev.title),
        h('div.meta',
          ev.location ? h('span', icon('location'), ev.location) : null,
          live ? h('span.badge.live', 'En curso') : null,
          existing ? h('span.badge', 'Con notas') : null),
        reading),
      nb
        ? h('button.btn.primary', {
          type: 'button',
          onclick: async () => { const n = await store.noteForClass(nb.id, ev.start); go(`/nota/${n.id}`); },
        }, icon('compose'), existing ? 'Abrir notas' : 'Tomar notas')
        : null);
  };

  const eventRow = (ev) => {
    const nb = nbById.get(ev.notebookId);
    return h('li.event-row', { onclick: ev.url ? () => window.open(ev.url, '_blank') : null },
      h('span.dot', { style: { background: nb?.color || ev.color || '#8a8f98' } }),
      h('div', h('div', ev.title), h('small', [ev.allDay ? 'Todo el día' : `${store.DAYS[new Date(ev.start).getDay()].slice(0, 3)} ${store.fmtDate(ev.start)} · ${store.fmtTime(ev.start)}`, nb?.name].filter(Boolean).join(' · '))));
  };

  const empty = !notebooks.length;
  root.replaceChildren(h('div.page.today',
    h('header.page-head',
      h('div',
        h('p.eyebrow', isToday ? 'Hoy' : store.DAYS[start.getDay()]),
        h('h1', `${store.DAYS[start.getDay()]} ${start.getDate()} de ${start.toLocaleDateString('es-AR', { month: 'long' })}`)),
      h('div.head-actions',
        h('button.icon-btn', { type: 'button', 'aria-label': 'Día anterior', onclick: () => shift(-1) }, icon('back')),
        !isToday ? h('button.btn.small', { type: 'button', onclick: () => go('/hoy') }, 'Hoy') : null,
        h('button.icon-btn.flip', { type: 'button', 'aria-label': 'Día siguiente', onclick: () => shift(1) }, icon('back')))),

    empty ? h('section.card.onboarding',
      h('h2', 'Bienvenido a Cuaderno'),
      h('p', 'Conectá tu cuenta del Campus Virtual Di Tella y Cuaderno arma un cuaderno por materia, baja el material de cada clase y te muestra tu día.'),
      h('div.row',
        h('button.btn.primary', { type: 'button', onclick: () => go('/campus') }, icon('campus'), 'Conectar el campus'),
        h('button.btn', { type: 'button', onclick: async () => { const nb = await store.createNotebook({ name: 'Mi primera materia' }); go(`/cuaderno/${nb.id}`); } }, icon('plus'), 'Crear una materia a mano'))) : null,

    h('section',
      h('h2.section-title', 'Clases'),
      classes.length
        ? h('div.class-list', classes.map(classCard))
        : h('div.card.muted-card',
          h('p', notebooks.length ? 'No hay clases cargadas para este día.' : 'Todavía no hay materias.'),
          notebooks.length ? h('p.muted', 'Cargá el horario de cada materia (en la materia → Horario) o suscribí tu calendario en Campus y calendarios.') : null,
          notebooks.length ? h('div.row', notebooks.slice(0, 6).map((nb) => h('button.chip', {
            type: 'button',
            style: { '--c': nb.color },
            onclick: async () => { const n = await store.noteForClass(nb.id, start); go(`/nota/${n.id}`); },
          }, `Nota de ${nb.name}`))) : null)),

    others.length ? h('section', h('h2.section-title', 'También hoy'), h('ul.event-list', others.map(eventRow))) : null,

    h('div.grid-2',
      h('section.card',
        h('h2.section-title', 'Nuevo en el campus'),
        fresh.length
          ? h('ul.file-list', fresh.map((f) => {
            const nb = nbById.get(f.notebookId);
            return h('li', { onclick: () => go(`/cuaderno/${f.notebookId}/material`) },
              icon(campus.isPdf(f) ? 'pdf' : 'file'),
              h('div', h('div', f.name), h('small', [nb?.name, f.section].filter(Boolean).join(' · '))));
          }))
          : h('p.muted', acc ? `Nada nuevo. Última sincronización: ${acc.lastSync ? store.fmtRelative(acc.lastSync) : 'nunca'}.` : 'Conectá el campus para ver el material nuevo acá.'),
        acc ? h('button.btn.small', { type: 'button', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { const r = await campus.sync(); toast(`Campus sincronizado: ${r.newFiles} archivo(s) nuevo(s)`); } catch (err) { toast(err.message, { error: true }); }
          b.disabled = false;
        } }, icon('sync'), 'Sincronizar') : null),
      h('section.card',
        h('h2.section-title', 'Próximas entregas'),
        deadlines.length ? h('ul.event-list', deadlines.map(eventRow)) : h('p.muted', 'No hay entregas en las próximas dos semanas.'))),

    recent.length ? h('section',
      h('h2.section-title', 'Notas recientes'),
      h('div.note-grid', recent.map((n) => noteCard(n, nbById.get(n.notebookId))))) : null));
}

export function noteCard(n, nb) {
  const text = store.noteText(n);
  const sheets = n.blocks.filter((b) => b.type === 'ink').length;
  return h('button.note-card', { type: 'button', style: { '--c': nb?.color || '#8a8f98' }, onclick: () => go(`/nota/${n.id}`) },
    h('div.note-card-top', h('span.crumb', nb?.name || ''), n.pinned ? icon('pin') : null),
    h('h3', store.noteTitle(n)),
    h('p', text.slice(0, 140) || (sheets ? `${sheets} hoja(s) escritas a mano` : 'Sin contenido')),
    h('small', `${store.fmtDate(n.classDate)} · editada ${store.fmtRelative(n.updatedAt)}`));
}
