// Doble toque para cambiar de herramienta (como el del Apple Pencil en Notas):
// dos toques rápidos con el dedo sobre la hoja alternan entre la lapicera y el
// resaltador; desde la goma o el lazo vuelven a la última de las dos.
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
  let box = await sheet.boundingBox();
  let x = box.x + 200;
  let y = box.y + 150;
  const active = () => page.locator('.tool-group .tbtn.active').first().getAttribute('title');
  const strokes = () => page.evaluate(async (id) => { const db = await import('/js/db.js'); const n = await db.get('notes', id); return n.blocks.flatMap((b) => b.strokes || []).length; }, noteId);
  const doubleTap = async () => { await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y); await page.waitForTimeout(150); };

  if ((await active()) !== 'Lapicera') throw new Error(`Arranca con ${await active()}`);
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Lapicera → doble toque debería ir al resaltador: ${await active()}`);
  await page.locator('.toast', { hasText: 'Resaltador' }).waitFor();
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Debería volver a la lapicera: ${await active()}`);
  step('El doble toque alterna entre la lapicera y el resaltador, y lo avisa');

  // Pasar antes por la goma o el lazo no cambia a dónde lleva el doble toque
  await page.getByTitle('Goma (borra trazos enteros)', { exact: true }).click();
  await page.getByTitle('Resaltador', { exact: true }).click();
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Goma → Resaltador → doble toque debería ir a la lapicera (no a la goma): ${await active()}`);
  await page.getByTitle('Lazo: seleccionar y mover', { exact: true }).click();
  await page.getByTitle('Resaltador', { exact: true }).click();
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Lazo → Resaltador → doble toque debería ir a la lapicera (no al lazo): ${await active()}`);
  step('Aunque antes se haya usado la goma o el lazo, del resaltador se vuelve a la lapicera');

  await page.getByTitle('Resaltador', { exact: true }).click();
  await page.getByTitle('Goma (borra trazos enteros)', { exact: true }).click();
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Desde la goma debería volver a lo último con que se escribió (resaltador): ${await active()}`);
  await page.getByTitle('Lapicera', { exact: true }).click();
  await page.getByTitle('Lazo: seleccionar y mover', { exact: true }).click();
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Desde el lazo debería volver a la lapicera: ${await active()}`);
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Y de ahí al resaltador: ${await active()}`);
  step('Desde la goma o el lazo, el doble toque vuelve a la última de las dos (lapicera o resaltador)');

  const saved = await page.evaluate(async () => (await import('/js/db.js')).getSetting('tools'));
  if (saved.tool !== 'highlighter' || saved.lastWrite !== 'highlighter') throw new Error(`Guardado: ${JSON.stringify(saved)}`);
  await page.reload();
  await page.locator('.sheet').first().waitFor();
  await page.waitForTimeout(300);
  await page.locator('.sheet').first().scrollIntoViewIfNeeded();
  box = await page.locator('.sheet').first().boundingBox();
  x = box.x + 200;
  y = box.y + 150;
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Después de recargar: ${await active()}`);
  step('Al cerrar y volver a abrir la nota sigue en el resaltador, y el doble toque lo pasa a la lapicera');

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

  // A quien ya venía usando el lápiz (sin haber visto el aviso), se le cuenta una sola vez qué hace el doble toque
  const penTap = () => page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown');
    ev('pointerup');
  }, [x, y]);
  const hint = page.locator('.toast', { hasText: 'Dos toques rápidos con el dedo' });
  if (await hint.count()) throw new Error('El aviso del doble toque no debería salir antes de usar el lápiz');
  // Apoyar el lápiz fuera de la hoja (el título) no gasta el aviso
  await page.evaluate(() => document.querySelector('input.note-title').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true })));
  await page.waitForTimeout(150);
  if ((await hint.count()) || (await page.evaluate(async () => (await import('/js/db.js')).getSetting('tools'))).swapHint) throw new Error('El aviso no debería gastarse al tocar el título con el lápiz');
  await penTap();
  await hint.waitFor();
  await penTap();
  await page.waitForTimeout(200);
  const hinted = await page.evaluate(async () => (await import('/js/db.js')).getSetting('tools'));
  if ((await hint.count()) !== 1 || hinted.swapHint !== true) throw new Error(`El aviso debería salir una sola vez y quedar guardado: ${await hint.count()} / ${JSON.stringify(hinted)}`);
  step('La primera vez que se apoya el lápiz, avisa (una sola vez) que dos toques con el dedo cambian lapicera ↔ resaltador');

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

  // Al abrir la nota, "lo último con que se escribió" es la herramienta con la que abre
  const reopen = async (saved) => {
    await page.evaluate(async (t) => (await import('/js/db.js')).setSetting('tools', { color: '#1c1c1e', size: 4, highlighterColor: '#ffd60a', highlighterSize: 22, eraserSize: 18, penOnly: true, swapHint: true, ...t }), saved);
    await page.reload();
    await page.locator('.sheet').first().waitFor();
    await page.waitForTimeout(300);
    await page.locator('.sheet').first().scrollIntoViewIfNeeded();
    box = await page.locator('.sheet').first().boundingBox();
    x = box.x + 200;
    y = box.y + 150;
  };
  await reopen({ tool: 'none', lastWrite: 'highlighter' }); // se dejó en "Texto" después de resaltar: abre con la lapicera
  if ((await active()) !== 'Lapicera') throw new Error(`Debería abrir con la lapicera: ${await active()}`);
  await page.getByTitle('Goma (borra trazos enteros)', { exact: true }).click();
  await doubleTap();
  if ((await active()) !== 'Lapicera') throw new Error(`Abrió con la lapicera: desde la goma debería volver a ella, no al resaltador: ${await active()}`);
  await reopen({ tool: 'highlighter', prevTool: 'pen' }); // ajustes guardados por la versión anterior
  await page.getByTitle('Goma (borra trazos enteros)', { exact: true }).click();
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Con ajustes viejos en resaltador, desde la goma debería volver al resaltador: ${await active()}`);
  await reopen({ tool: 'eraser', prevTool: 'highlighter' });
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Con ajustes viejos (goma, antes resaltador) debería volver al resaltador: ${await active()}`);
  await reopen({ tool: 'eraser', lastWrite: 'highlighter', prevTool: 'pen' }); // ya migrados: el "prevTool" viejo sigue guardado, pero manda "lastWrite"
  await doubleTap();
  if ((await active()) !== 'Resaltador') throw new Error(`Con lastWrite guardado, el prevTool viejo no debería pisarlo: ${await active()}`);
  step('Al reabrir (también con ajustes de la versión anterior), desde la goma vuelve a lo último con que se escribió');

  // Primer contacto con el lápiz en un iPad nuevo: activa "sólo lápiz" y cuenta el gesto en ese mismo aviso (sin repetirlo después)
  await reopen({ tool: 'pen', penOnly: false, swapHint: false });
  await penTap();
  await page.locator('.toast', { hasText: 'Lápiz detectado' }).filter({ hasText: 'lapicera ↔ resaltador' }).waitFor();
  await penTap();
  await page.waitForTimeout(200);
  const first = await page.evaluate(async () => (await import('/js/db.js')).getSetting('tools'));
  if (!first.penOnly || !first.swapHint || (await hint.count())) throw new Error(`Primer contacto: ${JSON.stringify(first)} / avisos repetidos: ${await hint.count()}`);
  step('En un iPad nuevo, el primer contacto del lápiz activa "sólo lápiz" y avisa el gesto una sola vez');

  if (errors.length) throw new Error(`Errores en la página: ${errors.join(' | ')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
