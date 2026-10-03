// "Para esta clase": al tocar un día de cursada, qué PDFs y lecturas tocan,
// según la sección del campus de esa clase y el programa de la materia.
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { pdfText } from '../editor/pdf.js';
import { canOpen } from '../editor/office.js';
import { findSection, programExcerpt, filesMentioned, pickProgram, numberSessions } from '../lib/plan.js';
import { h, icon, modal } from '../ui.js';
import { go } from '../router.js';
import { openInCuaderno, openFile } from './notebook.js';

const DAY = 86400000;

// Todas las clases de la materia en el cuatrimestre, para saber el número de cada una.
async function sessionsOf(nb, around) {
  const from = new Date(Math.min(nb.startdate || Infinity, around - 240 * DAY));
  const to = new Date(Math.max(nb.enddate ? nb.enddate + DAY : 0, around + 150 * DAY));
  const items = await store.agenda(from, to);
  return numberSessions(items.filter((e) => e.kind === 'clase' && e.notebookId === nb.id));
}

// Texto del programa (se lee una vez y queda guardado en este dispositivo).
async function programText(file) {
  const key = `programText:${file.id}`;
  const cached = await db.getSetting(key, null);
  if (cached && cached.modified === (file.modified || 0)) return cached.text;
  const text = await pdfText(file.id, 40);
  await db.setSetting(key, { modified: file.modified || 0, text });
  return text;
}

export async function planFor(nb, ev) {
  const sessions = await sessionsOf(nb, ev.start);
  const me = sessions.find((s) => Math.abs(s.ev.start - ev.start) < 15 * 60000) || { n: null, weekend: null, total: sessions.length };
  const date = new Date(ev.start);
  const files = (await db.all('files')).filter((f) => f.notebookId === nb.id || (nb.courseId != null && f.courseId === nb.courseId));
  const byUrl = new Map(files.map((f) => [f.url, f]));

  // 1) La sección del campus de esa clase
  const section = findSection(nb.sections, { n: me.n, date, weekend: me.weekend });
  const sectionFiles = section ? section.modules.flatMap((m) => m.files.map((x) => byUrl.get(x.url)).filter(Boolean)) : [];
  const links = section ? (section.links || []).filter((l) => l.kind === 'zoom' || l.kind === 'video') : [];

  // 2) Lo que dice el programa de esa clase (o de esa fecha)
  const prog = pickProgram(files);
  let excerpt = null;
  let progError = null;
  if (prog) {
    try {
      excerpt = programExcerpt(await programText(prog), { n: me.n, date });
    } catch (err) {
      progError = err.message;
    }
  }
  const mentioned = filesMentioned(excerpt, files.filter((f) => f !== prog));

  // 3) Entregas de la materia entre la clase anterior y esta (inclusive)
  const prev = [...sessions].reverse().find((s) => s.ev.start < ev.start - 15 * 60000);
  const campusEvents = (await db.getSetting('campusEvents', [])) || [];
  const notebooks = await store.listNotebooks();
  const due = campusEvents
    .map((e) => store.classifyCampusEvent(e, notebooks))
    .filter((e) => e.notebookId === nb.id && e.kind !== 'clase' && e.start > (prev ? prev.ev.start : ev.start - 7 * DAY) && e.start < ev.end + DAY);

  const seen = new Set();
  const readings = [...sectionFiles, ...mentioned].filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
  return { n: me.n, total: me.total, section, readings, links, program: prog, excerpt, progError, due };
}

export async function showClassPlan(ev, nb) {
  const body = h('div.class-plan', h('p.muted', 'Buscando qué toca en esta clase…'));
  const title = `${nb.name}`;
  const m = modal(title, body, { wide: true });
  let plan;
  try {
    plan = await planFor(nb, ev);
  } catch (err) {
    body.replaceChildren(h('p.error-text', err.message));
    return m;
  }
  const fileRow = (f) => h('li.file-row',
    icon(campus.isPdf(f) ? 'pdf' : 'file'),
    h('div.grow', h('div', f.name), h('small', [f.section, f.downloaded ? 'en el dispositivo' : null].filter(Boolean).join(' · '))),
    h('div.row',
      canOpen(f) ? h('button.btn.small.primary', { type: 'button', onclick: (e) => { m.close(); openInCuaderno(e.currentTarget, f); } }, icon('compose'), 'Abrir') : null,
      h('button.btn.small', { type: 'button', onclick: () => openFile(f) }, 'Original')));

  const when = `${store.DAYS[new Date(ev.start).getDay()]} ${store.fmtDate(ev.start)} · ${store.fmtTime(ev.start)}`;
  body.replaceChildren(
    h('p.plan-when', plan.n ? h('strong', `Clase ${plan.n}${plan.total ? ` de ${plan.total}` : ''}`) : null, plan.n ? ' · ' : null, when,
      plan.section ? h('span.muted', ` · ${plan.section.name}`) : null),
    h('section',
      h('h3.section-title', 'Para leer y trabajar'),
      plan.readings.length
        ? h('ul.file-list', plan.readings.map(fileRow))
        : h('p.muted', plan.section || plan.excerpt
          ? 'No encontré archivos del campus para esta clase. Fijate lo que dice el programa abajo.'
          : 'No encontré en el campus ni en el programa qué toca esta clase.')),
    plan.links.length ? h('section',
      h('h3.section-title', 'Grabación'),
      h('ul.file-list', plan.links.map((l) => h('li.file-row.link', { onclick: () => window.open(l.url, '_blank', 'noopener') }, icon('video'), h('div.grow', h('div', l.label)))))) : null,
    plan.due.length ? h('section',
      h('h3.section-title', 'Entregas y avisos'),
      h('ul.event-list', plan.due.map((e) => h('li.event-row', h('span.dot'), h('div', h('div', e.title), h('small', `${store.fmtDate(e.start)} · ${store.fmtTime(e.start)}`)))))) : null,
    plan.excerpt ? h('section',
      h('h3.section-title', 'Según el programa'),
      h('blockquote.plan-excerpt', plan.excerpt),
      plan.program ? h('button.btn.small.ghost', { type: 'button', onclick: () => openFile(plan.program) }, icon('pdf'), plan.program.name) : null)
      : plan.program ? h('p.muted', plan.progError
        ? `No pude leer el programa (${plan.progError}).`
        : `El programa (${plan.program.name}) no detalla esta clase por número ni por fecha.`) : null,
    h('div.row.end',
      h('button.btn.primary', { type: 'button', onclick: async () => { m.close(); const n = await store.noteForClass(nb.id, ev.start); go(`/nota/${n.id}`); } }, icon('compose'), 'Tomar notas de esta clase')));
  return m;
}

// Para "Mi día": los nombres de lo que hay que leer, en una línea.
export async function readingsSummary(nb, ev) {
  try {
    return await planFor(nb, ev);
  } catch {
    return null; // en "Mi día" no se molesta con errores; el detalle está en "Qué leer"
  }
}
