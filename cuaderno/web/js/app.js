import * as db from './db.js';
import * as store from './store.js';
import * as campus from './campus.js';
import { h, icon, prompt, toast } from './ui.js';
import { go, current } from './router.js';
import { applyTheme } from './theme.js';
import { renderToday } from './views/today.js';
import { renderCalendar } from './views/calendar.js';
import { renderNotebook } from './views/notebook.js';
import { renderCampus, renderSettings } from './views/settings.js';
import { openEditor } from './editor/editor.js';

const sidebar = document.getElementById('sidebar');
const main = document.getElementById('main');
let cleanup = null;
let searchInput;
const NB_GROUPS = [['cursando', 'Cursando'], ['proxima', 'Próximas'], ['pasada', 'Materias pasadas']];
const openGroups = new Set();

async function renderSidebar() {
  const { name, params } = current();
  const notebooks = await store.listNotebooks();
  const files = await db.all('files');
  const unseen = new Map();
  for (const f of files) if (!f.seen && !f.local) unseen.set(f.notebookId, (unseen.get(f.notebookId) || 0) + 1);
  const acc = await campus.account();
  const activeNb = name === 'cuaderno' ? params[0] : name === 'nota' ? sidebar.dataset.noteNotebook : null;

  const link = (path, ic, label, active, extra) => h(`a.nav-item${active ? '.active' : ''}`, { href: `#${path}` }, icon(ic), h('span', label), extra || null);
  searchInput = h('input.search', {
    type: 'search',
    placeholder: 'Buscar en tus notas',
    value: name === 'buscar' ? params[0] || '' : '',
    oninput: (e) => { const q = e.target.value; if (q.trim()) go(`/buscar/${encodeURIComponent(q)}`); else go('/hoy'); },
  });
  sidebar.replaceChildren(
    h('div.brand', h('span.logo', '✎'), h('span', 'Cuaderno'),
      h('button.icon-btn.collapse', { type: 'button', 'aria-label': 'Ocultar barra', onclick: () => document.body.classList.toggle('sidebar-hidden') }, icon('sidebar'))),
    h('label.search-wrap', icon('search'), searchInput),
    h('nav.nav',
      link('/hoy', 'today', 'Mi día', name === 'hoy'),
      link('/calendario', 'calendar', 'Calendario', name === 'calendario')),
    h('div.nav-title', h('span', 'Materias'), h('button.icon-btn.small', { type: 'button', 'aria-label': 'Nueva materia', onclick: async () => {
      const v = await prompt('Nueva materia', { placeholder: 'Ej. Macroeconomía II', ok: 'Crear' });
      if (v) { const nb = await store.createNotebook({ name: v }); go(`/cuaderno/${nb.id}/horario`); }
    } }, icon('plus'))),
    notebooks.length
      ? h('div.nb-groups', NB_GROUPS.map(([status, label]) => {
        const list = notebooks.filter((nb) => (nb.status || 'cursando') === status);
        if (!list.length) return null;
        const open = status !== 'pasada' || openGroups.has(status) || list.some((nb) => nb.id === activeNb);
        return h('div.nb-group',
          status === 'cursando' && list.length === notebooks.length ? null : h('button.nb-group-title', {
            type: 'button',
            'aria-expanded': String(open),
            onclick: () => { if (openGroups.has(status)) openGroups.delete(status); else openGroups.add(status); renderSidebar(); },
          }, h('span', `${open ? '▾' : '▸'} ${label}`), h('small', list.length)),
          open ? h('nav.nav.notebooks', list.map((nb) => h(`a.nav-item.nb${activeNb === nb.id ? '.active' : ''}${status === 'pasada' ? '.past' : ''}`, { href: `#/cuaderno/${nb.id}`, style: { '--c': nb.color } },
            h('span.nb-dot'), h('span.nb-label', nb.name, nb.code ? h('small.nb-code', nb.code) : null), unseen.get(nb.id) ? h('span.count', unseen.get(nb.id)) : null))) : null);
      }))
      : h('p.muted.small-pad', 'Conectá el campus o creá una materia.'),
    h('div.grow'),
    h('nav.nav',
      link('/campus', 'campus', 'Campus y calendarios', name === 'campus', acc?.error ? h('span.count.warn', '!') : campus.syncing() ? h('span.spinner') : null),
      link('/ajustes', 'settings', 'Ajustes', name === 'ajustes')),
    h('button#sync-badge.sync-badge', { type: 'button', title: 'Sincronizar ahora', onclick: () => import('./sync.js').then((s) => s.syncNow()).catch((err) => toast(err.message, { error: true })) }));
  renderSyncBadge();
}

