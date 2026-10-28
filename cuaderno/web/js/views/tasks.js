// Tareas de la facultad: en "Mi día" (lo atrasado, lo de hoy y lo que viene) y
// en una página propia con todo el plan. Un toque en el círculo las tacha.
// Las lecturas son tareas marcadas "para leer": tienen su propia sección en "Mi día",
// con el archivo del campus a un toque, y aparecen igual en Tareas y en el calendario.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { listTodos, addTodo, setDone, deleteTodo, sortTodos, bucketsFor, isReading } from '../todos.js';
import { canOpen } from '../editor/office.js';
import { h, icon, confirmDialog, toast } from '../ui.js';
import { go } from '../router.js';

const shortName = (name) => String(name || '').replace(/\s*\[.*\]\s*$/, '');
const plusDays = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return store.ymd(d); };
// "Para leer", "Para hacer" y la semana comparten las tareas: si cambia una (se tacha, se agrega),
// se redibujan las secciones que están en pantalla. Las que ya no están se sueltan solas.
const mounted = new Set();
const refreshMounted = () => {
  for (const m of [...mounted]) {
    if (m.sec.isConnected) { m.seen = true; m.redraw(); }
    else if (m.seen || Date.now() - m.at > 10000) mounted.delete(m);
  }
};
const mount = (sec, redraw) => { mounted.add({ sec, redraw, seen: false, at: Date.now() }); };
const fmtMinutes = (m) => { const hs = Math.floor(m / 60); const r = m % 60; return hs ? (r ? `${hs} h ${r} min` : `${hs} h`) : `${r} min`; };

// Abre el archivo de una lectura: los que se pueden anotar, en una nota; el resto, el original.
async function openMaterial(btn, f) {
  const nb = await import('./notebook.js');
  if (canOpen(f)) await nb.openInCuaderno(btn, f);
  else await nb.openFile(f);
}

export function dueLabel(due, today = store.ymd()) {
  if (!due) return 'Sin fecha';
  if (due === today) return 'Hoy';
  if (due === plusDays(today, 1)) return 'Mañana';
  if (due === plusDays(today, -1)) return 'Ayer';
  const d = store.fromYmd(due);
  return `${store.DAYS[d.getDay()]} ${store.fmtDate(d)}`;
}

function todoRow(t, nbById, { onChange, showDate = true, filesById } = {}) {
  const nb = nbById.get(t.notebookId);
  const reading = isReading(t);
  const file = reading && t.fileId ? filesById?.get(t.fileId) : null;
  const meta = [nb ? shortName(nb.name) : null, showDate && t.due ? dueLabel(t.due) : null, t.minutes ? `${t.minutes} min` : null,
    file ? (file.downloaded ? 'en el dispositivo' : 'sin descargar') : null].filter(Boolean);
  const check = h('button.todo-check', {
    type: 'button',
    'aria-label': t.title,
    'aria-pressed': String(!!t.done),
    title: t.done ? 'Marcar como pendiente' : 'Marcar como hecha',
    onclick: async () => {
      const want = !li.classList.contains('done'); // estado explícito: dos toques seguidos no se pisan
      li.classList.toggle('done', want);
      check.setAttribute('aria-pressed', String(want));
      await setDone(t.id, want);
      setTimeout(() => onChange?.(), 350); // que se vea el tachado antes de reordenar
    },
  }, icon('check'));
  const li = h(`li.todo${reading ? '.read' : ''}${t.done ? '.done' : ''}`, { style: { '--c': nb?.color || '#8a8f98' }, 'data-id': t.id },
    check,
    h('div.todo-main',
      h('div.todo-title', reading ? h('span.todo-kind', { title: 'Lectura' }, icon('book')) : null, t.title),
      meta.length ? h('small.todo-meta', meta.join(' · ')) : null),
    file ? h('button.btn.small.todo-open', { type: 'button', 'aria-label': `Abrir ${file.name}`, onclick: (e) => openMaterial(e.currentTarget, file) }, icon(campus.isPdf(file) ? 'pdf' : 'file'), 'Abrir') : null,
    h('button.icon-btn.todo-del', {
      type: 'button',
      'aria-label': `Borrar "${t.title}"`,
      onclick: async () => {
        if (!(await confirmDialog('Borrar tarea', `Se borra "${t.title}".`, { ok: 'Borrar', danger: true }))) return;
        await deleteTodo(t.id);
        onChange?.();
      },
    }, icon('trash')));
  return li;
}

