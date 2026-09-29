// Una materia: sus notas de clase, el material del campus y el horario.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { openMaterial, blocksFromFile, canOpen } from '../editor/office.js';
import { h, fill, icon, popover, prompt, confirmDialog, toast, modal } from '../ui.js';
import { go } from '../router.js';
import { noteCard } from './today.js';
import { updateNotebookSummary, renderMarkdown, noteNeedsSummary, aiAvailable } from '../summary.js';

export async function renderNotebook(root, { id, tab = 'notas' }) {
  const nb = await db.get('notebooks', id);
  if (!nb) { root.replaceChildren(h('div.empty', 'Esta materia no existe.')); return; }
  const tabs = [['notas', 'Notas'], ['resumen', 'Resumen'], ['material', 'Material'], ['horario', 'Horario']];
  const body = h('div.tab-body');

  root.replaceChildren(h('div.page.notebook', { style: { '--c': nb.color } },
    h('header.page-head',
      h('div',
        h('p.eyebrow', [nb.courseId ? `Campus · ${nb.code || nb.shortname || 'materia'}` : 'Materia', { pasada: 'materia pasada', proxima: 'próxima' }[nb.status]].filter(Boolean).join(' · ')),
        h('h1.nb-name', nb.name)),
      h('div.head-actions',
        h('button.btn.primary', { type: 'button', onclick: async () => { const n = await store.noteForClass(nb.id, new Date()); go(`/nota/${n.id}`); } }, icon('compose'), 'Nota de hoy'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Opciones', onclick: (e) => menu(e.currentTarget, nb) }, icon('more')))),
    h('nav.tabs', tabs.map(([k, label]) => h(`button${k === tab ? '.active' : ''}`, { type: 'button', onclick: () => go(`/cuaderno/${nb.id}/${k}`) }, label))),
    body));

  if (tab === 'material') await renderMaterial(body, nb);
  else if (tab === 'resumen') await renderSummary(body, nb);
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
  const files = (await db.all('files')).filter((f) => f.notebookId === nb.id || (nb.courseId != null && f.courseId === nb.courseId));
  const byUrl = new Map(files.map((f) => [f.url, f]));
  const acc = await campus.account();

  const fileRow = (f) => h(`li.file-row${f.seen ? '' : '.unseen'}`,
    icon(campus.isPdf(f) ? 'pdf' : 'file'),
    h('div.grow', h('div', f.name), h('small', [store.fmtSize(f.size), f.modified ? `actualizado ${store.fmtDate(f.modified)}` : null, f.downloaded ? 'en el dispositivo' : 'sin descargar'].filter(Boolean).join(' · '))),
    h('div.row',
      canOpen(f) ? h('button.btn.small.primary', { type: 'button', title: 'Abrir en Cuaderno para editar y anotar', onclick: (e) => openInCuaderno(e.currentTarget, f) }, icon('compose'), 'Abrir') : null,
      canOpen(f) ? h('button.btn.small.ghost', { type: 'button', title: 'Más opciones', onclick: (e) => annotate(e.currentTarget, nb, f) }, icon('more')) : null,
      h('button.btn.small', { type: 'button', title: 'Abrir el archivo original del campus', onclick: () => openFile(f) }, f.downloaded ? 'Original' : icon('download'), f.downloaded ? null : 'Bajar')),
    f.downloadError && !f.downloaded ? h('small.error-text.file-err', `No se pudo bajar: ${f.downloadError}`) : null);

  // Si un archivo del campus todavía no está registrado en este dispositivo
  // (por ejemplo, llegó la materia por la nube antes que su material), se registra ahora.
  const ensure = async (s, m, file) => {
    if (byUrl.has(file.url) || nb.courseId == null) return;
    const id = campus.fileIdFor(nb.courseId, file.url);
    const meta = (await db.get('files', id)) || { id, courseId: nb.courseId, notebookId: nb.id, name: file.name, url: file.url, size: file.size, mimetype: file.mimetype, modified: file.modified, section: s.name, module: m.name, downloaded: false, seen: false, addedAt: Date.now() };
    if (!meta.downloaded && !(await db.get('files', id))) await db.put('files', meta);
    byUrl.set(file.url, meta);
  };
  for (const s of nb.sections || []) for (const m of s.modules) for (const file of m.files) await ensure(s, m, file);

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
async function openInCuaderno(btn, f) {
  btn.disabled = true;
  const label = btn.lastChild;
  try {
    const note = await openMaterial(f.id, (msg) => { label.textContent = msg; });
    go(`/nota/${note.id}`);
  } catch (err) {
    toast(err.message, { error: true, ms: 6000 });
    btn.disabled = false;
    label.textContent = 'Abrir';
  }
}

function annotate(anchor, nb, f) {
  const addTo = async (note) => {
    try {
      toast('Preparando el material…');
      note.blocks = [...note.blocks, ...(await blocksFromFile(f, await campus.download(f.id)))];
      await store.saveNote(note);
      go(`/nota/${note.id}`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  popover(anchor, [
    { label: 'Agregar a la nota de hoy', icon: 'today', onClick: async () => addTo(await store.noteForClass(nb.id, new Date())) },
    { label: 'Nota nueva con este archivo', icon: 'compose', onClick: async () => addTo(await store.createNote(nb.id, { title: f.name.replace(/\.[^.]+$/, ''), blocks: [] })) },
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
    { label: 'Renombrar', icon: 'compose', onClick: async () => { const v = await prompt('Nombre de la materia', { value: nb.name }); if (v) { nb.name = v; nb.nameManual = true; await store.saveNotebook(nb); go(`/cuaderno/${nb.id}`); } } },
    ...[['cursando', 'Mover a Cursando'], ['pasada', 'Mover a Materias pasadas']]
      .filter(([st]) => (nb.status || 'cursando') !== st)
      .map(([st, label]) => ({ label, icon: 'book', onClick: async () => {
        nb.status = st;
        nb.statusManual = nb.campusStatus && nb.campusStatus === st ? null : st;
        await store.saveNotebook(nb);
        toast(st === 'pasada' ? 'Movida a Materias pasadas' : 'Movida a Cursando');
        go(`/cuaderno/${nb.id}`);
      } })),
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

// ---------- Resumen con IA ----------
async function renderSummary(body, nb) {
  const status = h('p.muted.summary-status');
  const main = h('div.summary-doc');
  const perClass = h('div.summary-classes');
  let running = false;

  const draw = async () => {
    const fresh = await db.get('notebooks', nb.id);
    const notes = (await store.notesOf(nb.id)).sort((a, b) => (a.classDate || '').localeCompare(b.classDate || ''));
    if (fresh.summary?.md) {
      main.innerHTML = await renderMarkdown(fresh.summary.md);
    } else {
      main.replaceChildren(h('p.muted', notes.length ? 'Todavía no hay resumen. Se arma solo con tus notas.' : 'Cuando tomes notas en esta materia (texto, a mano o sobre el material), acá aparece el resumen.'));
    }
    const withSummary = notes.filter((n) => n.summary?.md);
    fill(perClass, withSummary.length ? h('h2.section-title', 'Resumen de cada clase') : null,
      await Promise.all(withSummary.reverse().map(async (n) => {
        const d = h('details.card.class-summary', h('summary', h('strong', n.title || store.noteTitle(n)), h('small.muted', ` · ${store.fmtDate(n.classDate)}`), noteNeedsSummary(n) ? h('span.badge', 'desactualizado') : null));
        const content = h('div.summary-doc');
        content.innerHTML = await renderMarkdown(n.summary.md);
        d.append(content, h('button.btn.small', { type: 'button', onclick: () => go(`/nota/${n.id}`) }, 'Abrir la nota'));
        return d;
      })));
    status.textContent = fresh.summary?.at
      ? `Actualizado ${store.fmtRelative(fresh.summary.at)} · basado en ${fresh.summary.count || withSummary.length} clase(s)`
      : '';
    return { notes, fresh };
  };

  const run = async (force = false) => {
    if (running) return;
    running = true;
    updateBtn.disabled = true;
    try {
      const r = await updateNotebookSummary(nb.id, { force, onProgress: (m) => { status.textContent = m; } });
      if (r.failures?.length) toast(`Algunas clases no se pudieron resumir:\n${r.failures.join('\n')}`, { error: true, ms: 8000 });
    } catch (err) {
      status.textContent = '';
      fill(errorBox, h('p.error-text', err.message), err.status === 503
        ? h('p.muted', 'Para activarlos, en Vercel → proyecto "cuaderno" → Settings → Environment Variables agregá ANTHROPIC_API_KEY con tu clave de la API de Claude y volvé a publicar.')
        : null);
    }
    running = false;
    updateBtn.disabled = false;
    await draw();
  };

  const errorBox = h('div');
  const updateBtn = h('button.btn.small.primary', { type: 'button', onclick: () => run(false) }, icon('sync'), 'Actualizar');
  fill(body,
    h('div.row.end', status, h('div.spacer'), updateBtn,
      h('button.btn.small', { type: 'button', title: 'Rehacer todos los resúmenes desde cero', onclick: async () => { if (await confirmDialog('Rehacer resumen', 'Se vuelven a resumir todas las clases de la materia. Puede tardar unos minutos.', { ok: 'Rehacer' })) run(true); } }, 'Rehacer todo')),
    errorBox,
    h('section.card.summary-card', main),
    perClass);

  const { notes, fresh } = await draw();
  // Se actualiza solo al entrar si hay notas nuevas o modificadas.
  const basis = notes.filter((n) => n.summary?.md).map((n) => `${n.id}:${n.summary.madeAt}`).join('|');
  if (!(await aiAvailable())) {
    fill(errorBox, h('div.card.muted-card',
      h('p', h('strong', 'Los resúmenes con IA todavía no están activados.')),
      h('p.muted', 'En Vercel → proyecto "cuaderno" → Settings → Environment Variables, agregá ANTHROPIC_API_KEY con tu clave de la API de Claude (console.anthropic.com) y volvé a publicar.')));
    updateBtn.disabled = true;
    return;
  }
  if (notes.some(noteNeedsSummary) || (basis && fresh.summary?.basis !== basis)) run(false);
}
