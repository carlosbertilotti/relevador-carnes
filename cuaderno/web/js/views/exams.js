// "Preparación de exámenes": por materia, la fecha del próximo examen, una guía
// de estudio (temas que se repiten, trampas, fórmulas) y los exámenes anteriores,
// simulacros y soluciones para resolver a mano en Cuaderno.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { canOpen } from '../editor/office.js';
import { renderMarkdown } from '../summary.js';
import { h, fill, icon, toast, confirmDialog } from '../ui.js';
import { openInCuaderno, openFile } from './notebook.js';
import { go } from '../router.js';

const KINDS = [['examen', 'Examen anterior'], ['simulacro', 'Simulacro'], ['solucion', 'Solución'], ['guia', 'Guía / resumen']];
const EXAM_RE = /(examen|parcial|final|recuperatorio|coloquio)/i;
const DAY = 86400000;

// Exámenes de la materia que vienen en el calendario del campus.
export async function upcomingExams(nb, now = Date.now()) {
  const notebooks = await store.listNotebooks();
  const events = ((await db.getSetting('campusEvents', [])) || []).map((e) => store.classifyCampusEvent(e, notebooks));
  return events
    .filter((e) => e.notebookId === nb.id && EXAM_RE.test(e.title) && !/(consigna|deadline|se abre)/i.test(e.title) && e.start > now - DAY)
    .sort((a, b) => a.start - b.start);
}

