// Tareas de la facultad: en "Mi día" (lo atrasado, lo de hoy y lo que viene) y
// en una página propia con todo el plan. Un toque en el círculo las tacha.
import * as store from '../store.js';
import { listTodos, addTodo, setDone, deleteTodo, sortTodos, bucketsFor } from '../todos.js';
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
  const li = h(`li.todo${t.done ? '.done' : ''}`, { style: { '--c': nb?.color || '#8a8f98' }, 'data-id': t.id },
    check,
    h('div.todo-main', h('div.todo-title', t.title), meta.length ? h('small.todo-meta', meta.join(' · ')) : null),
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
function addForm(notebooks, { day, notebookId = '', onAdded }) {
  const title = h('input.input.todo-new', { placeholder: 'Agregar una tarea…', 'aria-label': 'Nueva tarea' });
  const due = h('input.input.todo-date', { type: 'date', value: day || store.ymd(), 'aria-label': 'Fecha' });
  const nbSel = h('select.input.todo-nb', { 'aria-label': 'Materia' },
    h('option', { value: '' }, 'Sin materia'),
    notebooks.map((nb) => h('option', { value: nb.id }, shortName(nb.name))));
  nbSel.value = notebookId || '';
  const add = async () => {
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    title.value = ''; // antes de guardar: un doble Enter no la duplica
    await addTodo({ title: text, due: due.value || null, notebookId: nbSel.value || null });
    await onAdded?.();
    title.focus();
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const el = h('div.todo-add', title, nbSel, due, h('button.btn.small.primary', { type: 'button', onclick: add }, icon('plus'), 'Agregar'));
  return { el, setNotebook: (id) => { nbSel.value = id || ''; } };
}

// Bloque de "Mi día".
export function todoSection(day = store.ymd()) {
  const sec = h('section.todo-today');
  const today = store.ymd();
  const lists = h('div.todo-lists');
  let form = null;
  const draw = async () => {
    const [list, all] = await Promise.all([listTodos(), store.listNotebooks()]);
    const nbById = new Map(all.map((n) => [n.id, n]));
    const notebooks = all.filter((nb) => !store.isPersonal(nb)); // materias (sin las carpetas de Personal)
    const b = bucketsFor(list, day);
    // En el día: lo pendiente y, tachado, lo que ya se hizo (de ese día o hecho hoy).
    const dayDone = sortTodos(list.filter((t) => t.done && (t.due === day || (day === today && b.doneToday.some((x) => x.id === t.id)))));
    const dayList = [...b.today, ...dayDone];
    const total = dayList.length;
    const done = dayDone.length;
    const rows = (arr, opts) => h('ul.todo-list', arr.map((t) => todoRow(t, nbById, { onChange: redraw, ...opts })));
    lists.replaceChildren(
      ...(b.overdue.length && day === today ? [h('h3.todo-group.late', `Atrasadas · ${b.overdue.length}`), rows(b.overdue)] : []),
      h('div.todo-group-head',
        h('h3.todo-group', day === today ? 'Hoy' : dueLabel(day)),
        total ? h('span.todo-progress', h('span.bar', h('span', { style: { width: `${Math.round((done / total) * 100)}%` } })), `${done} de ${total}`) : null),
      dayList.length ? rows(dayList, { showDate: false }) : h('p.muted', day === today ? 'Nada pendiente para hoy.' : 'Nada para este día.'),
      ...(b.next.length && day === today ? [h('h3.todo-group', 'Próximos días'), rows(b.next)] : []));
    if (!form) {
      form = addForm(notebooks, { day, onAdded: redraw });
      sec.replaceChildren(
        h('div.row.space', h('h2.section-title', 'Para hacer'), h('a.btn.small.ghost', { href: '#/tareas' }, icon('checklist'), 'Ver todas')),
        h('div.card.todo-card', lists, form.el));
    }
  };
  const redraw = keepFocus(sec, draw);
  draw();
  return sec;
}

// Página "Tareas": todo el plan, por día.
export async function renderTasks(root) {
  let showDone = false;
  let onlyNb = '';
  try { showDone = localStorage.getItem('tasksShowDone') === '1'; onlyNb = localStorage.getItem('tasksNb') || ''; } catch { /* sin almacenamiento */ }
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
    const [all, everyNb] = await Promise.all([listTodos(), store.listNotebooks()]);
    const nbById = new Map(everyNb.map((n) => [n.id, n]));
    const notebooks = everyNb.filter((nb) => !store.isPersonal(nb)); // materias (sin las carpetas de Personal)
    const usedNbs = notebooks.filter((nb) => all.some((t) => t.notebookId === nb.id));
    if (onlyNb && !usedNbs.some((nb) => nb.id === onlyNb)) setFilter(''); // filtro viejo: se vuelve a "Todas"
    if (!form) { form = addForm(notebooks, { day: store.ymd(), notebookId: onlyNb, onAdded: redraw }); formCard.replaceChildren(form.el); }
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
    const chip = (id, label, color) => h(`button.chip${onlyNb === id ? '.on' : ''}`, {
      type: 'button',
      'aria-pressed': String(onlyNb === id),
      style: { '--c': color },
      onclick: () => { setFilter(id); draw(); },
    }, label);
    tools.replaceChildren(
      h('div.row', chip('', 'Todas', '#8a8f98'), ...usedNbs.map((nb) => chip(nb.id, shortName(nb.name), nb.color || '#8a8f98'))),
      h('label.tasks-toggle', h('input', { type: 'checkbox', checked: showDone, onchange: (e) => { showDone = e.target.checked; try { localStorage.setItem('tasksShowDone', showDone ? '1' : '0'); } catch { /* */ } draw(); } }), ` Mostrar hechas (${doneCount})`));
    summary.textContent = pending.length ? `${pending.length} pendiente${pending.length === 1 ? '' : 's'} · ${doneCount} hecha${doneCount === 1 ? '' : 's'}` : 'No hay tareas pendientes.';
    groupsEl.replaceChildren(...[...groups.keys()].sort().map((key) => h('section.todo-day',
      h(`h3.todo-group${key === '000' ? '.late' : ''}`, key === '000' ? 'Atrasadas' : key === 'zzz' ? 'Sin fecha' : dueLabel(key, today)),
      h('ul.todo-list.card', groups.get(key).map((t) => todoRow(t, nbById, { onChange: redraw, showDate: key === '000' }))))));
  };
  const redraw = keepFocus(page, draw);
  await draw();
}
