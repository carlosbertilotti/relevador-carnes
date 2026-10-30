// Escribir con el teclado o con el lápiz sin cambiar de hoja (como Notas de Apple):
// en la compu la nota abre lista para tipear; en el iPad el lápiz apoyado en la hoja
// pasa a dibujar, y el dedo (con el lápiz elegido) sólo desplaza.
//   node test/input-modes-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);

async function setup(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(500);
  const id = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    // La última vez se usó el lápiz (así queda guardado en el iPad y, a veces, en la compu).
    await db.setSetting('tools', { tool: 'pen', color: '#1c1c1e', size: 4, highlighterColor: '#ffd60a', highlighterSize: 22, eraserSize: 18, penOnly: true });
    const nb = await store.defaultPersonalFolder();
    return (await store.createNote(nb.id)).id; // una sola hoja: texto y lápiz
  });
  await page.goto(`${base}/#/nota/${id}`);
  await page.locator('.sheet').first().waitFor();
  return { page, id };
}
const mode = (page) => page.locator('.segmented button.active').innerText();
const tool = (page) => page.evaluate(async () => (await import('/js/editor/ink.js')).tools.tool);
const note = (page, id) => page.evaluate(async (nid) => (await import('/js/db.js')).get('notes', nid), id);
// Con el lápiz, el texto de la hoja no es editable: así el Scribble del iPad no se queda con lo que se dibuja.
const editable = (page) => page.evaluate(() => document.querySelector('.page-text').isContentEditable);
const penStroke = (page, from, to) => page.evaluate(([f, t]) => {
  const sheet = document.querySelector('.sheet');
  const r = sheet.getBoundingClientRect();
  const ev = (type, x, y) => sheet.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1 }));
  ev('pointerdown', f[0], f[1]);
  for (let i = 1; i <= 10; i++) ev('pointermove', f[0] + ((t[0] - f[0]) * i) / 10, f[1] + ((t[1] - f[1]) * i) / 10);
  ev('pointerup', t[0], t[1]);
}, [from, to]);

try {
  // ---- Compu: sin pantalla táctil ----
  const desk = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const { page: pc, id: pcId } = await setup(desk);
  if ((await pc.locator('.block').count()) !== 1) throw new Error('Una nota nueva debería tener una sola hoja');
  if ((await mode(pc)).trim() !== 'Texto') throw new Error(`En la compu debería abrir en "Texto": ${await mode(pc)}`);
  if (!(await pc.evaluate(() => document.activeElement?.classList.contains('page-text')))) throw new Error('El cursor no quedó en el texto de la hoja');
  await pc.keyboard.type('Comprar entradas para el sábado');
  await pc.waitForTimeout(800);
  let n = await note(pc, pcId);
  if (!n.blocks[0].html.includes('Comprar entradas')) throw new Error('No se guardó lo tipeado en la hoja');
  const box = await pc.locator('.sheet').first().boundingBox();
  await pc.mouse.move(box.x + 300, box.y + 400);
  await pc.mouse.down();
  await pc.mouse.move(box.x + 500, box.y + 440, { steps: 8 });
  await pc.mouse.up();
  await pc.waitForTimeout(700);
  if ((await note(pc, pcId)).blocks[0].strokes.length) throw new Error('En modo texto el mouse no debería dibujar');
  step('En la compu la nota abre en "Texto" con el cursor en la hoja: se escribe con el teclado y el mouse no la raya');
  await pc.locator('.segmented button', { hasText: 'Lápiz' }).click();
  await pc.mouse.move(box.x + 300, box.y + 400);
  await pc.mouse.down();
  await pc.mouse.move(box.x + 500, box.y + 440, { steps: 8 });
  await pc.mouse.up();
  await pc.waitForTimeout(700);
  n = await note(pc, pcId);
  if (n.blocks.length !== 1 || n.blocks[0].strokes.length !== 1 || !n.blocks[0].html.includes('Comprar entradas')) throw new Error('Texto y dibujo deberían quedar en la misma hoja');
  if (await editable(pc)) throw new Error('Con "Lápiz" el texto de la hoja no debería quedar editable');
  step('Eligiendo "Lápiz", en la compu también se dibuja: texto y trazo quedan en la misma hoja');
  await desk.close();

  // ---- iPad: pantalla táctil + lápiz ----
  const ipad = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, serviceWorkers: 'block' });
  const { page, id } = await setup(ipad);
  if ((await mode(page)).trim() !== 'Lápiz') throw new Error(`En el iPad debería abrir con el lápiz: ${await mode(page)}`);
  if (await editable(page)) throw new Error('Con el lápiz, el texto de la hoja no debería ser editable (el Scribble pasaría los dibujos a texto)');
  const sb = await page.locator('.sheet').first().boundingBox();
  await page.touchscreen.tap(sb.x + 200, sb.y + 150);
  await page.waitForTimeout(250);
  if ((await mode(page)).trim() !== 'Lápiz' || (await page.evaluate(() => document.activeElement?.classList.contains('page-text')))) throw new Error('Con el lápiz elegido, el dedo no debería abrir el teclado');
  step('En el iPad, con el lápiz elegido el dedo no abre el teclado (desplaza y hace el doble toque)');
  step('Con el lápiz elegido el texto de la hoja no es editable: el Scribble no convierte lo dibujado (una flecha) en texto');

  await page.locator('.segmented button', { hasText: 'Texto' }).click();
  if (!(await editable(page))) throw new Error('En "Texto" el texto de la hoja debería ser editable');
  await page.touchscreen.tap(sb.x + 200, sb.y + 150);
  await page.waitForTimeout(200);
  await page.keyboard.type('Idea: app para el súper');
  await page.waitForTimeout(800);
  if (!(await note(page, id)).blocks[0].html.includes('Idea: app')) throw new Error('No se guardó lo tipeado en el iPad');
  step('Eligiendo "Texto", tocar la hoja pone el cursor y se escribe con el teclado');

  // El lápiz apoyado en la hoja vuelve solo a dibujar y el trazo arranca en ese mismo toque.
  await penStroke(page, [80, 300], [280, 340]);
  await page.waitForTimeout(800);
  if ((await mode(page)).trim() !== 'Lápiz' || (await tool(page)) !== 'pen') throw new Error(`El lápiz debería volver a la lapicera: ${await tool(page)}`);
  n = await note(page, id);
  if (n.blocks[0].strokes.length !== 1 || !n.blocks[0].html.includes('Idea: app')) throw new Error('El trazo y el texto deberían estar en la misma hoja');
  if (await page.evaluate(() => document.activeElement?.classList.contains('page-text'))) throw new Error('El teclado debería cerrarse al dibujar');
  if (await editable(page)) throw new Error('Al volver al lápiz, el texto de la hoja debería dejar de ser editable');
  step('Con el lápiz en la hoja vuelve solo a "Lápiz" y el primer trazo ya se dibuja, sin perder el texto');

  // Si se dejó en "Texto", la próxima vez el iPad (que ya usó el lápiz) igual abre para dibujar.
  await page.locator('.segmented button', { hasText: 'Texto' }).click();
  await page.waitForTimeout(300);
  await page.reload();
  await page.locator('.sheet').first().waitFor();
  if ((await mode(page)).trim() !== 'Lápiz' || (await editable(page))) throw new Error(`Al volver a abrir debería estar en "Lápiz": ${await mode(page)}`);
  step('Aunque haya quedado en "Texto", en el iPad la nota vuelve a abrir con el lápiz');

  if (errors.length) throw new Error(`Errores en la página: ${errors.join(' | ')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
