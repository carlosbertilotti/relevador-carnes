// Tareas de la facultad: en "Mi día" (lo atrasado, lo de hoy y lo que viene) y
// en una página propia con todo el plan. Un toque en el círculo las tacha.
import * as store from '../store.js';
import { listTodos, addTodo, toggleTodo, deleteTodo, sortTodos, bucketsFor } from '../todos.js';
import { h, icon, confirmDialog } from '../ui.js';

const shortName = (name) => String(name || '').replace(/\s*\[.*\]\s*$/, '');
const plusDays = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return store.ymd(d); };

export function dueLabel(due, today = store.ymd()) {
  if (!due) return 'Sin fecha';
  if (due === today) return 'Hoy';
  if (due === plusDays(today, 1)) return 'Mañana';
  if (due === plusDays(today, -1)) return 'Ayer';
  const d = store.fromYmd(due);
  return `${store.DAYS[d.getDay()]} ${store.fmtDate(d)}`;
}

function todoRow(t, nbById, { onChange, showDate = true } = {}) {
  const nb = nbById.get(t.notebookId);
  const meta = [nb ? shortName(nb.name) : null, showDate && t.due ? dueLabel(t.due) : null, t.minutes ? `${t.minutes} min` : null].filter(Boolean);
  const li = h(`li.todo${t.done ? '.done' : ''}`, { style: { '--c': nb?.color || '#8a8f98' }, 'data-id': t.id },
    h('button.todo-check', {
      type: 'button',
      'aria-label': t.done ? 'Marcar como pendiente' : 'Marcar como hecha',
      'aria-pressed': String(!!t.done),
      onclick: async () => {
        li.classList.toggle('done');
        await toggleTodo(t.id);
        setTimeout(() => onChange?.(), 350); // que se vea el tachado antes de reordenar
      },
    }, icon('check')),
    h('div.todo-main', h('div.todo-title', t.title), meta.length ? h('small.todo-meta', meta.join(' · ')) : null),
    h('button.icon-btn.todo-del', {
      type: 'button',
      'aria-label': 'Borrar tarea',
      onclick: async () => {
        if (!(await confirmDialog('Borrar tarea', `Se borra "${t.title}".`, { ok: 'Borrar', danger: true }))) return;
        await deleteTodo(t.id);
        onChange?.();
      },
    }, icon('trash')));
  return li;
}

