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
    await db.put('files', { id: 'f_dove', courseId: 7703, notebookId: 'nb_mkt', name: 'DOVE EVOLUTION OF A BRAND.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 3', downloaded: true, srcUrl: '/exams/simulacro-dop-2026-10.pdf', addedAt: 10 });
    await db.put('files', { id: 'f_fin', courseId: 7706, notebookId: 'nb_fin', name: 'Clase 2 - Tasa de Descuento.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 2', downloaded: true, addedAt: 5 });
    await db.put('files', { id: 'f_eval', courseId: 7706, notebookId: 'nb_fin', name: 'Clase 1 - Evaluación de Proyectos.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 1', downloaded: true, srcUrl: '/exams/simulacro-dop-2026-10.pdf', addedAt: 4 });
    const t = (o) => todos.saveTodo({ done: false, createdAt: 1, ...o });
    await t({ id: 'r1', title: 'Pre-read de medios', due: '2026-10-28', notebookId: 'nb_mkt', minutes: 30, read: true, fileId: 'f_pre', order: 1 });
    await t({ id: 'r2', title: 'BMA cap. 17', due: '2026-10-28', notebookId: 'nb_fin', minutes: 60, read: true, order: 2 });
    await t({ id: 'r3', title: 'Caso Dove', due: '2026-10-29', notebookId: 'nb_mkt', minutes: 45, read: true, fileId: 'f_dove', order: 3 });
    await t({ id: 'r4', title: 'Slides de la clase 2', due: '2026-10-27', notebookId: 'nb_fin', read: true, fileId: 'f_fin', order: 4 });
    await t({ id: 'r5', title: 'Lectura sin archivo en este equipo', due: '2026-10-28', notebookId: 'nb_fin', read: true, fileId: 'no_esta', order: 5 });
    await t({ id: 'r6', title: 'Repasar slides "Evaluación de Proyectos" y la fórmula del FCF', due: '2026-10-28', notebookId: 'nb_fin', read: true, order: 8 });
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
  if (!/0 de 4 · 1 h 30 min/.test(txt)) throw new Error(`Progreso y tiempo del día: ${txt}`);
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
  const readRows = await read.locator('.todo.read').count();
  if (!readRows || (await read.locator('.todo.read button.todo-main').count()) !== readRows) throw new Error('Cada lectura debería ser un botón entero para abrirla');
  if (await tasks.locator('button.todo-main').count()) throw new Error('Las tareas comunes no son botones');
  step('Cada lectura es tocable entera y dice si su archivo está en el dispositivo; si el archivo no está, no rompe');

  // Tocar la lectura la abre acá mismo, en una nota de Cuaderno con el PDF
  await read.locator('.todo', { hasText: 'Caso Dove' }).locator('.todo-main').click();
  await page.waitForFunction(() => location.hash.startsWith('#/nota/'), null, { timeout: 20000 });
  await page.locator('.sheet').first().waitFor({ timeout: 20000 });
  let opened = await page.evaluate(async () => { const db = await import('/js/db.js'); const n = await db.get('notes', location.hash.split('/')[2]); return { src: n?.sourceFileId, sheets: n?.blocks.filter((b) => b.pdf).length }; });
  if (opened.src !== 'f_dove' || !opened.sheets) throw new Error(`La nota abierta: ${JSON.stringify(opened)}`);
  step('Tocar una lectura con archivo abre el PDF en una nota de Cuaderno, para leerlo y anotarlo ahí');

  // Sin archivo asignado: se lo busca por el nombre, queda asignado y se abre
  await page.goto(`${base}/#/hoy`);
  await page.locator('.read-today .todo', { hasText: 'Evaluación de Proyectos' }).locator('.todo-main').click();
  await page.waitForFunction(() => location.hash.startsWith('#/nota/'), null, { timeout: 20000 });
  opened = await page.evaluate(async () => { const db = await import('/js/db.js'); const n = await db.get('notes', location.hash.split('/')[2]); const t = await db.getSetting('todo:r6', null); return { src: n?.sourceFileId, fileId: t?.fileId }; });
  if (opened.src !== 'f_eval' || opened.fileId !== 'f_eval') throw new Error(`Adivinar el archivo: ${JSON.stringify(opened)}`);
  step('Una lectura sin archivo lo encuentra por el nombre entre el material de la materia, lo deja asignado y lo abre');

  // Sin archivo y sin nada parecido: lo dice en la fila y, al tocar, explica y ofrece ir al material
  await page.goto(`${base}/#/hoy`);
  const bma = page.locator('.read-today .todo', { hasText: 'BMA cap. 17' });
  if (!(await bma.innerText()).includes('no está en el campus')) throw new Error('La fila no avisa que la lectura no está en el campus');
  await bma.locator('.todo-main').click();
  const why = page.locator('.modal', { hasText: 'Esta lectura no está en el campus' });
  await why.waitFor();
  if (!(await why.innerText()).includes('Finanzas Corporativas')) throw new Error('No dice de qué materia');
  const stillNoFile = await page.evaluate(async () => (await (await import('/js/db.js')).getSetting('todo:r2', null))?.fileId ?? null);
  if (stillNoFile) throw new Error(`No debería asignar un archivo a ciegas: ${stillNoFile}`);
  await why.locator('button', { hasText: 'Ver el material' }).click();
  await page.waitForFunction(() => location.hash === '#/cuaderno/nb_fin/material', null, { timeout: 5000 });
  await page.goto(`${base}/#/hoy`);
  const orphanRow = page.locator('.read-today .todo', { hasText: 'Lectura sin archivo en este equipo' });
  if (!(await orphanRow.innerText()).includes('sin sincronizar')) throw new Error('La fila no avisa que el archivo no llegó');
  await orphanRow.locator('.todo-main').click();
  await page.locator('.modal', { hasText: 'todavía no llegó a este dispositivo' }).waitFor();
  await page.keyboard.press('Escape');
  step('Sin archivo en el campus (o sin sincronizar) lo dice en la fila y, al tocar, lo explica y ofrece el material');

  // Varios archivos posibles: se elige cuál
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const todos = await import('/js/todos.js');
    await db.put('files', { id: 'f_v1', courseId: 7706, notebookId: 'nb_fin', name: 'Valuing the Early-Stage Company.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 4', downloaded: true, srcUrl: '/exams/simulacro-dop-2026-10.pdf', addedAt: 40 });
    await db.put('files', { id: 'f_v2', courseId: 7706, notebookId: 'nb_fin', name: 'Initial Public Offerings.pdf', size: 40, mimetype: 'application/pdf', section: 'CLASE 4', downloaded: true, srcUrl: '/exams/simulacro-dop-2026-10.pdf', addedAt: 41 });
    await todos.saveTodo({ id: 'r7', title: 'Leer para la clase 4: Valuing the Early-Stage Company e Initial Public Offerings', due: '2026-10-28', notebookId: 'nb_fin', read: true, done: false, createdAt: 7, order: 7 });
    await todos.saveTodo({ id: 'r8', title: 'Ver la TEDx "El poder de la disciplina"', due: '2026-10-28', notebookId: 'nb_fin', read: true, url: 'https://www.youtube.com/watch?v=swrSlAg4PFE', done: false, createdAt: 8, order: 8 });
  });
  await page.reload();
  const two = page.locator('.read-today .todo', { hasText: 'Valuing the Early-Stage' });
  await two.waitFor();
  if (!(await two.innerText()).includes('2 archivos posibles')) throw new Error('No avisa que hay dos archivos posibles');
  await two.locator('.todo-main').click();
  const pick = page.locator('.modal', { hasText: '¿Cuál querés leer?' });
  await pick.waitFor();
  if ((await pick.locator('.picker-item').count()) !== 2) throw new Error('El selector debería mostrar los dos archivos');
  await pick.locator('.picker-item', { hasText: 'Initial Public Offerings.pdf' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/nota/'), null, { timeout: 20000 });
  const chose = await page.evaluate(async () => { const db = await import('/js/db.js'); const n = await db.get('notes', location.hash.split('/')[2]); return { src: n?.sourceFileId, fileId: (await db.getSetting('todo:r7', null))?.fileId }; });
  if (chose.src !== 'f_v2' || chose.fileId !== 'f_v2') throw new Error(`Elegir el archivo: ${JSON.stringify(chose)}`);
  step('Con varios archivos posibles pregunta cuál, abre el elegido y lo deja asignado');

  // Una lectura con enlace (un video) lo abre en otra pestaña
  await page.goto(`${base}/#/hoy`);
  const ted = page.locator('.read-today .todo', { hasText: 'El poder de la disciplina' });
  await ted.waitFor();
  if (!(await ted.innerText()).includes('video')) throw new Error('No dice que es un video');
  await ctx.route('https://www.youtube.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>video</p>' })); // sin salir a internet
  const [popup] = await Promise.all([page.waitForEvent('popup'), ted.locator('.todo-main').click()]);
  if (!popup.url().includes('swrSlAg4PFE')) throw new Error(`Abrió: ${popup.url()}`);
  await popup.close();
  step('Una lectura con enlace (una charla TEDx) se abre directo en otra pestaña');


  await page.goto(`${base}/#/hoy`);
  await read.locator('.todo', { hasText: 'Pre-read de medios' }).waitFor();

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
  if (!/1 de 6/.test(await read.innerText())) throw new Error(`El progreso de lecturas no avanzó: ${(await read.innerText()).match(/\d+ de \d+/)?.[0]}`); // 6 = las 4 del principio + las 2 agregadas arriba
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
  if (!(await added.locator('.todo-arrow .icon').count()) || (await added.locator('.todo-arrow.fwd').count())) throw new Error('La lectura agregada no muestra su archivo');
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
