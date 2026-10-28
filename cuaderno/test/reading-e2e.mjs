// "Para leer" en Mi día: las lecturas son tareas marcadas, con su sección, la semana para
// saltar de día, el archivo del campus a un toque y el mismo calendario de tareas.
//   node test/reading-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1100 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Miércoles 28/10/2026: la semana (lun 26 a dom 1/11) y los "próximos días" no dependen de cuándo se corre.
  await page.clock.setFixedTime(new Date('2026-10-28T10:00:00'));
  // Un PDF mínimo para "bajar" desde el propio sitio.
  await page.route('**/lectura-prueba.pdf', (r) => r.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF' }));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const todos = await import('/js/todos.js');
    await db.put('notebooks', { id: 'nb_mkt', name: 'Dirección de Marketing [C. Del Hoyo]', color: '#c2410c', schedule: [], sections: [], createdAt: 1 });
    await db.put('notebooks', { id: 'nb_fin', name: 'Finanzas Corporativas [M. Machinea]', color: '#9b6cd6', schedule: [], sections: [], createdAt: 2 });
    await db.put('files', { id: 'f_pre', courseId: 7703, notebookId: 'nb_mkt', name: 'PRE READ CLASE MEDIOS UTDT.pdf', size: 40, mimetype: 'application/pdf', section: 'Clase 4', downloaded: false, srcUrl: '/lectura-prueba.pdf', addedAt: 20 });
    await db.put('files', { id: 'f_dove', courseId: 7703, notebookId: 'nb_mkt', name: 'DOVE EVOLUTION OF A BRAND.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 3', downloaded: true, addedAt: 10 });
    await db.put('files', { id: 'f_fin', courseId: 7706, notebookId: 'nb_fin', name: 'Clase 2 - Tasa de Descuento.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 2', downloaded: true, addedAt: 5 });
    const t = (o) => todos.saveTodo({ done: false, createdAt: 1, ...o });
    await t({ id: 'r1', title: 'Pre-read de medios', due: '2026-10-28', notebookId: 'nb_mkt', minutes: 30, read: true, fileId: 'f_pre', order: 1 });
    await t({ id: 'r2', title: 'BMA cap. 17', due: '2026-10-28', notebookId: 'nb_fin', minutes: 60, read: true, order: 2 });
    await t({ id: 'r3', title: 'Caso Dove', due: '2026-10-29', notebookId: 'nb_mkt', minutes: 45, read: true, fileId: 'f_dove', order: 3 });
    await t({ id: 'r4', title: 'Slides de la clase 2', due: '2026-10-27', notebookId: 'nb_fin', read: true, fileId: 'f_fin', order: 4 });
    await t({ id: 'r5', title: 'Lectura sin archivo en este equipo', due: '2026-10-28', notebookId: 'nb_fin', read: true, fileId: 'no_esta', order: 5 });
    await t({ id: 't1', title: 'Guía U1', due: '2026-10-28', notebookId: 'nb_fin', order: 6 });
    await t({ id: 't2', title: 'Subir TP', due: '2026-10-30', notebookId: 'nb_mkt', order: 7 });
  });
  await page.reload();
  const read = page.locator('.read-today');
  const tasks = page.locator('.todo-today');
  await read.locator('.todo', { hasText: 'Pre-read de medios' }).waitFor();
  await tasks.locator('.todo', { hasText: 'Guía U1' }).waitFor();

  let txt = await read.innerText();
  if (!/Para leer/i.test(txt)) throw new Error('Falta el título "Para leer"');
  if (!txt.includes('Pre-read de medios') || !txt.includes('BMA cap. 17')) throw new Error(`Faltan las lecturas de hoy: ${txt}`);
  if (!/0 de 3 · 1 h 30 min/.test(txt)) throw new Error(`Progreso y tiempo del día: ${txt}`);
  if (!/Atrasadas · 1/i.test(txt) || !txt.includes('Slides de la clase 2')) throw new Error('Falta lo atrasado');
  if (!/Próximos días/i.test(txt) || !txt.includes('Caso Dove')) throw new Error('Faltan los próximos días');
  if (txt.includes('Guía U1') || txt.includes('Subir TP')) throw new Error('Las tareas comunes no van en "Para leer"');
  const tt = await tasks.innerText();
  if (tt.includes('Pre-read') || tt.includes('BMA cap. 17') || tt.includes('Caso Dove') || tt.includes('Slides de la clase 2')) throw new Error(`Las lecturas no deberían estar en "Para hacer": ${tt}`);
  if (!tt.includes('Guía U1') || !tt.includes('Subir TP')) throw new Error('Se perdieron las tareas comunes');
  if (/\bnull\b/.test(txt)) throw new Error('Quedó un "null" suelto en "Para leer"');
  if (await tasks.locator('.todo-readbox').count()) throw new Error('"Para hacer" no debería tener la casilla "Lectura": lo que se agrega ahí no se vería');
  step('"Para leer" muestra las lecturas de hoy (con minutos), lo atrasado y lo que viene; "Para hacer" queda sólo con las tareas');

  // Los puntos de la semana siguen a "Para hacer" (se redibujan las dos secciones juntas)
  const todayDot = '.week-strip .wk.today .wk-dot.on';
  if ((await page.locator(todayDot).count()) !== 1) throw new Error('Falta el punto de tareas comunes en hoy');
  await tasks.locator('.todo', { hasText: 'Guía U1' }).locator('.todo-check').click();
  await page.waitForFunction((q) => !document.querySelector(q), todayDot, { timeout: 4000 });
  await tasks.locator('.todo', { hasText: 'Guía U1' }).locator('.todo-check').click(); // otra vez pendiente
  await page.waitForFunction((q) => !!document.querySelector(q), todayDot, { timeout: 4000 });
  step('Tachar una tarea común en "Para hacer" actualiza el punto de ese día en la semana de "Para leer"');

  const pre = read.locator('.todo', { hasText: 'Pre-read de medios' });
  if (!(await pre.innerText()).includes('sin descargar')) throw new Error('No avisa que falta bajar el archivo');
  if (!(await read.locator('.todo', { hasText: 'Caso Dove' }).innerText()).includes('en el dispositivo')) throw new Error('No avisa que ya está en el dispositivo');
  if (!(await pre.locator('.todo-open').count()) || !(await read.locator('.todo', { hasText: 'Caso Dove' }).locator('.todo-open').count())) throw new Error('Falta el botón "Abrir" del archivo');
  const orphan = read.locator('.todo', { hasText: 'Lectura sin archivo en este equipo' });
  if (await orphan.locator('.todo-open').count()) throw new Error('Un archivo que no está en este equipo no debería tener "Abrir"');
  step('Cada lectura con archivo tiene "Abrir" y dice si está en el dispositivo; si el archivo no está, no rompe');

  const bajar = read.locator('.read-download button');
  if (!/\(1\)/.test(await bajar.innerText())) throw new Error(`Botón de bajar: ${await bajar.innerText()}`);
  await bajar.click();
  await read.locator('.todo', { hasText: 'Pre-read de medios' }).locator('small', { hasText: 'en el dispositivo' }).waitFor({ timeout: 5000 });
  if (await read.locator('.read-download').count()) throw new Error('El botón de bajar sigue después de bajar todo');
  if (/\bnull\b/.test(await read.innerText())) throw new Error('Quedó un "null" suelto después de bajar todo');
  const got = await page.evaluate(async () => { const db = await import('/js/db.js'); const f = await db.get('files', 'f_pre'); const b = await db.get('blobs', 'file:f_pre'); return { downloaded: f.downloaded, size: b?.blob?.size || 0 }; });
  if (!got.downloaded || !got.size) throw new Error(`No quedó guardado: ${JSON.stringify(got)}`);
  step('"Bajar lo que falta" guarda las lecturas para leer sin conexión y el botón desaparece');

  await read.locator('.todo', { hasText: 'BMA cap. 17' }).locator('.todo-check').click();
  await page.waitForTimeout(700);
  if (!/1 de 3/.test(await read.innerText())) throw new Error('El progreso de lecturas no avanzó');
  const stored = await page.evaluate(async () => { const db = await import('/js/db.js'); const r = await db.get('kv', 'todo:r2'); return { done: r.value.done, read: r.value.read, synced: db.isSyncedKey('todo:r2') }; });
  if (!stored.done || stored.read !== true || !stored.synced) throw new Error(`Guardado: ${JSON.stringify(stored)}`);
  step('Tachar una lectura la marca hecha (sigue siendo lectura) y se sincroniza como cualquier tarea');

  // La semana: mismo calendario de tareas, un toque lleva a ese día
  const strip = read.locator('.week-strip .wk');
  if ((await strip.count()) !== 7) throw new Error('La semana no tiene 7 días');
  if (!(await read.locator('.week-strip .wk.sel.today').innerText()).includes('28')) throw new Error('No marca hoy (mié 28)');
  const jue = strip.filter({ hasText: '29' });
  if (!/1 lectura pendiente/.test(await jue.getAttribute('aria-label'))) throw new Error(`Jueves: ${await jue.getAttribute('aria-label')}`);
  await jue.click();
  await page.waitForFunction(() => location.hash === '#/hoy/2026-10-29');
  await page.locator('.page-head h1', { hasText: 'Jueves 29' }).waitFor(); // la vista nueva, no la anterior
  await page.locator('.read-today .todo', { hasText: 'Caso Dove' }).waitFor();
  txt = await page.locator('.read-today').innerText();
  if (!/Mañana/i.test(txt) || txt.includes('BMA cap. 17') || /Atrasadas/i.test(txt)) throw new Error(`Jueves 29: ${txt}`);
  if (!/Jueves 29 de octubre/.test(await page.locator('.page-head h1').innerText())) throw new Error('El título no es el del jueves');
  if (!(await page.locator('.week-strip .wk.sel').innerText()).includes('29')) throw new Error('La semana no marca el día elegido');
  step('La semana de "Para leer" muestra qué días tienen lecturas y un toque abre ese día');

  // Agregar una lectura desde Mi día, con su archivo
  const rd = page.locator('.read-today');
  await rd.locator('.todo-new').fill('Repasar el caso Dove');
  await rd.locator('.todo-nb').selectOption('nb_mkt');
  await rd.locator('.todo-file option', { hasText: 'DOVE' }).waitFor({ state: 'attached' }); // los archivos de la materia se cargan al elegirla
  const opts = await rd.locator('.todo-file option').allInnerTexts();
  if (!opts.includes('DOVE EVOLUTION OF A BRAND.pdf') || opts.some((o) => o.includes('Tasa de Descuento'))) throw new Error(`Archivos de la materia: ${opts}`);
  await rd.locator('.todo-file').selectOption('f_dove');
  await rd.locator('.todo-new').press('Enter');
  const added = rd.locator('.todo.read', { hasText: 'Repasar el caso Dove' });
  await added.waitFor();
  if (!(await added.locator('.todo-open').count())) throw new Error('La lectura agregada no tiene su archivo');
  const rec = await page.evaluate(async () => { const todos = await import('/js/todos.js'); return (await todos.listTodos()).find((t) => t.title === 'Repasar el caso Dove'); });
  if (rec.read !== true || rec.fileId !== 'f_dove' || rec.due !== '2026-10-29') throw new Error(`Lectura nueva: ${JSON.stringify(rec)}`);
  step('Se agregan lecturas desde Mi día eligiendo el archivo de la materia');

  // Tareas: todo junto, con "Solo lecturas" y la casilla Lectura
  await page.goto(`${base}/#/tareas`);
  const tp = page.locator('.page.tasks');
  await tp.locator('.todo', { hasText: 'Guía U1' }).waitFor();
  if (!(await tp.locator('.todo.read', { hasText: 'Pre-read de medios' }).count())) throw new Error('Las lecturas no están en Tareas');
  await tp.locator('.tasks-toggle', { hasText: 'Solo lecturas' }).locator('input').check();
  await page.waitForTimeout(300);
  txt = await tp.innerText();
  if (txt.includes('Guía U1') || txt.includes('Subir TP') || !txt.includes('Caso Dove')) throw new Error(`Solo lecturas: ${txt}`);
  if (!(await tp.locator('.todo-readbox input').isChecked())) throw new Error('Con "Solo lecturas" la casilla "Lectura" debería arrancar tildada');
  await tp.locator('.todo-new').fill('Capítulo 7 con el filtro puesto');
  await tp.locator('.todo-new').press('Enter');
  await tp.locator('.todo.read', { hasText: 'Capítulo 7 con el filtro puesto' }).waitFor({ timeout: 3000 }); // no desaparece
  await tp.locator('.tasks-toggle', { hasText: 'Solo lecturas' }).locator('input').uncheck();
  if (await tp.locator('.todo-readbox input').isChecked()) throw new Error('Sin el filtro la casilla vuelve a empezar destildada');
  await tp.locator('.todo-new').fill('Leer el capítulo 5');
  await tp.locator('.todo-readbox input').check();
  await tp.locator('.todo-new').press('Enter');
  await tp.locator('.todo.read', { hasText: 'Leer el capítulo 5' }).waitFor();
  await tp.locator('.todo-new').fill('Llamar al grupo');
  await tp.locator('.todo-new').press('Enter');
  await tp.locator('.todo', { hasText: 'Llamar al grupo' }).waitFor();
  const flags = await page.evaluate(async () => { const todos = await import('/js/todos.js'); const l = await todos.listTodos(); return { cap: l.find((t) => t.title === 'Leer el capítulo 5').read, llamar: l.find((t) => t.title === 'Llamar al grupo').read }; });
  if (flags.cap !== true || flags.llamar) throw new Error(`Casilla Lectura: ${JSON.stringify(flags)}`);
  step('En Tareas están todas juntas: "Solo lecturas" filtra y la casilla "Lectura" decide qué se agrega');

  // Calendario: las lecturas aparecen en su día y llevan a ese día de Mi día
  await page.goto(`${base}/#/calendario/2026-10-28`);
  const chip = page.locator('.cal-chip.task.read', { hasText: 'Pre-read de medios' });
  await chip.waitFor();
  if (!(await chip.innerText()).includes('📖')) throw new Error('La lectura no se distingue en el calendario');
  if ((await chip.getAttribute('href')) !== '#/hoy/2026-10-28') throw new Error(`El enlace del calendario: ${await chip.getAttribute('href')}`);
  await chip.click();
  await page.waitForFunction(() => location.hash === '#/hoy/2026-10-28');
  await page.locator('.read-today .todo', { hasText: 'Pre-read de medios' }).waitFor();
  await page.locator('.read-today a', { hasText: 'Calendario' }).click();
  await page.waitForFunction(() => location.hash === '#/calendario/2026-10-28');
  await page.locator('.cal-chip.task', { hasText: 'Guía U1' }).waitFor();
  step('El calendario muestra las lecturas con un 📖, lleva a ese día de Mi día y "Para leer" vuelve a la semana del calendario');

  // Celular
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const todos = await import('/js/todos.js');
    await db.put('files', { id: 'f_big', courseId: 7703, notebookId: 'nb_mkt', name: 'Un archivo con un nombre bastante largo para la lectura.pdf', size: 40, mimetype: 'application/pdf', downloaded: false, srcUrl: '/lectura-prueba.pdf', addedAt: 30 });
    await todos.saveTodo({ id: 'r9', title: 'Otra lectura por bajar', due: '2026-10-28', notebookId: 'nb_mkt', read: true, fileId: 'f_big', done: false, createdAt: 9, order: 9 });
  });
  await page.goto(`${base}/#/hoy`);
  await page.locator('.read-today .read-download .btn').waitFor();
  const btnBox = await page.evaluate(() => { const r = document.querySelector('.read-download .btn').getBoundingClientRect(); return { right: Math.round(r.right), vw: document.documentElement.clientWidth }; });
  if (btnBox.right > btnBox.vw) throw new Error(`El botón de bajar se sale de la pantalla a 320px: ${JSON.stringify(btnBox)}`);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${base}/#/hoy`);
  await page.locator('.read-today .todo').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`Scroll horizontal en celular: ${overflow}px`);
  const wk = await page.evaluate(() => [...document.querySelectorAll('.week-strip .wk')].map((b) => Math.round(b.getBoundingClientRect().width)));
  if (wk.length !== 7 || Math.min(...wk) < 40) throw new Error(`Semana en celular: ${wk}`);
  step('En el celular entra sin scroll horizontal y la semana se lee entera');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