function addForm(notebooks, { day, onAdded }) {
  const title = h('input.input.todo-new', { placeholder: 'Agregar una tarea…', 'aria-label': 'Nueva tarea' });
  const due = h('input.input.todo-date', { type: 'date', value: day || store.ymd(), 'aria-label': 'Fecha' });
  const nbSel = h('select.input.todo-nb', { 'aria-label': 'Materia' },
    h('option', { value: '' }, 'Sin materia'),
    notebooks.map((nb) => h('option', { value: nb.id }, shortName(nb.name))));
  const add = async () => {
    if (!title.value.trim()) { title.focus(); return; }
    await addTodo({ title: title.value, due: due.value || null, notebookId: nbSel.value || null });
    title.value = '';
    onAdded?.();
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return h('div.todo-add', title, nbSel, due, h('button.btn.small.primary', { type: 'button', onclick: add }, icon('plus'), 'Agregar'));
}

// Bloque de "Mi día".
export function todoSection(day = store.ymd()) {
  const sec = h('section.todo-today');
  const today = store.ymd();
  const draw = async () => {
    const [list, notebooks] = await Promise.all([listTodos(), store.listNotebooks()]);
    const nbById = new Map(notebooks.map((n) => [n.id, n]));
    const b = bucketsFor(list, day);
    // En el día: lo pendiente y, tachado, lo que ya se hizo (de ese día o hecho hoy).
    const dayDone = sortTodos(list.filter((t) => t.done && (t.due === day || (day === today && b.doneToday.includes(t)))));
    const dayList = [...b.today, ...dayDone];
    const total = dayList.length;
    const done = dayDone.length;
    const rows = (arr, opts) => h('ul.todo-list', arr.map((t) => todoRow(t, nbById, { onChange: draw, ...opts })));
    sec.replaceChildren(
      h('div.row.space', h('h2.section-title', 'Para hacer'), h('a.btn.small.ghost', { href: '#/tareas' }, icon('checklist'), 'Ver todas')),
      h('div.card.todo-card',
        b.overdue.length && day === today ? [h('h3.todo-group.late', `Atrasadas · ${b.overdue.length}`), rows(b.overdue)] : null,
        h('div.todo-group-head',
          h('h3.todo-group', day === today ? 'Hoy' : dueLabel(day)),
          total ? h('span.todo-progress', h('span.bar', h('span', { style: { width: `${Math.round((done / total) * 100)}%` } })), `${done} de ${total}`) : null),
        dayList.length ? rows(dayList, { showDate: false }) : h('p.muted', day === today ? 'Nada pendiente para hoy.' : 'Nada para este día.'),
        b.next.length && day === today ? [h('h3.todo-group', 'Próximos días'), rows(b.next)] : null,
        addForm(notebooks, { day, onAdded: draw })));
  };
  draw();
  return sec;
}

// Página "Tareas": todo el plan, por día.
export async function renderTasks(root) {
  let showDone = false;
  let onlyNb = '';
  try { showDone = localStorage.getItem('tasksShowDone') === '1'; onlyNb = localStorage.getItem('tasksNb') || ''; } catch { /* sin almacenamiento */ }
  const body = h('div.tasks-body');
  const page = h('div.page.tasks',
    h('header.page-head', h('div', h('p.eyebrow', 'Facultad'), h('h1', 'Tareas'))),
    body);
  root.replaceChildren(page);

  const draw = async () => {
    const [all, notebooks] = await Promise.all([listTodos(), store.listNotebooks()]);
    const nbById = new Map(notebooks.map((n) => [n.id, n]));
    const today = store.ymd();
    const list = sortTodos(all.filter((t) => (!onlyNb || t.notebookId === onlyNb)));
    const pending = list.filter((t) => !t.done);
    const doneCount = list.length - pending.length;
    const groups = new Map();
    for (const t of list) {
      if (t.done && !showDone) continue;
      const key = !t.due ? 'zzz' : (!t.done && t.due < today ? '000' : t.due);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const usedNbs = notebooks.filter((nb) => all.some((t) => t.notebookId === nb.id));
    const chip = (id, label, color) => h(`button.chip${onlyNb === id ? '.on' : ''}`, {
      type: 'button',
      style: color ? { '--c': color } : null,
      onclick: () => { onlyNb = id; try { localStorage.setItem('tasksNb', id); } catch { /* */ } draw(); },
    }, label);
    body.replaceChildren(
      h('div.tasks-tools',
        h('div.row', chip('', 'Todas', '#8a8f98'), usedNbs.map((nb) => chip(nb.id, shortName(nb.name), nb.color))),
        h('label.tasks-toggle', h('input', { type: 'checkbox', checked: showDone, onchange: (e) => { showDone = e.target.checked; try { localStorage.setItem('tasksShowDone', showDone ? '1' : '0'); } catch { /* */ } draw(); } }), ` Mostrar hechas (${doneCount})`)),
      h('p.muted.tasks-summary', pending.length ? `${pending.length} pendiente${pending.length === 1 ? '' : 's'} · ${doneCount} hecha${doneCount === 1 ? '' : 's'}` : 'No hay tareas pendientes.'),
      h('div.card.todo-card', addForm(notebooks, { day: today, onAdded: draw })),
      ...[...groups.keys()].sort().map((key) => h('section.todo-day',
        h(`h3.todo-group${key === '000' ? '.late' : ''}`, key === '000' ? 'Atrasadas' : key === 'zzz' ? 'Sin fecha' : dueLabel(key, today)),
        h('ul.todo-list.card', groups.get(key).map((t) => todoRow(t, nbById, { onChange: draw, showDate: key === '000' }))))));
  };
  await draw();
}