// Después de redibujar, el foco vuelve a la misma tarea (si sigue en pantalla).
function keepFocus(container, redraw) {
  return async () => {
    const id = document.activeElement?.closest?.('.todo')?.dataset.id;
    await redraw();
    if (id) container.querySelector(`.todo[data-id="${CSS.escape(id)}"] .todo-check`)?.focus();
  };
}

// Formulario para agregar: se arma una sola vez (no se pierde lo que se está
// escribiendo cuando la lista se redibuja) y mantiene materia y fecha elegidas.
// kind 'read': todo lo que se agrega es una lectura (con el archivo del campus, si hay);
// kind 'task': todo lo que se agrega es una tarea común; kind 'any': una casilla "Lectura" decide.
function addForm(notebooks, { day, notebookId = '', onAdded, kind = 'any', getFiles = async () => [] }) {
  const alwaysRead = kind === 'read';
  const title = h('input.input.todo-new', { placeholder: alwaysRead ? 'Agregar una lectura…' : 'Agregar una tarea…', 'aria-label': alwaysRead ? 'Nueva lectura' : 'Nueva tarea' });
  const due = h('input.input.todo-date', { type: 'date', value: day || store.ymd(), 'aria-label': 'Fecha' });
  const nbSel = h('select.input.todo-nb', { 'aria-label': 'Materia' },
    h('option', { value: '' }, 'Sin materia'),
    notebooks.map((nb) => h('option', { value: nb.id }, shortName(nb.name))));
  nbSel.value = notebookId || '';
  const readInput = kind === 'any' ? h('input', { type: 'checkbox', 'aria-label': 'Es una lectura' }) : null;
  let readDefault = false; // con "Solo lecturas" prendido, la casilla arranca tildada para que lo agregado no desaparezca
  const readBox = readInput ? h('label.todo-readbox', readInput, icon('book'), ' Lectura') : null;
  const fileSel = h('select.input.todo-file', { 'aria-label': 'Archivo del campus', hidden: true });
  const isRead = () => alwaysRead || !!readInput?.checked;
  const fillFiles = async () => {
    const mine = nbSel.value ? (await getFiles()).filter((f) => f.notebookId === nbSel.value).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)) : [];
    const keep = fileSel.value;
    fileSel.replaceChildren(h('option', { value: '' }, 'Sin archivo'), ...mine.map((f) => h('option', { value: f.id }, f.name)));
    fileSel.value = mine.some((f) => f.id === keep) ? keep : '';
    fileSel.hidden = !(isRead() && mine.length);
  };
  nbSel.addEventListener('change', fillFiles);
  readInput?.addEventListener('change', fillFiles);
  const add = async () => {
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    title.value = ''; // antes de guardar: un doble Enter no la duplica
    const read = isRead();
    const fileId = read && fileSel.value ? fileSel.value : null;
    fileSel.value = '';
    if (readInput) { readInput.checked = readDefault; fileSel.hidden = !readDefault; } // la casilla vale para una sola: la siguiente tarea no sale lectura por error
    await addTodo({ title: text, due: due.value || null, notebookId: nbSel.value || null, read, fileId });
    await onAdded?.();
    title.focus();
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const el = h('div.todo-add', title, nbSel, readBox, fileSel, due, h('button.btn.small.primary', { type: 'button', onclick: add }, icon('plus'), 'Agregar'));
  fillFiles();
  return {
    el,
    setNotebook: (id) => { nbSel.value = id || ''; fillFiles(); },
    setRead: (on) => { readDefault = !!on; if (readInput) { readInput.checked = readDefault; fillFiles(); } },
  };
}

