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

async function device(name, { demo = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/${demo ? '?demo' : ''}#/hoy`);
  await page.waitForTimeout(1200);
  await page.evaluate(async (url) => {
    const db = await import('/js/db.js');
    await db.setSetting('appKey', 'clave-test');
    await db.setSetting('syncUrlOverride', url);
  }, supaUrl);
  const run = (fn, arg) => page.evaluate(fn, arg);
  const sync = () => run(async () => (await import('/js/sync.js')).syncNow());
  return { page, run, sync };
}

try {
  const mac = await device('mac', { demo: true });
  const ipad = await device('ipad');

  // 1) Lo cargado en la Mac aparece en el iPad (incluida una grabación).
  await mac.run(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    const note = (await db.all('notes'))[0];
    await db.put('blobs', { id: 'rec:prueba', blob: new Blob(['audio de la clase'], { type: 'audio/mp4' }) });
    note.recordings = [{ id: 'prueba', blobId: 'rec:prueba', startedAt: Date.now(), duration: 1000 }];
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
    };
  });
  if (got.notebooks.length !== 3 || got.notes !== 2) throw new Error(`El iPad no recibió todo: ${JSON.stringify(got)}`);
  if (got.audio !== 'audio de la clase') throw new Error('No llegó la grabación');
  if (got.campus !== 'Carlos') throw new Error('No llegó la conexión del campus');
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

  // 5) Sin la clave correcta no se accede.
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
