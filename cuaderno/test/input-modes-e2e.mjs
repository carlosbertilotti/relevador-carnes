// Escribir con el teclado o con el lápiz sin tocar "Texto"/"Lápiz" (como Notas de Apple):
// en la compu la nota se abre lista para tipear; en el iPad, tocar el texto pasa a
// "Texto" y apoyar el lápiz en una hoja pasa a dibujar.
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
    return (await store.createNote(nb.id)).id; // texto arriba + hoja
  });
  await page.goto(`${base}/#/nota/${id}`);
  await page.locator('.sheet').first().waitFor();
  return { page, id };
}
const mode = (page) => page.locator('.segmented button.active').innerText();
const tool = (page) => page.evaluate(async () => (await import('/js/editor/ink.js')).tools.tool);
const note = (page, id) => page.evaluate(async (nid) => (await import('/js/db.js')).get('notes', nid), id);

try {
  // ---- Compu: sin pantalla táctil ----
  const desk = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const { page: pc, id: pcId } = await setup(desk);
  if ((await mode(pc)).trim() !== 'Texto') throw new Error(`En la compu debería abrir en "Texto": ${await mode(pc)}`);
  if (!(await pc.evaluate(() => document.activeElement?.classList.contains('text-block')))) throw new Error('El cursor no quedó en el texto');
  await pc.keyboard.type('Comprar entradas para el sábado');
  await pc.waitForTimeout(800);
  if (!(await note(pc, pcId)).blocks[0].html.includes('Comprar entradas')) throw new Error('No se guardó lo tipeado');
  const box = await pc.locator('.sheet').first().boundingBox();
  await pc.mouse.move(box.x + 100, box.y + 100);
  await pc.mouse.down();
  await pc.mouse.move(box.x + 300, box.y + 140, { steps: 8 });
  await pc.mouse.up();
  await pc.waitForTimeout(700);
  if ((await note(pc, pcId)).blocks[1].strokes.length) throw new Error('En modo texto el mouse no debería dibujar');
  step('En la compu la nota abre en "Texto" con el cursor listo: se escribe con el teclado y el mouse no raya la hoja');
  const paper = await pc.evaluate(() => {
    const blk = document.querySelector('.block.text');
    const tb = blk.querySelector('.text-block');
    const cs = getComputedStyle(tb);
    return { cls: blk.className, bg: cs.backgroundColor, img: cs.backgroundImage, lh: parseFloat(cs.lineHeight) };
  });
  if (!paper.cls.includes('paper-lined') || paper.bg !== 'rgb(255, 253, 248)' || !paper.img.includes('gradient') || paper.lh < 26) throw new Error(`El texto no va sobre la hoja rayada: ${JSON.stringify(paper)}`);
  await pc.locator('.block.ink .block-menu').first().click();
  await pc.locator('.popover .menu-item', { hasText: 'Cuadriculada' }).click();
  if (!(await pc.locator('.block.text').getAttribute('class')).includes('paper-grid')) throw new Error('El texto no sigue el papel de la hoja');
  await pc.locator('.block.ink .block-menu').first().click();
  await pc.locator('.popover .menu-item', { hasText: 'Rayada' }).click();
  step('Lo tipeado va sobre papel rayado como la hoja (y sigue el papel si se cambia)');
  await pc.locator('.segmented button', { hasText: 'Lápiz' }).click();
  await pc.mouse.move(box.x + 100, box.y + 100);
  await pc.mouse.down();
  await pc.mouse.move(box.x + 300, box.y + 140, { steps: 8 });
  await pc.mouse.up();
  await pc.waitForTimeout(700);
  if ((await note(pc, pcId)).blocks[1].strokes.length !== 1) throw new Error('Con "Lápiz" elegido, el mouse debería dibujar');
  step('Eligiendo "Lápiz", en la compu también se puede dibujar');
  await desk.close();

  // ---- iPad: pantalla táctil + lápiz ----
  const ipad = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, serviceWorkers: 'block' });
  const { page, id } = await setup(ipad);
  if ((await mode(page)).trim() !== 'Lápiz') throw new Error(`En el iPad debería abrir con el lápiz: ${await mode(page)}`);
  const tb = await page.locator('.text-block').first().boundingBox();
  await page.touchscreen.tap(tb.x + 40, tb.y + 10);
  await page.waitForTimeout(200);
  if ((await mode(page)).trim() !== 'Texto') throw new Error('Tocar el texto debería pasar a "Texto"');
  await page.keyboard.type('Idea: app para el súper');
  await page.waitForTimeout(800);
  if (!(await note(page, id)).blocks[0].html.includes('Idea: app')) throw new Error('No se guardó lo tipeado en el iPad');
  step('En el iPad, tocar el texto pasa a "Texto" y se escribe con el teclado');

  // El lápiz apoyado en la hoja pasa solo a dibujar y el trazo arranca en ese mismo toque.
  await page.evaluate(() => {
    const sheet = document.querySelector('.sheet');
    const r = sheet.getBoundingClientRect();
    const ev = (type, x, y) => sheet.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 80, 80);
    for (let i = 1; i <= 10; i++) ev('pointermove', 80 + i * 20, 80 + i * 4);
    ev('pointerup', 280, 120);
  });
  await page.waitForTimeout(800);
  if ((await mode(page)).trim() !== 'Lápiz' || (await tool(page)) !== 'pen') throw new Error(`El lápiz debería volver a la lapicera: ${await tool(page)}`);
  if ((await note(page, id)).blocks[1].strokes.length !== 1) throw new Error('El trazo del lápiz no quedó en la hoja');
  if (await page.evaluate(() => document.activeElement?.classList.contains('text-block'))) throw new Error('El teclado debería cerrarse al dibujar');
  step('Con el lápiz en la hoja vuelve solo a "Lápiz" y el primer trazo ya se dibuja');

  if (errors.length) throw new Error(`Errores en la página: ${errors.join(' | ')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