// Bloque de "Mi día".
export function todoSection(day = store.ymd()) {
  const sec = h('section.todo-today');
  const today = store.ymd();
  const lists = h('div.todo-lists');
  let form = null;
  const draw = async () => {
    const [everything, all] = await Promise.all([listTodos(), store.listNotebooks()]);
    const list = everything.filter((t) => !isReading(t)); // las lecturas están en "Para leer"
    const nbById = new Map(all.map((n) => [n.id, n]));
    const notebooks = all.filter((nb) => !store.isPersonal(nb)); // materias (sin las carpetas de Personal)
    const b = bucketsFor(list, day);
    // En el día: lo pendiente y, tachado, lo que ya se hizo (de ese día o hecho hoy).
    const dayDone = sortTodos(list.filter((t) => t.done && (t.due === day || (day === today && b.doneToday.some((x) => x.id === t.id)))));
    const dayList = [...b.today, ...dayDone];
    const total = dayList.length;
    const done = dayDone.length;
    const rows = (arr, opts) => h('ul.todo-list', arr.map((t) => todoRow(t, nbById, { onChange: refreshMounted, ...opts })));
    lists.replaceChildren(
      ...(b.overdue.length && day === today ? [h('h3.todo-group.late', `Atrasadas · ${b.overdue.length}`), rows(b.overdue)] : []),
      h('div.todo-group-head',
        h('h3.todo-group', day === today ? 'Hoy' : dueLabel(day)),
        total ? h('span.todo-progress', h('span.bar', h('span', { style: { width: `${Math.round((done / total) * 100)}%` } })), `${done} de ${total}`) : null),
      dayList.length ? rows(dayList, { showDate: false }) : h('p.muted', day === today ? 'Nada pendiente para hoy.' : 'Nada para este día.'),
      ...(b.next.length && day === today ? [h('h3.todo-group', 'Próximos días'), rows(b.next)] : []));
    if (!form) {
      form = addForm(notebooks, { day, kind: 'task', onAdded: refreshMounted, getFiles: () => db.all('files') });
      sec.replaceChildren(
        h('div.row.space', h('h2.section-title', 'Para hacer'), h('a.btn.small.ghost', { href: '#/tareas' }, icon('checklist'), 'Ver todas')),
        h('div.card.todo-card', lists, form.el));
    }
  };
  const redraw = keepFocus(sec, draw);
  mount(sec, redraw);
  draw();
  return sec;
}

// La semana de "Mi día" (lunes a domingo): qué días tienen lecturas, para saltar a cada uno.
// Es el mismo calendario de tareas: tocar un día abre ese día en "Mi día".
function weekStrip(list, day, today) {
  const d0 = new Date(`${day}T12:00:00`);
  d0.setDate(d0.getDate() - ((d0.getDay() + 6) % 7));
  return h('div.week-strip', { role: 'group', 'aria-label': 'Semana' }, Array.from({ length: 7 }, (_, i) => {
    const d = new Date(d0);
    d.setDate(d.getDate() + i);
    const key = store.ymd(d);
    const reads = list.filter((t) => t.due === key && isReading(t));
    const pending = reads.filter((t) => !t.done).length;
    const others = list.some((t) => t.due === key && !t.done && !isReading(t));
    const name = store.DAYS[d.getDay()];
    return h(`button.wk${key === day ? '.sel' : ''}${key === today ? '.today' : ''}`, {
      type: 'button',
      'aria-label': `${name} ${d.getDate()}: ${pending ? `${pending} lectura${pending === 1 ? '' : 's'} pendiente${pending === 1 ? '' : 's'}` : reads.length ? 'lecturas hechas' : 'sin lecturas'}`,
      'aria-pressed': String(key === day),
      onclick: () => go(`/hoy/${key}`),
    },
    h('small', name.slice(0, 3)),
    h('strong', d.getDate()),
    h(`span.wk-count${pending ? '.has' : ''}`, pending ? [icon('book'), String(pending)] : reads.length ? '✓' : ''),
    h(`i.wk-dot${others ? '.on' : ''}`));
  }));
}

