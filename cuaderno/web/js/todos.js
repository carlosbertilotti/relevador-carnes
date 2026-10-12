// Tareas (to-do): cada una se guarda aparte ("todo:<id>") y se sincroniza entre
// dispositivos, así tachar en el iPad y en la compu no se pisa.
import * as db from './db.js';
import { emit, ymd } from './store.js';

const PREFIX = 'todo:';

export async function listTodos() {
  return (await db.all('kv'))
    .filter((r) => String(r.key).startsWith(PREFIX) && r.value && typeof r.value === 'object')
    .map((r) => ({ ...r.value, id: String(r.key).slice(PREFIX.length) })); // la clave manda
}

export async function saveTodo(t) {
  // Se conserva la marca anterior para que el cambio le gane aunque el reloj de este
  // dispositivo atrase respecto del que la escribió (stamp usa max(ahora, anterior + 1)).
  const prev = await db.get('kv', PREFIX + t.id);
  await db.put('kv', { key: PREFIX + t.id, value: t, _mod: prev?._mod });
  emit('change', { type: 'todos' });
  return t;
}

export async function addTodo({ title, due = ymd(), notebookId = null, minutes = null }) {
  const t = { id: db.uid('t_'), title: title.trim(), due, notebookId, minutes, done: false, doneAt: null, createdAt: Date.now() };
  return saveTodo(t);
}

// Marca hecha o pendiente (estado explícito: dos toques seguidos no se pisan).
export async function setDone(id, done) {
  const t = await db.getSetting(PREFIX + id, null);
  if (!t) return null;
  if (!!t.done === !!done) return t;
  return saveTodo({ ...t, id, done: !!done, doneAt: done ? Date.now() : null });
}

export async function toggleTodo(id) {
  const t = await db.getSetting(PREFIX + id, null);
  return t ? setDone(id, !t.done) : null;
}

export async function deleteTodo(id) {
  await db.del('kv', PREFIX + id);
  emit('change', { type: 'todos' });
}

// Orden: por día (las sin fecha al final), después por orden de carga.
export function sortTodos(list) {
  return [...list].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
}

// Para "Mi día": atrasadas, las del día, las de los próximos días y lo hecho hoy.
export function bucketsFor(list, day = ymd()) {
  const plus = (n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
  const soon = plus(3);
  const todo = sortTodos(list.filter((t) => !t.done));
  return {
    overdue: todo.filter((t) => t.due && t.due < day),
    today: todo.filter((t) => t.due === day),
    next: todo.filter((t) => t.due && t.due > day && t.due <= soon),
    doneToday: sortTodos(list.filter((t) => t.done && t.doneAt && ymd(t.doneAt) === ymd())),
  };
}
