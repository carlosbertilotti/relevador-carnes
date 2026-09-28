// Una materia: sus notas de clase, el material del campus y el horario.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { pageSizes } from '../editor/pdf.js';
import { h, fill, icon, popover, prompt, confirmDialog, toast, modal } from '../ui.js';
import { go } from '../router.js';
import { noteCard } from './today.js';

export async function renderNotebook(root, { id, tab = 'notas' }) {
  const nb = await db.get('notebooks', id);
  if (!nb) { root.replaceChildren(h('div.empty', 'Esta materia no existe.')); return; }
  const tabs = [['notas', 'Notas'], ['material', 'Material'], ['horario', 'Horario']];
  const body = h('div.tab-body');

  root.replaceChildren(h('div.page.notebook', { style: { '--c': nb.color } },
    h('header.page-head',
      h('div',
        h('p.eyebrow', nb.courseId ? `Campus · ${nb.shortname || 'materia'}` : 'Materia'),
        h('h1.nb-name', nb.name)),
      h('div.head-actions',
        h('button.btn.primary', { type: 'button', onclick: async () => { const n = await store.noteForClass(nb.id, new Date()); go(`/nota/${n.id}`); } }, icon('compose'), 'Nota de hoy'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Opciones', onclick: (e) => menu(e.currentTarget, nb) }, icon('more')))),
    h('nav.tabs', tabs.map(([k, label]) => h(`button${k === tab ? '.active' : ''}`, { type: 'button', onclick: () => go(`/cuaderno/${nb.id}/${k}`) }, label))),
    body));

  if (tab === 'material') await renderMaterial(body, nb);
  else if (tab === 'horario') renderSchedule(body, nb);
  else await renderNotes(body, nb);
}

async function renderNotes(body, nb) {
  const notes = await store.notesOf(nb.id);
  if (!notes.length) {
    fill(body, h('div.card.muted-card',
      h('p', 'Todavía no hay notas en esta materia.'),
      h('div.row',
        h('button.btn.primary', { type: 'button', onclick: async () => { const n = await store.noteForClass(nb.id, new Date()); go(`/nota/${n.id}`); } }, 'Tomar notas de la clase de hoy'),
        h('button.btn', { type: 'button', onclick: async () => { const n = await store.createNote(nb.id); go(`/nota/${n.id}`); } }, 'Nota suelta'))));
    return;
  }
  // Agrupadas por mes, fijadas primero (como Notas de Apple).
  const groups = new Map();
  const pinned = notes.filter((n) => n.pinned);
  for (const n of notes.filter((x) => !x.pinned)) {
    const d = store.fromYmd(n.classDate || store.ymd(n.createdAt));
    const key = d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  fill(body, 
    h('div.row.end', h('button.btn.small', { type: 'button', onclick: async () => { const n = await store.createNote(nb.id); go(`/nota/${n.id}`); } }, icon('plus'), 'Nota suelta')),
    pinned.length ? h('section', h('h2.section-title', 'Fijadas'), h('div.note-grid', pinned.map((n) => noteCard(n, nb)))) : null,
    [...groups].map(([label, list]) => h('section', h('h2.section-title', label), h('div.note-grid', list.map((n) => noteCard(n, nb))))));
}

async function renderMaterial(body, nb) {
  const files = (await db.all('files')).filter((f) => f.notebookId === nb.id);
  const byUrl = new Map(files.map((f) => [f.url, f]));
  const acc = await campus.account();

  const fileRow = (f) => h(`li.file-row${f.seen ? '' : '.unseen'}`,
    icon(campus.isPdf(f) ? 'pdf' : 'file'),
    h('div.grow', h('div', f.name), h('small', [store.fmtSize(f.size), f.modified ? `actualizado ${store.fmtDate(f.modified)}` : null, f.downloaded ? 'en el dispositivo' : 'sin descargar'].filter(Boolean).join(' · '))),
    h('div.row',
      campus.isPdf(f) ? h('button.btn.small.primary', { type: 'button', onclick: (e) => annotate(e.currentTarget, nb, f) }, icon('compose'), 'Anotar') : null,
      h('button.btn.small', { type: 'button', onclick: () => openFile(f) }, f.downloaded ? 'Abrir' : icon('download'), f.downloaded ? null : 'Bajar')));

  const sections = (nb.sections || []).map((s) => {
    const modules = s.modules.filter((m) => m.files.length || (m.url && m.type !== 'label'));
    if (!modules.length && !s.summary) return null;
    return h('section.card.material-section',
      h('h2.section-title', s.name || 'General'),
      s.summary ? h('p.muted.summary', s.summary.slice(0, 400)) : null,
      h('ul.file-list', modules.flatMap((m) => (m.files.length
        ? m.files.map((file) => byUrl.get(file.url)).filter(Boolean).map(fileRow)
        : [h('li.file-row.link', { onclick: () => window.open(m.url, '_blank') }, icon(m.type === 'assign' ? 'checklist' : 'campus'), h('div.grow', h('div', m.name), h('small', moduleLabel(m.type))))]))));
  }).filter(Boolean);

  const local = files.filter((f) => f.local);
  fill(body, 
    h('div.row.end',
      acc && nb.courseId ? h('button.btn.small', { type: 'button', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await campus.sync(); toast('Material actualizado'); } catch (err) { toast(err.message, { error: true }); }
        renderMaterial(body, await db.get('notebooks', nb.id));
      } }, icon('sync'), 'Sincronizar') : null,
      h('label.btn.small', icon('plus'), 'Importar archivo', h('input', { type: 'file', hidden: true, accept: 'application/pdf,image/*', onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        await campus.importLocalFile(f, nb.id);
        renderMaterial(body, nb);
      } }))),
    sections.length ? sections : h('div.card.muted-card', h('p', nb.courseId ? 'El campus no tiene material publicado para esta materia (o todavía no sincronizaste).' : 'Esta materia no está vinculada al campus. Podés importar PDFs a mano.')),
    local.length ? h('section.card', h('h2.section-title', 'Importados'), h('ul.file-list', local.map(fileRow))) : null);

  // Marcar como visto lo que ya se mostró.
  for (const f of files.filter((x) => !x.seen)) await db.put('files', { ...f, seen: true });
}

function moduleLabel(type) {
  return { assign: 'Entrega', forum: 'Foro', quiz: 'Cuestionario', url: 'Enlace', page: 'Página', folder: 'Carpeta', zoom: 'Zoom', lti: 'Herramienta externa' }[type] || 'Abrir en el campus';
}

async function openFile(f) {
  try {
    const blob = await campus.download(f.id);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// Anotar un PDF: en la nota de hoy, en una nota nueva o en una existente.
function annotate(anchor, nb, f) {
  const addTo = async (note) => {
    try {
      await campus.download(f.id);
      const sizes = await pageSizes(f.id);
      note.blocks = [...note.blocks, ...sizes.map((s) => store.newInkBlock({ height: Math.round((store.PAPER_W * s.height) / s.width), pdf: { fileId: f.id, page: s.page, name: f.name } }))];
      await store.saveNote(note);
      go(`/nota/${note.id}`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  popover(anchor, [
    { label: 'Agregar a la nota de hoy', icon: 'today', onClick: async () => addTo(await store.noteForClass(nb.id, new Date())) },
    { label: 'Nota nueva con este PDF', icon: 'compose', onClick: async () => addTo(await store.createNote(nb.id, { title: f.name.replace(/\.pdf$/i, ''), blocks: [] })) },
    { label: 'Elegir otra nota…', icon: 'book', onClick: async () => {
      const notes = await store.notesOf(nb.id);
      if (!notes.length) { toast('No hay otras notas'); return; }
      const m = modal('Agregar a…', h('div.picker', notes.map((n) => h('button.picker-item', { type: 'button', onclick: () => { m.close(); addTo(n); } }, icon('compose'), h('div', h('div', store.noteTitle(n)), h('small', store.fmtDate(n.classDate)))))));
    } },
  ]);
}

function renderSchedule(body, nb) {
  const list = h('div.schedule');
  const draw = () => {
    list.replaceChildren(...(nb.schedule || []).map((slot, i) => h('div.slot',
      h('select.input', { onchange: (e) => { slot.day = Number(e.target.value); save(); } },
        [1, 2, 3, 4, 5, 6, 0].map((d) => h('option', { value: d, selected: Number(slot.day) === d }, store.DAYS[d]))),
      h('input.input', { type: 'time', value: slot.start, onchange: (e) => { slot.start = e.target.value; save(); } }),
      h('span', 'a'),
      h('input.input', { type: 'time', value: slot.end, onchange: (e) => { slot.end = e.target.value; save(); } }),
      h('input.input.grow', { placeholder: 'Aula (ej. Aula 205, Sáenz Valiente)', value: slot.room || '', onchange: (e) => { slot.room = e.target.value; save(); } }),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Quitar', onclick: () => { nb.schedule.splice(i, 1); save(); draw(); } }, icon('trash')))));
  };
  const save = () => store.saveNotebook(nb);
  draw();
  fill(body, h('section.card',
    h('h2.section-title', 'Horario semanal de cursada'),
    h('p.muted', 'Con esto Cuaderno sabe cuándo tenés clase: aparece en "Mi día", en el calendario, y la nota de cada clase se crea sola con la fecha. Si tu horario ya está en Google Calendar u Outlook, podés suscribirlo desde "Campus y calendarios".'),
    list,
    h('button.btn', { type: 'button', onclick: () => { nb.schedule = [...(nb.schedule || []), { day: 1, start: '08:30', end: '10:00', room: '' }]; save(); draw(); } }, icon('plus'), 'Agregar día de clase')));
}

function menu(anchor, nb) {
  popover(anchor, [
    { label: 'Renombrar', icon: 'compose', onClick: async () => { const v = await prompt('Nombre de la materia', { value: nb.name }); if (v) { nb.name = v; await store.saveNotebook(nb); go(`/cuaderno/${nb.id}`); } } },
    { label: 'Cambiar color', icon: 'sheet', onClick: () => {
      const m = modal('Color', h('div.swatches.big', store.COLORS.map((c) => h('button.swatch', { type: 'button', style: { background: c }, onclick: async () => { nb.color = c; await store.saveNotebook(nb); m.close(); go(`/cuaderno/${nb.id}`); } }))));
    } },
    '-',
    { label: nb.courseId ? 'Ocultar materia (no volver a sincronizar)' : 'Eliminar materia', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmDialog('Eliminar materia', 'Se borran la materia y todas sus notas de este dispositivo.', { ok: 'Eliminar', danger: true }))) return;
      if (nb.courseId) {
        const hidden = (await db.getSetting('hiddenCourses', [])) || [];
        await db.setSetting('hiddenCourses', [...new Set([...hidden, nb.courseId])]);
      }
      await store.deleteNotebook(nb.id);
      go('/hoy');
    } },
  ]);
}