// "Para leer" de "Mi día": las lecturas del día (y lo atrasado y lo que viene), con el archivo
// a un toque y un botón para bajar lo que falta antes de quedarse sin conexión.
export function readSection(day = store.ymd()) {
  const sec = h('section.read-today');
  const today = store.ymd();
  const strip = h('div.week-wrap');
  const lists = h('div.todo-lists');
  let form = null;
  const draw = async () => {
    const [list, all, files] = await Promise.all([listTodos(), store.listNotebooks(), db.all('files')]);
    const nbById = new Map(all.map((n) => [n.id, n]));
    const filesById = new Map(files.map((f) => [f.id, f]));
    const notebooks = all.filter((nb) => !store.isPersonal(nb));
    const reads = list.filter(isReading);
    const b = bucketsFor(reads, day);
    const dayDone = sortTodos(reads.filter((t) => t.done && (t.due === day || (day === today && b.doneToday.some((x) => x.id === t.id)))));
    const dayList = [...b.today, ...dayDone];
    const mins = b.today.reduce((n, t) => n + (t.minutes || 0), 0);
    const rows = (arr, opts) => h('ul.todo-list', arr.map((t) => todoRow(t, nbById, { onChange: refreshMounted, filesById, ...opts })));
    // Lo que todavía no está en este dispositivo (de lo atrasado, de hoy y de los próximos días).
    const need = [];
    for (const t of [...(day === today ? b.overdue : []), ...b.today, ...(day === today ? b.next : [])]) {
      const f = t.fileId ? filesById.get(t.fileId) : null;
      if (f && !f.downloaded && campus.isDownloadable(f.name) && !need.some((x) => x.id === f.id)) need.push(f);
    }
    const downloadAll = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      let i = 0;
      let failed = 0;
      for (const f of need) {
        btn.lastChild.textContent = ` Bajando ${++i} de ${need.length}…`;
        try { await campus.download(f.id); } catch (err) { failed++; toast(`${f.name}: ${err.message}`, { error: true, ms: 6000 }); }
      }
      if (!failed) toast(need.length === 1 ? 'Listo: quedó guardada para leer sin conexión' : `Listo: ${need.length} lecturas guardadas para leer sin conexión`);
      await redraw();
    };
    strip.replaceChildren(weekStrip(list, day, today));
    lists.replaceChildren(
      ...(b.overdue.length && day === today ? [h('h3.todo-group.late', `Atrasadas · ${b.overdue.length}`), rows(b.overdue)] : []),
      h('div.todo-group-head',
        h('h3.todo-group', day === today ? 'Hoy' : dueLabel(day)),
        dayList.length ? h('span.todo-progress', `${dayDone.length} de ${dayList.length}${mins ? ` · ${fmtMinutes(mins)}` : ''}`) : null),
      dayList.length ? rows(dayList, { showDate: false }) : h('p.muted', day === today ? 'No hay lecturas para hoy.' : 'No hay lecturas para este día.'),
      ...(b.next.length && day === today ? [h('h3.todo-group', 'Próximos días'), rows(b.next)] : []),
      ...(need.length ? [h('div.read-download', h('button.btn.small', { type: 'button', onclick: downloadAll }, icon('download'), ` Bajar lo que falta para leer sin conexión (${need.length})`))] : []));
    if (!form) {
      form = addForm(notebooks, { day, kind: 'read', onAdded: refreshMounted, getFiles: () => db.all('files') });
      sec.replaceChildren(
        h('div.row.space', h('h2.section-title', 'Para leer'), h('a.btn.small.ghost', { href: `#/calendario/${day}` }, icon('calendar'), 'Calendario')),
        h('div.card.todo-card', strip, lists, form.el));
    }
  };
  const redraw = keepFocus(sec, draw);
  mount(sec, redraw);
  draw();
  return sec;
}

