// Tareas: se agregan, se tachan (y quedan tachadas), aparecen en Mi día, en la
// página Tareas y en el calendario, y se sincronizan una por una.
//   node test/tasks-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    const todos = await import('/js/todos.js');
    await db.put('notebooks', { id: 'nb_mkt', name: 'Dirección de Marketing [C. Del Hoyo]', color: '#c2410c', schedule: [], sections: [], createdAt: 1 });
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return store.ymd(x); };
    await todos.saveTodo({ id: 'a', title: 'Leer Growth Outside the Core', due: d(0), notebookId: 'nb_mkt', minutes: 30, done: false, createdAt: 1, order: 1 });
    await todos.saveTodo({ id: 'b', title: 'Ver TEDx Nancy Duarte', due: d(0), notebookId: null, done: false, createdAt: 2, order: 2 });
    await todos.saveTodo({ id: 'c', title: 'Guía U1', due: d(-1), notebookId: null, done: false, createdAt: 3 });
    await todos.saveTodo({ id: 'e', title: 'Subir TP de Marketing', due: d(2), notebookId: 'nb_mkt', done: false, createdAt: 4 });
    await todos.saveTodo({ id: 'f', title: 'Repaso integral', due: d(20), notebookId: null, done: false, createdAt: 5 });
  });
  await page.reload();
  const sec = page.locator('.todo-today');
  await sec.locator('.todo', { hasText: 'Leer Growth Outside the Core' }).waitFor();
  const txt = await sec.innerText();
  if (!/Atrasadas · 1/i.test(txt) || !txt.includes('Guía U1')) throw new Error('Falta lo atrasado');
  if (!txt.includes('Subir TP de Marketing') || txt.includes('Repaso integral')) throw new Error('Próximos días mal');
  if (!/0 de 2/.test(txt)) throw new Error(`Progreso: ${txt}`);
  if (!(await sec.innerText()).includes('Dirección de Marketing · 30 min')) throw new Error('Falta materia/minutos');
  step('Mi día muestra atrasadas, las de hoy (0 de 2) y los próximos días, con materia y tiempo');

  await sec.locator('.todo', { hasText: 'Leer Growth Outside the Core' }).locator('.todo-check').click();
  await page.waitForTimeout(700);
  const row = sec.locator('.todo', { hasText: 'Leer Growth Outside the Core' });
  if (!(await row.getAttribute('class')).includes('done')) throw new Error('No quedó tachada');
  if (!/1 de 2/.test(await sec.innerText())) throw new Error('El progreso no avanzó');
  const stored = await page.evaluate(async () => { const db = await import('/js/db.js'); const r = await db.get('kv', 'todo:a'); return { done: r.value.done, mod: r._mod, synced: db.isSyncedKey('todo:a') }; });
  if (!stored.done || !stored.mod || !stored.synced) throw new Error(`Guardado: ${JSON.stringify(stored)}`);
  step('Tocar el círculo la tacha, avanza el progreso (1 de 2) y queda guardada para sincronizar');

  await sec.locator('.todo', { hasText: 'Guía U1' }).locator('.todo-check').click();
  await page.waitForTimeout(700);
  if (/Atrasadas/i.test(await sec.innerText())) throw new Error('La atrasada tachada sigue en Atrasadas');
  if (!(await sec.locator('.todo.done', { hasText: 'Guía U1' }).count())) throw new Error('La atrasada hecha no aparece tachada en Hoy');
  step('Tachar una atrasada la saca de Atrasadas y la muestra hecha en Hoy');

  // Lo que se está escribiendo no se pierde al tachar otra tarea
  await sec.locator('.todo-new').fill('a medio escribir');
  await sec.locator('.todo', { hasText: 'Ver TEDx Nancy Duarte' }).locator('.todo-check').click();
  await page.waitForTimeout(700);
  if ((await sec.locator('.todo-new').inputValue()) !== 'a medio escribir') throw new Error('Se perdió lo escrito al tachar');
  await sec.locator('.todo', { hasText: 'Ver TEDx Nancy Duarte' }).locator('.todo-check').click(); // la vuelvo a dejar pendiente
  await page.waitForTimeout(700);
  step('Tachar no borra lo que estás escribiendo en "Agregar"');

  // Reloj atrasado: si la nube tiene una versión con marca "del futuro", tachar igual gana
  const skew = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const todos = await import('/js/todos.js');
    const row = await db.get('kv', 'todo:f');
    await db.put('kv', { ...row, _mod: Date.now() + 60000 }, { remote: true }); // vino de otro equipo con reloj adelantado
    await todos.setDone('f', true);
    const after = await db.get('kv', 'todo:f');
    await todos.setDone('f', false);
    return after._mod > Date.now() + 59000;
  });
  if (!skew) throw new Error('Con reloj atrasado el cambio no le gana a la versión remota');
  step('Con el reloj del dispositivo atrasado, tachar igual le gana a la versión de la nube');

  await sec.locator('.todo-new').fill('Armar grupo del TP');
  await sec.locator('.todo-nb').selectOption('nb_mkt');
  await sec.locator('.todo-new').press('Enter');
  await sec.locator('.todo', { hasText: 'Armar grupo del TP' }).waitFor();
  step('Se agregan tareas desde Mi día (con materia y fecha)');

  await page.waitForFunction(() => [...document.querySelectorAll('nav.nav a.nav-item')].find((a) => a.textContent.includes('Tareas'))?.querySelector('.count')?.textContent === '2', null, { timeout: 3000 }).catch(() => {});
  const count = await page.locator('nav.nav a.nav-item', { hasText: 'Tareas' }).locator('.count').innerText().catch(() => '');
  if (count !== '2') throw new Error(`Contador del menú: "${count}"`);
  step('El menú "Tareas" muestra cuántas quedan para hoy (2)');

  await page.goto(`${base}/#/tareas`);
  await page.locator('.page.tasks .todo', { hasText: 'Repaso integral' }).waitFor();
  const t = await page.locator('.page.tasks').innerText();
  if (t.includes('Leer Growth Outside the Core')) throw new Error('Muestra hechas sin pedirlo');
  await page.locator('.tasks-toggle input').check();
  await page.locator('.page.tasks .todo.done', { hasText: 'Leer Growth Outside the Core' }).waitFor();
  await page.locator('.tasks-tools .chip', { hasText: 'Dirección de Marketing' }).click();
  await page.waitForTimeout(300);
  if ((await page.locator('.page.tasks').innerText()).includes('Ver TEDx Nancy Duarte')) throw new Error('El filtro por materia no filtra');
  await page.locator('.page.tasks .todo-new').fill('Leer caso Dove');
  await page.locator('.page.tasks .todo-new').press('Enter');
  await page.locator('.page.tasks .todo', { hasText: 'Leer caso Dove' }).waitFor({ timeout: 3000 });
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('todo-new')))) throw new Error('Después de agregar, el cursor no vuelve al campo');
  step('Página Tareas: todo el plan por día, con "Mostrar hechas" y filtro por materia (lo agregado con filtro queda en esa materia)');

  await page.locator('.page.tasks .todo', { hasText: 'Subir TP de Marketing' }).locator('.todo-del').click();
  await page.locator('.modal button', { hasText: 'Borrar' }).click();
  await page.waitForTimeout(400);
  const gone = await page.evaluate(async () => { const db = await import('/js/db.js'); return { row: await db.get('kv', 'todo:e'), tomb: ((await db.getSetting('syncTombstones', [])) || []).some((x) => x.id === 'todo:e') }; });
  if (gone.row || !gone.tomb) throw new Error(`Borrar: ${JSON.stringify(gone)}`);
  step('Borrar una tarea la elimina en todos los dispositivos');

  await page.goto(`${base}/#/calendario`);
  await page.locator('.cal-chip.task', { hasText: 'Ver TEDx Nancy Duarte' }).waitFor();
  await page.locator('.cal-chip.task.done', { hasText: 'Leer Growth Outside the Core' }).waitFor();
  const heights = await page.evaluate(() => [...document.querySelectorAll('.cal-allday')].map((e) => Math.round(e.getBoundingClientRect().height)));
  if (new Set(heights).size !== 1) throw new Error(`Alturas de la fila de tareas: ${heights}`);
  step('En el calendario aparecen las tareas del día (tachadas si están hechas) y la grilla queda alineada');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${base}/#/hoy`);
  await page.locator('.todo-today .todo').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`Scroll horizontal en celular: ${overflow}px`);
  step('En el celular entra sin scroll horizontal');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
