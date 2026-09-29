// Sincronización entre dos "dispositivos" (dos navegadores con almacenamiento
// separado) contra un Supabase simulado:  node test/sync-e2e.mjs
import { createServer } from '../server/server.js';
import { createMockSupabase } from './mock-supabase.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const supa = createMockSupabase();
const supaUrl = await supa.listen();
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);

async function device(name, { demo = false, url = supaUrl } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/${demo ? '?demo' : ''}#/hoy`);
  await page.waitForTimeout(1200);
  await page.evaluate(async (url) => {
    const db = await import('/js/db.js');
    await db.setSetting('appKey', 'clave-test');
    await db.setSetting('syncUrlOverride', url);
  }, url);
  const run = (fn, arg) => page.evaluate(fn, arg);
  const sync = () => run(async () => (await import('/js/sync.js')).syncNow());
  return { page, run, sync };
}

try {
  const mac = await device('mac', { demo: true });
  const ipad = await device('ipad');

  // 0) Lo guardado antes de que existiera la sincronización (sin _mod) también se sube.
  await mac.run(async () => {
    const db = await import('/js/db.js');
    await db.put('notes', { id: 'n_legacy', notebookId: (await db.all('notebooks'))[0].id, title: 'Nota vieja', blocks: [], recordings: [], createdAt: 5, updatedAt: 5, classDate: '2026-09-01' }, { remote: true });
    const legacy = await db.get('notes', 'n_legacy');
    if (legacy._mod) throw new Error('la nota de prueba no debería tener _mod');
  });

  // 1) Lo cargado en la Mac aparece en el iPad (incluida una grabación).
  await mac.run(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    const note = (await db.all('notes')).find((n) => n.blocks.some((b) => b.type === 'ink'));
    await db.put('blobs', { id: 'rec:prueba', blob: new Blob(['audio de la clase'], { type: 'audio/mp4' }) });
    note.recordings = [{ id: 'prueba', blobId: 'rec:prueba', startedAt: Date.now(), duration: 1000 }];
    // PDF del campus anotado en la nota (el otro dispositivo no tiene el campus conectado).
    await db.put('files', { id: 'c5_pdf1', courseId: 5, notebookId: note.notebookId, name: 'IntroOM.pdf', url: 'https://campusvirtual.utdt.edu/pluginfile.php/1/IntroOM.pdf', downloaded: true });
    await db.put('blobs', { id: 'file:c5_pdf1', blob: new Blob(['%PDF-falso'], { type: 'application/pdf' }) });
    note.blocks.push({ id: 'b_pdf', type: 'ink', paper: 'blank', height: 1414, strokes: [], pdf: { fileId: 'c5_pdf1', page: 1, name: 'IntroOM.pdf' } });
    await store.saveNote(note);
    await db.setSetting('campus', { url: 'https://campusvirtual.utdt.edu', token: 't', site: { user: 'Carlos' } });
  });
  const up = await mac.sync();
  const down = await ipad.sync();
  const got = await ipad.run(async () => {
    const db = await import('/js/db.js');
    return {
      notebooks: (await db.all('notebooks')).map((n) => n.name).sort(),
      notes: (await db.all('notes')).length,
      audio: await (await db.get('blobs', 'rec:prueba'))?.blob?.text(),
      campus: (await db.getSetting('campus'))?.site?.user,
      pdf: await (await db.get('blobs', 'file:c5_pdf1'))?.blob?.text(),
      pdfMarked: (await db.get('files', 'c5_pdf1'))?.downloaded,
    };
  });
  if (got.notebooks.length !== 3 || got.notes !== 3) throw new Error(`El iPad no recibió todo (incluida la nota vieja): ${JSON.stringify(got)}`);
  if (got.audio !== 'audio de la clase') throw new Error('No llegó la grabación');
  if (got.campus !== 'Carlos') throw new Error('No llegó la conexión del campus');
  if (got.pdf !== '%PDF-falso' || got.pdfMarked !== true) throw new Error(`No llegó el PDF anotado: ${JSON.stringify(got)}`);
  step(`Mac → iPad: ${up.pushed} cambios subidos, ${down.pulled} recibidos (materias, notas, grabación y campus)`);

  // 2) Lo que se edita en el iPad vuelve a la Mac.
  const noteId = await ipad.run(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    const note = (await db.all('notes')).find((n) => n.recordings?.length);
    note.title = 'Editada en el iPad';
    note.blocks.find((b) => b.type === 'ink').strokes.push({ tool: 'pen', color: '#000', size: 4, points: [[10, 10, 0.5], [200, 200, 0.5]] });
    await store.saveNote(note);
    return note.id;
  });
  await ipad.sync();
  await mac.sync();
  const macNote = await mac.run(async (id) => (await (await import('/js/db.js')).get('notes', id)), noteId);
  if (macNote.title !== 'Editada en el iPad' || !macNote.blocks.some((b) => b.strokes?.length)) throw new Error('La edición del iPad no llegó a la Mac');
  step('iPad → Mac: título y trazos a mano');

  // 3) Si se editan los dos, gana el cambio más reciente.
  await mac.run(async (id) => { const db = await import('/js/db.js'); const n = await db.get('notes', id); n.title = 'Mac (vieja)'; await db.put('notes', n); }, noteId);
  await new Promise((r) => setTimeout(r, 20));
  await ipad.run(async (id) => { const db = await import('/js/db.js'); const n = await db.get('notes', id); n.title = 'iPad (nueva)'; await db.put('notes', n); }, noteId);
  await mac.sync(); await ipad.sync(); await mac.sync();
  const titles = await Promise.all([mac, ipad].map((d) => d.run(async (id) => (await (await import('/js/db.js')).get('notes', id)).title, noteId)));
  if (titles.some((t) => t !== 'iPad (nueva)')) throw new Error(`Conflicto mal resuelto: ${titles}`);
  step('Conflicto: gana la edición más reciente en los dos dispositivos');

  // 4) Borrar en un dispositivo borra en el otro.
  await mac.run(async (id) => (await import('/js/store.js')).deleteNote(id), noteId);
  await mac.sync(); await ipad.sync();
  const still = await ipad.run(async (id) => !!(await (await import('/js/db.js')).get('notes', id)), noteId);
  if (still) throw new Error('El borrado no se sincronizó');
  step('Borrado sincronizado');

  // 5) La misma materia del campus creada por separado en cada dispositivo
  //    (como pasaba antes de sincronizar) se junta en una sola, sin perder notas ni material.
  await mac.run(async () => {
    const db = await import('/js/db.js');
    await db.put('notebooks', { id: 'nb_mac_viejo', name: 'Dirección de Operaciones', courseId: 777, schedule: [], sections: [{ name: 'Contenidos de las Clases', modules: [{ name: 'Clase 1', type: 'resource', files: [{ name: 'clase1.pdf', url: 'https://campusvirtual.utdt.edu/pluginfile.php/9/clase1.pdf', size: 10, modified: 1 }] }] }], createdAt: 1000 });
    await db.put('notes', { id: 'n_mac_op', notebookId: 'nb_mac_viejo', title: 'Nota de la Mac', blocks: [], recordings: [], createdAt: 1, updatedAt: 1, classDate: '2026-09-28' });
  });
  await ipad.run(async () => {
    const db = await import('/js/db.js');
    await db.put('notebooks', { id: 'nb_ipad_viejo', name: 'Dirección de Operaciones', courseId: 777, schedule: [], sections: [], createdAt: 2000 });
    await db.put('notes', { id: 'n_ipad_op', notebookId: 'nb_ipad_viejo', title: 'Nota del iPad', blocks: [], recordings: [], createdAt: 2, updatedAt: 2, classDate: '2026-09-28' });
  });
  await mac.sync(); await ipad.sync(); await mac.sync(); await ipad.sync();
  const views = await Promise.all([mac, ipad].map((d) => d.run(async () => {
    const db = await import('/js/db.js');
    const nbs = (await db.all('notebooks')).filter((n) => n.courseId === 777);
    const notes = (await db.all('notes')).filter((n) => nbs.some((nb) => nb.id === n.notebookId)).map((n) => n.title).sort();
    return { ids: nbs.map((n) => n.id), notes };
  })));
  for (const v of views) {
    if (v.ids.length !== 1 || v.ids[0] !== 'nb_mac_viejo' || v.notes.join() !== 'Nota de la Mac,Nota del iPad') throw new Error(`Materias duplicadas mal unidas: ${JSON.stringify(views)}`);
  }
  await ipad.page.goto(`${base}/#/cuaderno/nb_mac_viejo/material`);
  await ipad.page.locator('.file-row', { hasText: 'clase1.pdf' }).waitFor({ timeout: 10000 });
  step('Materia duplicada en dos dispositivos: se unió en una, con las notas de ambos y el material visible');

  // 6) Un dispositivo que ya había subido cosas nuevas y tiene la conexión del
  //    campus guardada desde antes de la sincronización (fecha vieja) igual la sube,
  //    con los eventos del calendario.
  const supa2 = createMockSupabase();
  const url2 = await supa2.listen();
  const safari = await device('safari', { url: url2 });
  const chrome = await device('chrome', { url: url2 });
  await safari.run(async () => {
    const db = await import('/js/db.js');
    await db.put('kv', { key: 'campus', value: { url: 'https://campusvirtual.utdt.edu', token: 't2', site: { user: 'Carlos Safari' }, lastSync: 1000 } }, { remote: true });
    await db.put('kv', { key: 'campusEvents', value: [{ id: 'moodle-1', title: 'Entrega TP', start: Date.now() + 86400000, end: Date.now() + 86400000, kind: 'entrega', source: 'campus' }] }, { remote: true });
    await db.setSetting('syncLegacyStamped', true); // versión anterior: ya "estampado"
    await db.setSetting('syncCursor', { pushed: Date.now(), pulled: 0 });
  });
  await safari.sync(); await chrome.sync();
  const fromSafari = await chrome.run(async () => {
    const db = await import('/js/db.js');
    return { events: ((await db.getSetting('campusEvents')) || []).map((e) => e.title), campus: (await db.getSetting('campus'))?.site?.user };
  });
  if (!fromSafari.events.includes('Entrega TP') || !fromSafari.campus) throw new Error(`No llegó el calendario/campus viejo: ${JSON.stringify(fromSafari)}`);
  supa2.server.close();
  step(`Campus y calendario guardados antes de sincronizar llegan igual al otro navegador (${fromSafari.campus})`);

  // 7) Sin la clave correcta no se accede.
  const bad = await device('intruso');
  await bad.run(async () => (await import('/js/db.js')).setSetting('appKey', 'otra'));
  const denied = await bad.run(async () => (await import('/js/sync.js')).syncNow().then(() => false, (e) => /Clave/.test(e.message)));
  if (!denied) throw new Error('Se pudo sincronizar con una clave incorrecta');
  step('Clave incorrecta rechazada');

  const real = errors.filter((e) => !/Clave de Cuaderno incorrecta/.test(e));
  if (real.length) throw new Error(`Errores:\n${real.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
  supa.server.close();
}
