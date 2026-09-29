// Prueba de punta a punta en un navegador real (requiere Playwright):
//   node test/e2e.mjs [carpeta-de-capturas]
// Levanta el Moodle falso y el servidor de Cuaderno, conecta el campus,
// sincroniza, anota un PDF con el lápiz y recorre las pantallas principales.
import { createServer } from '../server/server.js';
import { createMockMoodle } from './mock-moodle.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const shots = process.argv[2] || null;
const mock = createMockMoodle();
const moodleUrl = await mock.listen();
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const step = (msg) => console.log(`✓ ${msg}`);
const idb = (store) => page.evaluate((s) => import('/js/db.js').then((db) => db.all(s)), store);

try {
  await page.goto(`${base}/?demo#/hoy`);
  await page.getByText('Datos de ejemplo cargados').waitFor();
  await page.getByRole('heading', { name: 'Clases' }).waitFor();
  await shot('1-mi-dia');
  step('Mi día con datos de ejemplo');

  // Conectar el campus falso.
  await page.goto(`${base}/#/campus`);
  await page.locator('.login input').first().fill(moodleUrl);
  await page.getByPlaceholder('Usuario del campus').fill('alumno');
  await page.getByPlaceholder('Contraseña').fill('clave');
  await page.getByRole('button', { name: 'Conectar' }).click();
  await page.getByText('Conectado como').waitFor({ timeout: 15000 });
  await shot('2-campus');
  const nbs = await idb('notebooks');
  const eco = nbs.find((n) => n.courseId === 11);
  if (!eco || eco.name !== 'Microeconomía I') throw new Error(`Materia mal nombrada: ${eco?.name}`);
  let files = await idb('files');
  for (let i = 0; i < 20 && files.filter((f) => f.downloaded).length < 4; i++) { await page.waitForTimeout(250); files = await idb('files'); }
  if (files.filter((f) => f.downloaded).length !== 4) throw new Error(`Se esperaban 4 archivos bajados: ${JSON.stringify(files)}`);
  const past = nbs.find((n) => n.courseId === 13);
  if (past?.status !== 'pasada' || past.name !== 'Historia Económica') throw new Error(`Materia pasada mal clasificada: ${JSON.stringify(past)}`);
  if (files.some((f) => f.courseId === 13 && f.downloaded)) throw new Error('No debería bajar solo el material de materias pasadas');
  await page.locator('.nb-group-title', { hasText: 'Materias pasadas' }).waitFor();
  step('Materias pasadas separadas y sin descarga automática');
  step(`Campus sincronizado: ${nbs.length} materias, ${files.length} archivos descargados`);

  // Material → anotar PDF en nota nueva.
  await page.goto(`${base}/#/cuaderno/${eco.id}/material`);
  await page.getByText('clase1-11.pdf').waitFor();
  await shot('3-material');
  await page.locator('.file-row', { hasText: 'clase1-11.pdf' }).getByRole('button', { name: 'Abrir', exact: true }).click();
  await page.locator('.ink-block').first().waitFor();
  await page.waitForTimeout(800);
  step('PDF abierto como hoja para anotar');

  // Escribir con el "lápiz" (mouse) sobre la hoja.
  const sheet = page.locator('.sheet').first();
  const box = await sheet.boundingBox();
  await page.mouse.move(box.x + 80, box.y + 200);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + 80 + i * 12, box.y + 200 + Math.sin(i / 2) * 20);
  await page.mouse.up();
  // Resaltador
  await page.getByTitle('Resaltador').click();
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  await shot('4-anotando-pdf');
  let notes = await idb('notes');
  const pdfNote = notes.find((n) => n.blocks.some((b) => b.pdf));
  const strokes = pdfNote.blocks.flatMap((b) => b.strokes || []);
  if (strokes.length !== 2) throw new Error(`Se esperaban 2 trazos guardados, hay ${strokes.length}`);
  step('Trazos de lapicera y resaltador guardados');

  // Deshacer / rehacer.
  await page.getByTitle('Deshacer').click();
  await page.waitForTimeout(700);
  notes = await idb('notes');
  if (notes.find((n) => n.id === pdfNote.id).blocks.flatMap((b) => b.strokes || []).length !== 1) throw new Error('Deshacer no funcionó');
  await page.getByTitle('Rehacer').click();
  step('Deshacer / rehacer');

  // Goma
  await page.getByTitle(/Goma/).click();
  await page.mouse.move(box.x + 80 + 60, box.y + 190);
  await page.mouse.down();
  await page.mouse.move(box.x + 80 + 140, box.y + 215, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  notes = await idb('notes');
  const left = notes.find((n) => n.id === pdfNote.id).blocks.flatMap((b) => b.strokes || []);
  if (left.length !== 1 || left[0].tool !== 'highlighter') throw new Error('La goma no borró el trazo');
  step('Goma de trazos');

  // Lazo: seleccionar el resaltador y borrarlo.
  await page.getByTitle(/Lazo/).click();
  await page.mouse.move(box.x + 40, box.y + 95);
  await page.mouse.down();
  for (const [x, y] of [[440, 95], [440, 150], [40, 150], [40, 97]]) await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  await page.mouse.up();
  await page.locator('.selection-bar').getByRole('button', { name: 'Borrar' }).click();
  await page.waitForTimeout(700);
  notes = await idb('notes');
  if (notes.find((n) => n.id === pdfNote.id).blocks.flatMap((b) => b.strokes || []).length !== 0) throw new Error('El lazo no seleccionó/borró el trazo');
  step('Lazo: seleccionar y borrar');

  // Texto con formato (modo texto).
  await page.goto(`${base}/#/hoy`);
  await page.getByRole('button', { name: /Nota de Microeconomía I|Tomar notas|Abrir notas/ }).first().click();
  await page.locator('.text-block').first().waitFor();
  await page.locator('.segmented button', { hasText: 'Texto' }).click();
  await page.locator('.text-block').first().click();
  await page.keyboard.type('Costos marginales');
  await page.locator('.style-btn').click();
  await page.getByRole('menuitem', { name: 'Título' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('El costo marginal es la derivada del costo total.');
  await page.waitForTimeout(800);
  await shot('5-texto');
  notes = await idb('notes');
  if (!notes.some((n) => n.blocks.some((b) => b.type === 'text' && /<h1>Costos marginales<\/h1>/.test(b.html)))) throw new Error('No se guardó el título con formato');
  step('Texto con formato estilo Notas de Apple');

  // Búsqueda.
  await page.locator('.search').fill('derivada');
  await page.locator('.result-list li').first().waitFor();
  step('Búsqueda en notas');

  // Calendario.
  await page.goto(`${base}/#/calendario`);
  await page.locator('.cal-event').first().waitFor();
  await shot('6-calendario');
  step(`Calendario con ${await page.locator('.cal-event').count()} eventos esta semana`);

  // Tema oscuro con tinta invertida.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${base}/#/nota/${pdfNote.id}`);
  await page.locator('.ink-block').first().waitFor();
  await page.waitForTimeout(600);
  await shot('7-oscuro');
  step('Modo oscuro');

  // Vista angosta (iPad en vertical / teléfono).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.getElementById('main').scrollWidth > document.getElementById('main').clientWidth);
  if (overflow) throw new Error('Hay scroll horizontal en pantalla angosta');
  await shot('8-angosto');
  step('Pantalla angosta sin scroll horizontal');

  const real = errors.filter((e) => !/favicon|sw\.js/.test(e));
  if (real.length) throw new Error(`Errores en consola:\n${real.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  await shot('error');
  console.error('✗', err.message);
  if (errors.length) console.error('Consola:', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
  mock.server.close();
}
