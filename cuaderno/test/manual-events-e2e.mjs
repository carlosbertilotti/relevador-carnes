// Fechas cargadas a mano (calendario sin link): aparecen en Mi día y en el calendario
// con su tipo (entrega/clase) y su materia, y "Actualizar" no las borra ni da error.
//   node test/manual-events-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    await db.put('notebooks', { id: 'nb_fin', name: 'Finanzas Corporativas [M. Machinea]', schedule: [], sections: [], createdAt: 1 });
    const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(23, 59, 0, 0);
    await db.setSetting('icsCalendars', [{ id: 'cuaderno-plan', name: 'Fechas de las materias', color: '#c2410c', events: [
      { uid: 'e1', title: 'Entregar Mini Quiz', description: 'Finanzas', start: d.getTime(), end: d.getTime(), kind: 'entrega', notebookId: 'nb_fin' },
    ], syncedAt: Date.now() }]);
  });
  await page.reload();
  const row = page.locator('.card', { hasText: 'Próximas entregas' }).locator('.event-row', { hasText: 'Entregar Mini Quiz' });
  await row.waitFor({ timeout: 5000 });
  if (!(await row.innerText()).includes('Finanzas Corporativas')) throw new Error('La entrega no quedó asociada a la materia');
  step('Una fecha cargada a mano aparece en Mi día como entrega de su materia');

  const ev = await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const items = await store.agenda(new Date(), new Date(Date.now() + 5 * 86400000));
    return items.find((e) => e.title === 'Entregar Mini Quiz');
  });
  if (ev?.kind !== 'entrega' || ev?.notebookId !== 'nb_fin') throw new Error(`Agenda: ${JSON.stringify(ev)}`);
  const after = await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const db = await import('/js/db.js');
    const errs = await store.refreshIcs({ post: async () => { throw new Error('no debería llamarse'); } });
    const cals = await db.getSetting('icsCalendars', []);
    return { errs, n: cals[0].events.length, error: cals[0].error || null };
  });
  if (after.errs.length || after.n !== 1 || after.error) throw new Error(`Actualizar calendarios: ${JSON.stringify(after)}`);
  step('"Actualizar" saltea el calendario sin link: no da error ni borra las fechas');

  await page.goto(`${base}/#/campus`);
  await page.locator('.cal-subs li', { hasText: 'fechas cargadas en Cuaderno' }).waitFor();
  step('En Campus y calendarios figura como "fechas cargadas en Cuaderno"');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
