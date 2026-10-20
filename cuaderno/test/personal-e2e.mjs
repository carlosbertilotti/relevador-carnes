// Personal: notas que no son de la facultad, en carpetas propias. No se mezclan
// con las materias (barra lateral, Mi día, calendario) pero sí se encuentran al
// buscar, se pueden mover y se sincronizan como cualquier cuaderno.
//   node test/personal-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const idb = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(600);
  const fin = await idb(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    const nb = await store.createNotebook({ name: 'Finanzas Corporativas' });
    await store.createNote(nb.id, { title: 'Clase 3 — estructura de capital' });
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0);
    await db.setSetting('campusEvents', [{ id: 'ev1', title: 'Entrega Trabajo Final', start: t.getTime(), end: t.getTime() + 3600000, kind: 'entrega', courseId: 999 }]);
    return nb.id;
  });
  await page.reload();

  const nav = page.locator('#sidebar a.nav-item', { hasText: 'Personal' });
  await nav.waitFor();
  await nav.click();
  await page.locator('.page.personal h1', { hasText: 'Personal' }).waitFor();
  if (!(await page.locator('.personal-empty').innerText()).includes('no son de la facultad')) throw new Error('Falta el texto de bienvenida');
  if (!(await nav.getAttribute('class')).includes('active')) throw new Error('"Personal" no queda marcado en la barra');
  step('La barra lateral tiene "Personal" y, vacía, explica para qué es');

  await page.locator('.page.personal .head-actions button', { hasText: 'Nueva nota' }).click();
  await page.waitForURL(/#\/nota\//);
  await page.locator('.editor-head .crumb', { hasText: 'Notas' }).waitFor();
  if (await page.locator('.watch-btn').count()) throw new Error('Una nota personal no debería tener "Ver clase"');
  if (await page.locator('.add-row button', { hasText: 'Material' }).count()) throw new Error('Una nota personal no debería tener "Material"');
  if ((await page.locator('input.note-title').getAttribute('placeholder')) !== 'Título') throw new Error('Placeholder del título');
  if (!(await nav.getAttribute('class')).includes('active')) throw new Error('Dentro de la nota, "Personal" debería quedar marcado');
  await page.locator('input.note-title').fill('Lista del súper');
  await page.locator('.text-block').first().click();
  await page.keyboard.type('leche, pan y café');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Volver' }).click();
  await page.locator('.page.personal .note-card', { hasText: 'Lista del súper' }).waitFor();
  const folder = await idb(async () => (await import('/js/db.js')).get('notebooks', 'nb_personal'));
  if (folder?.kind !== 'personal' || folder.name !== 'Notas' || !folder._mod) throw new Error(`Carpeta por defecto: ${JSON.stringify(folder)}`);
  if (!(await page.locator('.folder-bar .chip.on').innerText()).includes('Todas')) throw new Error('Debería estar en "Todas"');
  step('"Nueva nota" crea la nota en la carpeta "Notas" (lista para sincronizar), sin lo de clase, y vuelve a Personal');

  await page.locator('.folder-bar .chip.add').click();
  await page.locator('.modal input').fill('Trabajo Final');
  await page.locator('.modal button', { hasText: 'Crear' }).click();
  await page.locator('.page.personal h1', { hasText: 'Trabajo Final' }).waitFor();
  if (!(await page.locator('.personal-empty').innerText()).includes('vacía')) throw new Error('Carpeta nueva: falta "vacía"');
  await page.locator('.page.personal .head-actions button', { hasText: 'Nueva nota' }).click();
  await page.locator('.editor-head .crumb', { hasText: 'Trabajo Final' }).waitFor();
  await page.locator('input.note-title').fill('Ideas para el proyecto');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Volver' }).click();
  await page.locator('.page.personal .note-card', { hasText: 'Ideas para el proyecto' }).waitFor();
  if (await page.locator('.page.personal .note-card', { hasText: 'Lista del súper' }).count()) throw new Error('La carpeta muestra notas de otra');
  const chips = await page.locator('.folder-bar').innerText();
  if (!/Todas\s*2/.test(chips) || !/Notas\s*1/.test(chips) || !/Trabajo Final\s*1/.test(chips)) throw new Error(`Chips: ${chips}`);
  step('Se crean carpetas y cada una muestra sus notas (con cuántas hay en cada una)');

  const sideText = await page.locator('#sidebar .nb-groups').innerText();
  if (!sideText.includes('Finanzas Corporativas') || sideText.includes('Trabajo Final') || /\bNotas\b/.test(sideText)) throw new Error(`Materias en la barra: ${sideText}`);
  const ev = await idb(async () => {
    const store = await import('/js/store.js');
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const items = await store.agenda(from, new Date(from.getTime() + 3 * 86400000));
    return items.find((e) => e.title === 'Entrega Trabajo Final');
  });
  const tf = await idb(async () => (await (await import('/js/store.js')).personalFolders()).find((f) => f.name === 'Trabajo Final'));
  if (!ev || ev.notebookId === tf.id) throw new Error(`La entrega quedó en la carpeta personal: ${JSON.stringify(ev)}`);
  await page.goto(`${base}/#/hoy`);
  await page.getByRole('heading', { name: 'Notas recientes' }).waitFor();
  const recent = await page.locator('.note-grid').last().innerText();
  if (!recent.includes('Clase 3') || recent.includes('Lista del súper') || recent.includes('Ideas para el proyecto')) throw new Error(`Mi día mezcla notas personales: ${recent}`);
  step('Las carpetas personales no aparecen entre las materias, en Mi día ni se llevan las entregas del calendario');

  await page.goto(`${base}/#/buscar/${encodeURIComponent('café')}`);
  const res = page.locator('.result-list li', { hasText: 'Lista del súper' });
  await res.waitFor();
  if (!(await res.innerText()).includes('Notas')) throw new Error('El resultado no dice la carpeta');
  step('La búsqueda encuentra las notas personales y dice en qué carpeta están');

  await page.goto(`${base}/#/personal/${tf.id}`);
  await page.locator('.note-card', { hasText: 'Ideas para el proyecto' }).click();
  await page.waitForURL(/#\/nota\//);
  await page.locator('.editor-head button[title="Más"]').click();
  await page.locator('.popover .menu-item', { hasText: 'Mover a otra carpeta o materia' }).click();
  const picker = page.locator('.modal .picker');
  await picker.waitFor();
  if (!(await picker.innerText()).includes('está acá')) throw new Error('No marca dónde está la nota');
  await picker.locator('.picker-item', { hasText: 'Finanzas Corporativas' }).click();
  await page.locator('.editor-head .crumb', { hasText: 'Finanzas Corporativas' }).waitFor();
  const moved = await idb(async () => (await (await import('/js/db.js')).all('notes')).find((n) => n.title === 'Ideas para el proyecto'));
  if (moved.notebookId !== fin) throw new Error('No se movió');
  await page.locator('.editor-head button[title="Más"]').click();
  await page.locator('.popover .menu-item', { hasText: 'Mover a otra materia o a Personal' }).click();
  await page.locator('.modal .picker-item', { hasText: 'Notas' }).click();
  await page.locator('.editor-head .crumb', { hasText: 'Notas' }).waitFor();
  const back = await idb(async () => (await (await import('/js/db.js')).all('notes')).find((n) => n.title === 'Ideas para el proyecto'));
  if (back.notebookId !== 'nb_personal') throw new Error('No volvió a Personal');
  step('Una nota se mueve de una carpeta personal a una materia y de vuelta');

  await page.goto(`${base}/#/cuaderno/nb_personal`);
  await page.waitForURL(/#\/personal\/nb_personal$/);
  await page.locator('.page.personal h1', { hasText: 'Notas' }).waitFor();
  step('Abrir una carpeta personal como materia lleva a Personal');

  await page.goto(`${base}/#/personal/${tf.id}`);
  await page.getByRole('button', { name: 'Opciones de la carpeta' }).click();
  await page.locator('.popover .menu-item', { hasText: 'Renombrar' }).click();
  await page.locator('.modal input').fill('Laburo');
  await page.locator('.modal button', { hasText: 'Guardar' }).click();
  await page.locator('.page.personal h1', { hasText: 'Laburo' }).waitFor();
  await page.getByRole('button', { name: 'Opciones de la carpeta' }).click();
  await page.locator('.popover .menu-item', { hasText: 'Eliminar carpeta' }).click();
  if (!(await page.locator('.modal').innerText()).includes('está vacía')) throw new Error('El aviso no dice que está vacía');
  await page.locator('.modal button', { hasText: 'Eliminar' }).click();
  await page.waitForURL(/#\/personal$/);
  await page.locator('.page.personal h1', { hasText: 'Personal' }).waitFor();
  if ((await page.locator('.folder-bar').innerText()).includes('Laburo')) throw new Error('La carpeta sigue');
  await page.locator('.folder-bar .chip', { hasText: 'Notas' }).click();
  await page.getByRole('button', { name: 'Opciones de la carpeta' }).click();
  await page.locator('.popover .menu-item', { hasText: 'Eliminar carpeta' }).click();
  if (!(await page.locator('.modal').innerText()).includes('2 notas')) throw new Error('El aviso no dice cuántas notas se borran');
  await page.locator('.modal button', { hasText: 'Eliminar' }).click();
  await page.waitForURL(/#\/personal$/);
  const left = await idb(async () => (await (await import('/js/db.js')).all('notes')).map((n) => n.title));
  if (left.includes('Lista del súper') || left.includes('Ideas para el proyecto') || !left.includes('Clase 3 — estructura de capital')) throw new Error(`Notas: ${left}`);
  step('Las carpetas se renombran y se borran (avisando cuántas notas se van)');

  // Sin carpetas: una nota nueva vuelve a crear "Notas"; sin título se llama "Nota del …"
  await page.locator('.page.personal .head-actions button', { hasText: 'Nueva nota' }).click();
  await page.waitForURL(/#\/nota\//);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Volver' }).click();
  const card = page.locator('.page.personal .note-card').first();
  await card.waitFor();
  if (!/Nota del/.test(await card.innerText())) throw new Error(`Título por defecto: ${await card.innerText()}`);
  step('Sin carpetas, "Nueva nota" vuelve a crear "Notas"; sin título, la nota se llama "Nota del …"');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.page.personal').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`Scroll horizontal en el celular: ${overflow}px`);
  step('En el celular entra sin scroll horizontal');

  if (errors.length) throw new Error(`Errores en la página: ${errors.join(' | ')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
