// Fotos dentro de la hoja: pegar, escribir encima, mover, cambiar tamaño, deshacer,
// y pasar a la hoja las fotos que quedaron en el texto.   node test/photo-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);

try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  // Nota con una hoja y otra con una foto pegada en el texto (versión anterior)
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const store = await import('/js/store.js');
    const nb = await store.createNotebook({ name: 'Operaciones' });
    const c = Object.assign(document.createElement('canvas'), { width: 40, height: 30 });
    const g = c.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 40, 30);
    const url = c.toDataURL('image/png');
    await db.put('notes', { id: 'n_foto', notebookId: nb.id, title: 'Con foto', classDate: '2026-10-01', blocks: [store.newTextBlock(), store.newInkBlock({ paper: 'lined' })], recordings: [], createdAt: 1, updatedAt: 1 });
    await db.put('notes', { id: 'n_vieja', notebookId: nb.id, title: 'Vieja', classDate: '2026-10-01', blocks: [store.newInkBlock({ paper: 'lined' }), { id: 'b_txt', type: 'text', html: `<p>hola</p><p><img src="${url}" alt="x"></p><p><br></p>` }], recordings: [], createdAt: 1, updatedAt: 1 });
  });
  await page.goto(`${base}/#/nota/n_foto`);
  await page.locator('.sheet').first().waitFor();

  // 1) Pegar una foto (roja) → queda en la hoja
  await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 400, height: 300 });
    const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 400, 300);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'foto.png', { type: 'image/png' }));
    document.querySelector('.text-block').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(900);
  const note = () => page.evaluate(async () => (await import('/js/db.js')).get('notes', 'n_foto'));
  let n = await note();
  const ink = n.blocks.find((b) => b.type === 'ink');
  if (ink.photos?.length !== 1 || n.blocks.some((b) => (b.html || '').includes('<img'))) throw new Error(`La foto no quedó en la hoja: ${JSON.stringify(n.blocks.map((b) => ({ t: b.type, p: b.photos?.length, img: (b.html || '').includes('<img') })))}`);
  const ph = ink.photos[0];
  const pixel = await page.evaluate((ph) => {
    const bg = document.querySelector('.sheet .layer.bg');
    const k = bg.width / 1000;
    return [...bg.getContext('2d').getImageData(Math.round((ph.x + ph.w / 2) * k), Math.round((ph.y + ph.h / 2) * k), 1, 1).data];
  }, ph);
  if (!(pixel[0] > 200 && pixel[1] < 60)) throw new Error(`La foto no se dibuja en la hoja: ${pixel}`);
  step(`Pegar una foto la pone dentro de la hoja (${ph.w}×${ph.h}) y se ve`);

  // 2) Escribir encima con el lápiz
  await page.locator('.segmented button', { hasText: 'Lápiz' }).click();
  let box = await page.locator('.sheet').first().boundingBox();
  let k = box.width / 1000;
  let cx = box.x + (ph.x + ph.w / 2) * k;
  let cy = box.y + (ph.y + ph.h / 2) * k;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 10, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  n = await note();
  if (!n.blocks.find((b) => b.type === 'ink').strokes.length) throw new Error('No se pudo escribir encima de la foto');
  step('Se escribe encima de la foto con el lápiz');

  // 3) Lazo: mover y cambiar tamaño; deshacer
  await page.locator('.tool-group button[title^="Lazo"]').click();
  // al escribir se escondió la barra de materias: la hoja cambió de lugar y tamaño
  await page.waitForTimeout(500);
  box = await page.locator('.sheet').first().boundingBox();
  k = box.width / 1000;
  cx = box.x + (ph.x + ph.w / 2) * k;
  cy = box.y + (ph.y + ph.h / 2) * k;
  await page.mouse.click(cx + 80, cy - 40);
  await page.locator('.selection-bar', { hasText: 'Borrar foto' }).waitFor();
  await page.mouse.move(cx + 80, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  n = await note();
  const moved = n.blocks.find((b) => b.type === 'ink').photos[0];
  if (Math.abs(moved.y - (ph.y + 100 / k)) > 3) throw new Error(`No se movió: ${ph.y} → ${moved.y}`);
  const corner = [box.x + (moved.x + moved.w) * k, box.y + (moved.y + moved.h) * k];
  await page.mouse.move(...corner);
  await page.mouse.down();
  await page.mouse.move(corner[0] - 100, corner[1], { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  n = await note();
  const resized = n.blocks.find((b) => b.type === 'ink').photos[0];
  if (!(resized.w < moved.w - 50) || Math.abs(resized.w / resized.h - ph.w / ph.h) > 0.02) throw new Error(`No cambió el tamaño bien: ${JSON.stringify(resized)}`);
  await page.locator('.toolbar button[title="Deshacer"]').click();
  await page.waitForTimeout(600);
  n = await note();
  if (n.blocks.find((b) => b.type === 'ink').photos[0].w !== moved.w) throw new Error('Deshacer no volvió el tamaño');
  step('Con el lazo se mueve y se achica la foto (sin deformarla), y se deshace');

  // 4) Borrar
  await page.mouse.click(box.x + (moved.x + 30) * k, box.y + (moved.y + 30) * k);
  await page.locator('.selection-bar button', { hasText: 'Borrar foto' }).click();
  await page.waitForTimeout(600);
  n = await note();
  if (n.blocks.find((b) => b.type === 'ink').photos.length) throw new Error('No se borró');
  step('Borrar foto');

  // 5) Foto vieja pegada en el texto → pasa a la hoja
  await page.goto(`${base}/#/nota/n_vieja`);
  await page.locator('.sheet').first().waitFor();
  await page.waitForTimeout(1200);
  const v = await page.evaluate(async () => (await import('/js/db.js')).get('notes', 'n_vieja'));
  const t = v.blocks.find((b) => b.type === 'text');
  if (v.blocks[0].photos?.length !== 1 || t.html.includes('<img') || !t.html.includes('hola')) throw new Error(`No se pasó la foto vieja: ${JSON.stringify({ photos: v.blocks[0].photos, html: t.html })}`);
  step('La foto que estaba pegada en el texto pasa sola a la hoja (el texto queda)');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
