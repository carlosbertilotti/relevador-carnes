// "Personal": notas que no son de la facultad (ideas, trabajo, listas…), en
// carpetas propias. No se mezclan con las materias: no salen en Mi día, en el
// calendario ni en los resúmenes; sí en la búsqueda.
import * as db from '../db.js';
import * as store from '../store.js';
import { h, fill, icon, popover, prompt, confirmDialog, toast, modal } from '../ui.js';
import { go } from '../router.js';
import { noteCard } from './today.js';

export async function renderPersonal(root, { folder = '' } = {}) {
  const folders = await store.personalFolders();
  const current = folders.find((f) => f.id === folder) || null;
  if (folder && !current) { location.replace('#/personal'); return; } // carpeta borrada (o de otro dispositivo que todavía no llegó)
  const byId = new Map(folders.map((f) => [f.id, f]));
  const all = (await db.all('notes')).filter((n) => byId.has(n.notebookId));
  const notes = (current ? all.filter((n) => n.notebookId === current.id) : all)
    .sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt);

  const newNote = async () => {
    const target = current || (await store.defaultPersonalFolder());
    const n = await store.createNote(target.id);
    go(`/nota/${n.id}`);
  };
  const newFolder = async () => {
    const name = await prompt('Nueva carpeta', { placeholder: 'Ej. Trabajo, Ideas, Viajes', ok: 'Crear' });
    if (!name) return;
    const nb = await store.createNotebook({ name, kind: 'personal' });
    go(`/personal/${nb.id}`);
  };

  const count = (f) => all.filter((n) => n.notebookId === f.id).length;
  const chip = (f, label, n) => h(`button.chip${(f?.id || '') === (current?.id || '') ? '.on' : ''}`, {
    type: 'button',
    style: { '--c': f?.color || '#8a8f98' },
    'aria-pressed': String((f?.id || '') === (current?.id || '')),
    onclick: () => go(f ? `/personal/${f.id}` : '/personal'),
  }, label, h('small.chip-count', n));

  // Fijadas arriba; el resto por mes de la última edición (como Notas de Apple).
  const pinned = notes.filter((n) => n.pinned);
  const groups = new Map();
  for (const n of notes.filter((x) => !x.pinned)) {
    const key = new Date(n.updatedAt).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const grid = (list) => h('div.note-grid', list.map((n) => noteCard(n, byId.get(n.notebookId))));

  fill(root, h('div.page.personal', { style: current ? { '--c': current.color } : null },
    h('header.page-head',
      h('div',
        h('p.eyebrow', current ? 'Personal' : 'Fuera de la facu'),
        h('h1', current ? current.name : 'Personal')),
      h('div.head-actions',
        h('button.btn.primary', { type: 'button', onclick: newNote }, icon('compose'), 'Nueva nota'),
        current ? h('button.icon-btn', { type: 'button', 'aria-label': 'Opciones de la carpeta', onclick: (e) => folderMenu(e.currentTarget, current, count(current)) }, icon('more')) : null)),
    h('div.folder-bar',
      chip(null, 'Todas', all.length),
      folders.map((f) => chip(f, f.name, count(f))),
      h('button.chip.add', { type: 'button', onclick: newFolder }, icon('plus'), 'Carpeta')),
    notes.length
      ? [
        pinned.length ? h('section', h('h2.section-title', 'Fijadas'), grid(pinned)) : null,
        [...groups].map(([label, list]) => h('section', h('h2.section-title', label), grid(list))),
      ]
      : h('div.card.muted-card.personal-empty',
        current
          ? h('p', 'Esta carpeta está vacía.')
          : [h('p', h('strong', 'Tus notas que no son de la facultad: ideas, trabajo, listas, lo que quieras.')),
            h('p.muted', 'Quedan acá, separadas de las materias: no aparecen en Mi día ni en el calendario. Podés ordenarlas en carpetas.')],
        h('div.row', h('button.btn.primary', { type: 'button', onclick: newNote }, icon('compose'), 'Nueva nota')))));
}

function folderMenu(anchor, f, n) {
  popover(anchor, [
    { label: 'Renombrar', icon: 'compose', onClick: async () => {
      const v = await prompt('Nombre de la carpeta', { value: f.name });
      if (v) { f.name = v; await store.saveNotebook(f); go(`/personal/${f.id}`); }
    } },
    { label: 'Cambiar color', icon: 'sheet', onClick: () => {
      const m = modal('Color', h('div.swatches.big', store.COLORS.map((c) => h('button.swatch', { type: 'button', 'aria-label': `Color ${c}`, style: { background: c }, onclick: async () => { f.color = c; await store.saveNotebook(f); m.close(); go(`/personal/${f.id}`); } }))));
    } },
    '-',
    { label: 'Eliminar carpeta', icon: 'trash', danger: true, onClick: async () => {
      const msg = n ? `Se borran la carpeta "${f.name}" y sus ${n === 1 ? 'nota' : `${n} notas`}, en todos tus dispositivos.` : `Se borra la carpeta "${f.name}" (está vacía).`;
      if (!(await confirmDialog('Eliminar carpeta', msg, { ok: 'Eliminar', danger: true }))) return;
      await store.deleteNotebook(f.id);
      toast('Carpeta eliminada');
      go('/personal');
    } },
  ]);
}
