// Doble toque para cambiar de herramienta (como el del Apple Pencil en Notas):
// dos toques rápidos con el dedo sobre la hoja alternan entre la herramienta
// actual y la anterior; sin anterior, con la goma.
//   node test/doubletap-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(600);
  const noteId = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    await db.setSetting('tools', { tool: 'pen', color: '#1c1c1e', size: 4, highlighterColor: '#ffd60a', highlighterSize: 22, eraserSize: 18, penOnly: true });
    const nb = await store.createNotebook({ name: 'Finanzas Corporativas' });
    const n = await store.createNote(nb.id, { title: 'Clase 2' });
    return n.id;
  });
  await page.goto(`${base}/#/nota/${noteId}`);
  await page.getByRole('button', { name: 'Hoja' }).click();
  const sheet = page.locator('.sheet').first();
  await sheet.waitFor();
  await sheet.scrollIntoViewIfNeeded();
  const box = await sheet.boundingBox();
  const x = box.x + 200;
  const y = box.y + 150;
  const active = () => page.locator('.tool-group .tbtn.active').first().getAttribute('title');
  const strokes = () => page.evaluate(async (id) => { const db = await import('/js/db.js'); const n = await db.get('notes', id); return n.blocks.flatMap((b) => b.strokes || []).length; }, noteId);
  const doubleTap = async () => { await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y); await page.waitForTimeout(150); };

  if ((await active()) !== 'Lapicera') throw new Error(`Arranca con ${await active()}`);
  await doubleTap();
  if ((await active()) !== 'Goma (borra trazos enteros)') throw new Error(`Sin herramienta anterior debería ir a la goma: ${await active()}`);
  await page.locator('.toast', { hasText: 'Goma' }).waitFor();
  step('Sin herramienta anterior, el doble toque pasa a la goma (como en Notas) y lo avisa');

  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Debería volver a la lapicera: ${await active()}`);
  await page.getByTitle('Resaltador').click();
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Resaltador → doble toque debería ir a la lapicera: ${await active()}`);
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Y volver al resaltador: ${await active()}`);
  step('Alterna entre la herramienta actual y la última usada (lapicera ↔ resaltador)');

  const saved = await page.evaluate(async () => (await import('/js/db.js')).getSetting('tools'));
  if (saved.tool !== 'highlighter' || saved.prevTool !== 'pen') throw new Error(`Guardado: ${JSON.stringify(saved)}`);
  await page.reload();
  await page.locator('.sheet').first().waitFor();
  await page.waitForTimeout(300);
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Después de recargar: ${await active()}`);
  step('La herramienta anterior se recuerda al cerrar y volver a abrir la nota');

  if (await strokes()) throw new Error('Los toques con el dedo no deberían escribir');
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(600);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(150);
  if ((await active()) !== 'Lapicera') throw new Error('Dos toques lentos no deberían cambiar');
  await page.waitForTimeout(600);
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x + 120, y + 90);
  await page.waitForTimeout(150);
  if ((await active()) !== 'Lapicera') throw new Error('Dos toques lejos no deberían cambiar');
  await page.waitForTimeout(600);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }, { x: x + 150, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(150);
  if ((await active()) !== 'Lapicera') throw new Error('Un toque con dos dedos no cuenta como doble toque');
  step('Toques lentos, separados o con dos dedos no cambian la herramienta, y el dedo no escribe');

  await page.locator('.segmented button', { hasText: 'Texto' }).click();
  await page.waitForTimeout(100);
  await doubleTap();
  const tool = await page.evaluate(async () => (await import('/js/editor/ink.js')).tools.tool);
  if (tool !== 'none') throw new Error(`En modo texto no debería cambiar: ${tool}`);
  await page.locator('.segmented button', { hasText: 'Lápiz' }).click();
  await page.locator('.tbtn.pen-only').click(); // el dedo también escribe
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error('Si el dedo escribe, el doble toque no cambia de herramienta');
  step('En modo texto o cuando el dedo escribe, el doble toque no cambia la herramienta');

  if (errors.length) throw new Error(`Errores en la página: ${errors.join(' | ')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
