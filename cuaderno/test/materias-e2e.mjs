// Materias: "Cursando" muestra sólo las que tienen clases ahora según el calendario del campus;
// las demás van plegadas en "Materias futuras" y "Materias pasadas". Lo marcado a mano manda.
//   node test/materias-e2e.mjs
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
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00-03:00'));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const at = (s) => Date.parse(`${s}-03:00`);
    const nb = (id, name, courseId, extra = {}) => db.put('notebooks', { id, name, courseId, color: '#888', schedule: [], sections: [], createdAt: courseId, campusStatus: 'cursando', status: 'cursando', ...extra });
    await nb('nb_reg', 'Regional', 7410, { startdate: at('2026-02-20T00:00:00') });
    await nb('nb_fin', 'Finanzas Corporativas [M. Machinea]', 7706, { startdate: at('2026-06-16T00:00:00') });
    await nb('nb_mkt', 'Dirección de Marketing [C. Del Hoyo]', 7703, { startdate: at('2026-06-16T00:00:00') });
    await nb('nb_con', 'Contabilidad Gerencial [O. Garrigue]', 7421, { startdate: at('2026-02-20T00:00:00') });
    await nb('nb_lab', 'Programa de Leadership Lab', 7416, { startdate: at('2026-02-20T00:00:00') });
    await nb('nb_int', 'Curso Introductorio al Análisis Cuantitativo [S. Auguste]', 7426, { startdate: at('2026-02-20T00:00:00') });
    await nb('nb_fut', 'Negociación [L. Futuro]', 7800, { startdate: at('2026-12-01T00:00:00') });
    const ev = (id, start, title, courseId = 7410) => ({ id, start: at(start), end: at(start) + 3 * 3600000, title, kind: 'evento', courseId, source: 'campus' });
    await db.setSetting('campusEvents', [
      ev('1', '2026-10-08T15:00:00', 'Finanzas Corporativas - Prof. Machinea'),
      ev('2', '2026-11-13T09:00:00', 'Finanzas Corporativas - Prof. Machinea'),
      ev('3', '2026-12-04T19:00:00', 'Examen Finanzas Corporativas'),
      ev('4', '2026-10-08T18:30:00', 'Dirección de Marketing - Prof. Del Hoyo'),
      ev('5', '2026-11-14T14:10:00', 'Dirección de Marketing - Prof. Del Hoyo'),
      ev('6', '2026-03-10T19:00:00', 'Contabilidad Gerencial - Prof. Garrigue'),
      ev('7', '2026-07-18T08:30:00', 'Contabilidad Gerencial - Prof. Garrigue'),
      ev('8', '2026-11-20T19:00:00', 'Se abre 3° llamado | Contabilidad Gerencial'),
      ev('9', '2026-10-29T12:00:00', 'Leadership Lab - Coaching Grupal 3 + El otro en el centro'),
      ev('10', '2026-10-09T19:00:00', 'Noches de Juegos'),
      ev('11', '2026-12-07T19:00:00', 'Negociación - Prof. Futuro'),
    ]);
  });
  await page.reload();
  const side = page.locator('#sidebar .nb-groups');
  await side.locator('.nb-group-title', { hasText: 'Materias pasadas' }).waitFor({ timeout: 5000 });
  const cursando = await side.locator('.nb-group').first().locator('a.nb').allInnerTexts();
  const names = cursando.map((t) => t.split('\n')[0]);
  for (const n of ['Finanzas Corporativas', 'Dirección de Marketing', 'Programa de Leadership Lab', 'Regional']) if (!names.some((x) => x.startsWith(n))) throw new Error(`Falta en Cursando: ${n} (${names})`);
  for (const n of ['Contabilidad', 'Curso Introductorio', 'Negociación']) if (names.some((x) => x.startsWith(n))) throw new Error(`No debería estar en Cursando: ${n}`);
  step('Cursando muestra sólo las materias con clases ahora (y el Leadership Lab, que tiene encuentro mañana)');

  const futuras = side.locator('.nb-group-title', { hasText: 'Materias futuras' });
  const pasadas = side.locator('.nb-group-title', { hasText: 'Materias pasadas' });
  if ((await futuras.getAttribute('aria-expanded')) !== 'false' || (await pasadas.getAttribute('aria-expanded')) !== 'false') throw new Error('Futuras y pasadas deberían empezar plegadas');
  if (!(await futuras.innerText()).includes('1') || !(await pasadas.innerText()).includes('2')) throw new Error(`Cuentas: ${await futuras.innerText()} / ${await pasadas.innerText()}`);
  if (await side.locator('a.nb', { hasText: 'Contabilidad' }).count()) throw new Error('Las pasadas no se ven hasta abrir el grupo');
  await pasadas.click();
  await side.locator('a.nb.past', { hasText: 'Contabilidad Gerencial' }).waitFor();
  await side.locator('a.nb.past', { hasText: 'Curso Introductorio' }).waitFor();
  await futuras.click();
  await side.locator('a.nb', { hasText: 'Negociación' }).waitFor();
  step('Las demás quedan plegadas en "Materias futuras" (1) y "Materias pasadas" (2) y se abren con un toque');

  const stored = await page.evaluate(async () => Object.fromEntries((await (await import('/js/db.js')).all('notebooks')).map((n) => [n.id, `${n.status}/${n.calendarStatus}`])));
  if (stored.nb_con !== 'pasada/pasada' || stored.nb_fin !== 'cursando/cursando' || stored.nb_fut !== 'proxima/proxima' || stored.nb_int !== 'pasada/pasada') throw new Error(`Guardado: ${JSON.stringify(stored)}`);
  step('El estado queda guardado (y se sincroniza): calendario para todas, sin tocar lo marcado a mano');

  // A mano: mover Contabilidad a Cursando; el calendario no la vuelve a pasar
  await page.goto(`${base}/#/cuaderno/nb_con`);
  await page.getByRole('button', { name: 'Opciones' }).click();
  await page.locator('.popover button, .popover [role="menuitem"]', { hasText: 'Mover a Cursando' }).first().click();
  await page.waitForTimeout(400);
  await page.evaluate(async () => (await import('/js/store.js')).refreshStatuses());
  await page.reload();
  await side.locator('.nb-group').first().locator('a.nb', { hasText: 'Contabilidad Gerencial' }).waitFor();
  const manual = await page.evaluate(async () => { const n = await (await import('/js/db.js')).get('notebooks', 'nb_con'); return `${n.status}/${n.statusManual}/${n.calendarStatus}`; });
  if (manual !== 'cursando/cursando/pasada') throw new Error(`A mano: ${manual}`);
  step('Mover una materia a mano manda sobre el calendario');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