async function renderSearch(root, q) {
  const results = await store.searchNotes(q);
  const files = (await db.all('files')).filter((f) => store.normalize(f.name).includes(store.normalize(q)));
  root.replaceChildren(h('div.page.search-page',
    h('header.page-head', h('div', h('p.eyebrow', 'Buscar'), h('h1', `“${q}”`))),
    results.length || files.length ? null : h('p.muted', 'Sin resultados.'),
    results.length ? h('section', h('h2.section-title', 'Notas'), h('ul.result-list', results.map(({ note, notebook, snippet }) => h('li', { onclick: () => go(`/nota/${note.id}`) },
      h('span.dot', { style: { background: notebook?.color } }),
      h('div', h('strong', store.noteTitle(note)), h('small', `${notebook?.name || ''} · ${store.fmtDate(note.classDate)}`), h('p', highlight(snippet, q))))))) : null,
    files.length ? h('section', h('h2.section-title', 'Material'), h('ul.result-list', files.map((f) => h('li', { onclick: () => go(`/cuaderno/${f.notebookId}/material`) }, icon('file'), h('div', h('strong', f.name), h('small', f.section || '')))))) : null));
}

function highlight(text, q) {
  const i = store.normalize(text).indexOf(store.normalize(q));
  if (i < 0) return text;
  return [text.slice(0, i), h('mark', text.slice(i, i + q.length)), text.slice(i + q.length)];
}

// Clase en vivo: si otro dispositivo (la compu) arranca la grabación de una
// clase, este (el iPad) abre la nota de esa clase con el cronómetro sincronizado.
let liveWatch = null;
store.bus.addEventListener('live', async (e) => {
  const st = e.detail;
  if (!st.playing || !st.isNew || !st.noteId) return;
  const { name, params } = current();
  if (name === 'nota' && params[0] === st.noteId) return; // ya está abierta: el editor la sigue solo
  let note = await db.get('notes', st.noteId);
  for (let i = 0; !note && i < 3; i++) {
    await import('./sync.js').then((s) => s.syncNow()).catch(() => {});
    note = await db.get('notes', st.noteId);
    if (!note) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!note && st.notebookId && (await db.get('notebooks', st.notebookId))) {
    // Todavía no llegó la nota: se crea con el mismo id (la de la compu la completa al sincronizar).
    await db.put('notes', { id: st.noteId, notebookId: st.notebookId, title: st.title || '', classDate: store.ymd(), blocks: [store.newTextBlock(), store.newInkBlock({ paper: 'lined' })], pinned: false, recordings: [], video: { url: st.url || null, title: st.title || '' }, createdAt: Date.now(), updatedAt: Date.now(), _mod: 1 }, { remote: true });
    note = true;
  }
  if (!note) return;
  liveWatch = st.noteId;
  toast(`Clase en curso en otro dispositivo${st.title ? `: ${st.title}` : ''}`);
  go(`/nota/${st.noteId}`);
});