// Para "Mi día": los exámenes de todas las materias en los próximos días, con la
// nota del simulacro (o del examen anterior) donde se practica.
export async function examsAhead(days = 21, now = Date.now()) {
  const notebooks = await store.listNotebooks();
  const byId = new Map(notebooks.map((n) => [n.id, n]));
  const events = ((await db.getSetting('campusEvents', [])) || []).map((e) => store.classifyCampusEvent(e, notebooks));
  const list = events
    .filter((e) => byId.has(e.notebookId) && EXAM_RE.test(e.title) && !/(consigna|deadline|se abre)/i.test(e.title) && e.start > now - 6 * 3600000 && e.start < now + days * DAY)
    .sort((a, b) => a.start - b.start);
  if (!list.length) return [];
  const files = (await db.all('files')).filter((f) => f.exam);
  const notes = await db.all('notes');
  const rank = { simulacro: 0, examen: 1 };
  return list.map((ev) => {
    const mine = files.filter((f) => f.notebookId === ev.notebookId && f.examKind in rank)
      .sort((a, b) => rank[a.examKind] - rank[b.examKind] || (a.examOrder ?? 99) - (b.examOrder ?? 99));
    let practice = null;
    for (const f of mine) {
      const note = notes.find((n) => n.notebookId === ev.notebookId && n.blocks?.some((b) => b.pdf?.fileId === f.id));
      if (note) { practice = { file: f, note }; break; }
    }
    if (!practice && mine[0]) practice = { file: mine[0], note: null };
    const days = Math.ceil((new Date(ev.start).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
    return { ev, nb: byId.get(ev.notebookId), days, practice, files: mine.length };
  });
}

export function examCard({ ev, nb, days, practice }) {
  const when = `${store.DAYS[new Date(ev.start).getDay()]} ${store.fmtDate(ev.start)} · ${store.fmtTime(ev.start)}`;
  const sent = practice?.note?.correction;
  const label = practice?.file.examKind === 'simulacro' ? 'simulacro' : 'examen anterior';
  return h('article.card.exam-next.exam-today', { style: { '--c': nb.color || '#8a8f98' } },
    h('div.grow',
      h('p.eyebrow', days <= 0 ? 'Examen hoy' : days === 1 ? 'Examen mañana' : 'Próximo examen'),
      h('h2', nb.name),
      h('p', [ev.title.split('|')[0].trim(), when].join(' · ')),
      sent ? h('p.muted', `Simulacro enviado a corregir ${store.fmtRelative(sent.at)}`) : null,
      h('div.row',
        practice?.note
          ? h('button.btn.primary', { type: 'button', onclick: () => go(`/nota/${practice.note.id}`) }, icon('compose'), practice.note.blocks.some((b) => b.strokes?.length) ? `Seguir el ${label}` : `Resolver el ${label}`)
          : practice ? h('button.btn.primary', { type: 'button', onclick: (e) => openInCuaderno(e.currentTarget, practice.file) }, icon('compose'), `Resolver el ${label}`) : null,
        h('button.btn', { type: 'button', onclick: () => go(`/cuaderno/${nb.id}/examenes`) }, icon('book'), 'Preparación'))),
    h('div.exam-days', h('strong', days <= 0 ? 'Hoy' : String(days)), days > 0 ? h('span', days === 1 ? 'día' : 'días') : null));
}

export async function renderExams(body, nb) {
  const fresh = (await db.get('notebooks', nb.id)) || nb;
  const files = (await db.all('files')).filter((f) => f.exam && f.notebookId === nb.id).sort((a, b) => (a.examOrder ?? 99) - (b.examOrder ?? 99) || b.addedAt - a.addedAt);
  const notes = await store.notesOf(nb.id);
  const noteFor = (f) => notes.find((n) => n.blocks?.some((b) => b.pdf?.fileId === f.id || b.image?.fileId === f.id));
  const exams = await upcomingExams(nb);

  // 1) Próximo examen
  const next = exams[0];
  const days = next ? Math.ceil((new Date(next.start).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY) : null;
  const countdown = next
    ? h('section.card.exam-next',
      h('div', h('p.eyebrow', 'Próximo examen'), h('h2', next.title),
        h('p', `${store.DAYS[new Date(next.start).getDay()]} ${store.fmtDate(next.start)} · ${store.fmtTime(next.start)}`)),
      h('div.exam-days', h('strong', days <= 0 ? 'Hoy' : String(days)), days > 0 ? h('span', days === 1 ? 'día' : 'días') : null))
    : h('section.card.muted-card', h('p', 'No hay un examen de esta materia en el calendario del campus.'));

  // 2) Guía de estudio (markdown con fórmulas)
  const guideView = h('div.summary-doc.exam-guide');
  const prep = fresh.examPrep || {};
  if (prep.md) guideView.innerHTML = await renderMarkdown(prep.md);
  else guideView.replaceChildren(h('p.muted', 'Todavía no hay guía. Escribí acá los temas que se repiten, las trampas y las fórmulas (podés usar fórmulas tipo $Q^* = \\sqrt{2DS/H}$).'));
  const editor = h('textarea.input.exam-guide-edit', { hidden: true, rows: 18, value: prep.md || '' });
  const editBtn = h('button.btn.small', { type: 'button', onclick: async () => {
    if (editor.hidden) { editor.hidden = false; guideView.hidden = true; editBtn.lastChild.textContent = 'Guardar'; editor.focus(); return; }
    const md = editor.value.trim();
    const cur = (await db.get('notebooks', nb.id)) || nb;
    cur.examPrep = { ...(cur.examPrep || {}), md, at: Date.now() };
    await store.saveNotebook(cur);
    toast('Guía guardada');
    renderExams(body, cur);
  } }, icon('compose'), h('span', prep.md ? 'Editar' : 'Escribir'));

  // 3) Exámenes anteriores, simulacros y soluciones
  const kindLabel = Object.fromEntries(KINDS);
  const fileRow = (f) => h('li.file-row',
    icon(campus.isPdf(f) ? 'pdf' : 'file'),
    h('div.grow', h('div', f.name), h('small', [kindLabel[f.examKind] || 'Material', f.examNote].filter(Boolean).join(' · '))),
    h('div.row',
      canOpen(f) ? (noteFor(f)
        ? h('button.btn.small.primary', { type: 'button', title: 'Seguir en la nota donde lo estás resolviendo', onclick: () => go(`/nota/${noteFor(f).id}`) }, icon('compose'), 'Seguir resolviendo')
        : h('button.btn.small.primary', { type: 'button', title: 'Abrir en Cuaderno para resolverlo a mano', onclick: (e) => openInCuaderno(e.currentTarget, f) }, icon('compose'), 'Resolver')) : null,
      h('button.btn.small', { type: 'button', onclick: () => openFile(f) }, 'Original'),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Quitar', onclick: async () => {
        if (!(await confirmDialog('Quitar archivo', `Se quita "${f.name}" de Preparación de exámenes.`, { ok: 'Quitar', danger: true }))) return;
        await db.del('files', f.id);
        await db.del('blobs', `file:${f.id}`);
        renderExams(body, nb);
      } }, icon('trash'))));

  const kindSel = h('select.input', KINDS.map(([k, l]) => h('option', { value: k }, l)));
  const upload = h('label.btn.small', icon('plus'), 'Subir examen o solución',
    h('input', { type: 'file', hidden: true, multiple: true, accept: 'application/pdf,image/*,.docx,.pptx', onchange: async (e) => {
      const list = [...e.target.files];
      for (const file of list) {
        const id = await campus.importLocalFile(file, nb.id);
        const f = await db.get('files', id);
        await db.put('files', { ...f, exam: true, examKind: kindSel.value });
      }
      toast(`${list.length} archivo(s) agregado(s)`);
      renderExams(body, nb);
    } }));

  const groups = KINDS.map(([k, l]) => [l, files.filter((f) => (f.examKind || 'examen') === k)]).filter(([, l]) => l.length);
  fill(body,
    countdown,
    h('section.card',
      h('div.row.space', h('h2.section-title', 'Guía de estudio'), editBtn),
      guideView, editor),
    h('section.card',
      h('div.row.space', h('h2.section-title', 'Exámenes anteriores y simulacros'), h('div.row', kindSel, upload)),
      groups.length
        ? groups.map(([label, list]) => h('div', h('h3.exam-group', label), h('ul.file-list', list.map(fileRow))))
        : h('p.muted', 'Subí los exámenes de años anteriores (PDF o fotos) para tenerlos a mano y resolverlos con el lápiz.')));
}