// Página "Tareas": todo el plan, por día.
export async function renderTasks(root) {
  let showDone = false;
  let onlyNb = '';
  let onlyRead = false;
  try { showDone = localStorage.getItem('tasksShowDone') === '1'; onlyNb = localStorage.getItem('tasksNb') || ''; onlyRead = localStorage.getItem('tasksOnlyRead') === '1'; } catch { /* sin almacenamiento */ }
  const setFilter = (id) => { onlyNb = id; try { localStorage.setItem('tasksNb', id); } catch { /* */ } form?.setNotebook(id); };
  const tools = h('div.tasks-tools');
  const summary = h('p.muted.tasks-summary');
  const groupsEl = h('div.tasks-groups');
  let form = null;
  const formCard = h('div.card.todo-card');
  const page = h('div.page.tasks',
    h('header.page-head', h('div', h('p.eyebrow', 'Facultad'), h('h1', 'Tareas'))),
    tools, summary, formCard, groupsEl);
  root.replaceChildren(page);

  const draw = async () => {
    const [all, everyNb, files] = await Promise.all([listTodos(), store.listNotebooks(), db.all('files')]);
    const nbById = new Map(everyNb.map((n) => [n.id, n]));
    const filesById = new Map(files.map((f) => [f.id, f]));
    const notebooks = everyNb.filter((nb) => !store.isPersonal(nb)); // materias (sin las carpetas de Personal)
    const usedNbs = notebooks.filter((nb) => all.some((t) => t.notebookId === nb.id));
    if (onlyNb && !usedNbs.some((nb) => nb.id === onlyNb)) setFilter(''); // filtro viejo: se vuelve a "Todas"
    if (!form) { form = addForm(notebooks, { day: store.ymd(), notebookId: onlyNb, onAdded: redraw, getFiles: () => db.all('files') }); form.setRead(onlyRead); formCard.replaceChildren(form.el); }
    const today = store.ymd();
    const list = sortTodos(all.filter((t) => (!onlyNb || t.notebookId === onlyNb) && (!onlyRead || isReading(t))));
    const pending = list.filter((t) => !t.done);
    const doneCount = list.length - pending.length;
    const groups = new Map();
    for (const t of list) {
      if (t.done && !showDone) continue;
      const key = !t.due ? 'zzz' : (!t.done && t.due < today ? '000' : t.due);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const chip = (id, label, color) => h(`button.chip${onlyNb === id ? '.on' : ''}`, {
      type: 'button',
      'aria-pressed': String(onlyNb === id),
      style: { '--c': color },
      onclick: () => { setFilter(id); draw(); },
    }, label);
    tools.replaceChildren(
      h('div.row', chip('', 'Todas', '#8a8f98'), ...usedNbs.map((nb) => chip(nb.id, shortName(nb.name), nb.color || '#8a8f98'))),
      h('div.row.tasks-toggles',
        h('label.tasks-toggle', h('input', { type: 'checkbox', checked: showDone, onchange: (e) => { showDone = e.target.checked; try { localStorage.setItem('tasksShowDone', showDone ? '1' : '0'); } catch { /* */ } draw(); } }), ` Mostrar hechas (${doneCount})`),
        h('label.tasks-toggle', h('input', { type: 'checkbox', checked: onlyRead, onchange: (e) => { onlyRead = e.target.checked; try { localStorage.setItem('tasksOnlyRead', onlyRead ? '1' : '0'); } catch { /* */ } form?.setRead(onlyRead); draw(); } }), ' Solo lecturas')));
    summary.textContent = pending.length ? `${pending.length} pendiente${pending.length === 1 ? '' : 's'} · ${doneCount} hecha${doneCount === 1 ? '' : 's'}` : onlyRead ? 'No hay lecturas pendientes.' : 'No hay tareas pendientes.';
    groupsEl.replaceChildren(...[...groups.keys()].sort().map((key) => h('section.todo-day',
      h(`h3.todo-group${key === '000' ? '.late' : ''}`, key === '000' ? 'Atrasadas' : key === 'zzz' ? 'Sin fecha' : dueLabel(key, today)),
      h('ul.todo-list.card', groups.get(key).map((t) => todoRow(t, nbById, { onChange: redraw, showDate: key === '000', filesById }))))));
  };
  const redraw = keepFocus(page, draw);
  await draw();
}