async function route() {
  const { name, params } = current();
  if (cleanup) { const c = cleanup; cleanup = null; await c(); }
  document.body.classList.toggle('in-editor', name === 'nota');
  main.scrollTop = 0;
  try {
    switch (name) {
      case 'hoy': await renderToday(main, { date: params[0] }); break;
      case 'calendario': await renderCalendar(main, { date: params[0] }); break;
      case 'cuaderno': await renderNotebook(main, { id: params[0], tab: params[1] }); break;
      case 'nota': {
        const note = await db.get('notes', params[0]);
        sidebar.dataset.noteNotebook = note?.notebookId || '';
        const watch = liveWatch === params[0];
        liveWatch = null;
        cleanup = await openEditor(main, params[0], { watch, back: () => (history.length > 1 ? history.back() : go(note ? `/cuaderno/${note.notebookId}` : '/hoy')) });
        break;
      }
      case 'campus': await renderCampus(main); break;
      case 'ajustes': await renderSettings(main); break;
      case 'buscar': await renderSearch(main, params[0] || ''); break;
      default: go('/hoy'); return;
    }
  } catch (err) {
    console.error(err);
    main.replaceChildren(h('div.page', h('h1', 'Algo salió mal'), h('p.error-text', err.message)));
  }
  const focusSearch = name === 'buscar' && document.activeElement === searchInput;
  await renderSidebar();
  if (focusSearch) { searchInput.focus(); searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); }
  if (window.innerWidth < 820 && name !== 'buscar') document.body.classList.add('sidebar-hidden');
}

// Re-dibujar la barra lateral (y la vista, si no es el editor) cuando cambian los datos.
let pending = null;
store.bus.addEventListener('change', (e) => {
  if (e.detail?.silent) return;
  clearTimeout(pending);
  pending = setTimeout(async () => {
    await renderSidebar();
    const { name } = current();
    if (e.detail?.type === 'campus' && (name === 'hoy' || name === 'cuaderno')) route();
    // Llegaron cambios de otro dispositivo: refrescar la vista (el editor se actualiza solo).
    if (e.detail?.type === 'sync' && ['hoy', 'calendario', 'cuaderno', 'buscar'].includes(name)) route();
  }, 150);
});

// Indicador de sincronización en la barra lateral.
store.bus.addEventListener('sync', () => { renderSyncBadge(); });
async function renderSyncBadge() {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  const { state } = await import('./sync.js');
  el.className = `sync-badge${state.error ? ' err' : state.running ? ' busy' : ''}`;
  el.textContent = state.error ? `Sin sincronizar: ${state.error}` : state.running ? 'Sincronizando…' : state.lastOk ? `Sincronizado ${store.fmtRelative(state.lastOk)}` : '';
}

// Versión nueva publicada: el iPad o la compu pueden quedar días con la app
// abierta, así que se busca la actualización al volver a la app y se recarga sola
// (dentro de una nota, recién al salir de ella, para no cortar lo que se escribe).
function watchUpdates(reg) {
  let hadController = !!navigator.serviceWorker.controller;
  let pending = false;
  const reload = () => setTimeout(() => location.reload(), 800);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (pending) return;
    pending = true;
    if (!location.hash.includes('/nota/')) { reload(); return; }
    toast('Hay una versión nueva de Cuaderno: se actualiza al salir de esta nota', { ms: 6000 });
    window.addEventListener('hashchange', reload, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) reload(); });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  setInterval(() => reg.update().catch(() => {}), 30 * 60000);
}

async function start() {
  await applyTheme();
  await campus.refreshCourseNames().catch(() => {});
  await store.mergeDuplicateNotebooks().catch(() => {});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('sidebar-hidden'));
  window.addEventListener('hashchange', route);
  await route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').then(watchUpdates).catch(() => {});
  }
  // Sincronizaciones de fondo al abrir.
  campus.maybeAutoSync();
  const cals = (await db.getSetting('icsCalendars', [])) || [];
  if (cals.some((c) => c.url && (!c.syncedAt || Date.now() - c.syncedAt > 6 * 3600000))) store.refreshIcs(campus.api).catch(() => {});
  window.addEventListener('online', () => campus.maybeAutoSync());
  const demo = new URLSearchParams(location.search).has('demo');
  if (demo) { const { seedDemo } = await import('./demo.js'); await seedDemo(); toast('Datos de ejemplo cargados'); route(); }
  // Sincronización entre dispositivos (no con datos de ejemplo ni en pruebas automáticas).
  if (!demo && !navigator.webdriver) {
    const sync = await import('./sync.js');
    sync.start(store.bus);
    (await import('./live.js')).start();
    // En un dispositivo nuevo la cuenta del campus llega por la nube: sincronizar el campus después.
    store.bus.addEventListener('change', (e) => { if (e.detail?.type === 'sync') campus.maybeAutoSync(); });
  }
}

start();
