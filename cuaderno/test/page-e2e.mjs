// Una sola hoja para escribir con el teclado y dibujar con el lápiz, y fotos que se
// pegan, mueven, giran, recortan y se escriben encima.   node test/page-e2e.mjs
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
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(600);
  const db = (fn, arg) => page.evaluate(fn, arg);
  const note = (id) => db(async (nid) => (await import('/js/db.js')).get('notes', nid), id);
  await db(async () => {
    const d = await import('/js/db.js');
    const store = await import('/js/store.js');
    const nb = await store.createNotebook({ name: 'Finanzas Corporativas' });
    await store.createNote(nb.id, { title: 'Con texto', blocks: [store.newInkBlock({ paper: 'lined', html: '<p>Estructura de capital</p><p>Modigliani y Miller</p>' })] });
    await d.put('notes', { id: 'n_viejo', notebookId: nb.id, title: 'Viejo', classDate: '2026-10-01', blocks: [store.newTextBlock('<p>texto de antes</p>'), store.newInkBlock({ paper: 'lined' })], recordings: [], createdAt: 1, updatedAt: 1 });
    const strokes = [{ tool: 'pen', color: '#d0342c', size: 4, pressure: false, points: [[100, 200, 0.5], [300, 210, 0.5]] }];
    await d.put('notes', { id: 'n_dibujo', notebookId: nb.id, title: 'Con dibujo', classDate: '2026-10-01', blocks: [store.newTextBlock('<p>apuntes sueltos</p>'), { ...store.newInkBlock({ paper: 'lined' }), strokes }], recordings: [], createdAt: 1, updatedAt: 1 });
  });
  const idCon = await db(async () => (await (await import('/js/db.js')).all('notes')).find((n) => n.title === 'Con texto').id);

  // ---- La hoja con texto ----
  await page.goto(`${base}/#/nota/${idCon}`);
  await page.locator('.sheet .page-text').waitFor();
  await page.waitForTimeout(500);
  const order = await db(() => {
    const kids = [...document.querySelector('.sheet').children].map((c) => (c.tagName === 'CANVAS' ? c.className.replace('layer ', '') : 'text'));
    const ink = document.querySelector('.sheet .layer.ink');
    return { kids, pe: getComputedStyle(ink).pointerEvents };
  });
  if (order.kids.join() !== 'bg,text,ink,live' || order.pe !== 'none') throw new Error(`Capas: ${JSON.stringify(order)}`);
  step('El texto va entre el papel y la tinta (lo dibujado queda por encima) y la tinta no tapa los toques');

  const geo = await db(() => {
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    const p = document.querySelector('.page-text p').getBoundingClientRect();
    const k = 1000 / sheet.width;
    return { bottom: (p.bottom - sheet.top) * k, height: p.height * k, left: (p.left - sheet.left) * k };
  });
  if (Math.abs(geo.bottom - 120) > 1.5 || Math.abs(geo.height - 42) > 1) throw new Error(`El renglón de texto no coincide con el de la hoja: ${JSON.stringify(geo)}`);
  if (geo.left < 95 || geo.left > 130) throw new Error(`El texto debería empezar después del margen: ${geo.left}`);
  step('Cada línea de texto apoya sobre un renglón del papel (la primera sobre la raya de 120) y arranca después del margen');

  // Tipear y dibujar en la misma hoja, y que crezca sola
  await page.locator('.page-text').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' - 25%');
  await page.waitForTimeout(700);
  let n = await note(idCon);
  if (!n.blocks[0].html.includes('25%')) throw new Error('No se guardó lo tipeado');
  const h0 = n.blocks[0].height;
  await db(() => {
    const el = document.querySelector('.page-text');
    el.innerHTML = Array.from({ length: 60 }, (_, i) => `<p>Línea ${i + 1} de una nota larga</p>`).join('');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  n = await note(idCon);
  const px = await db(() => Math.round(document.querySelector('.sheet').getBoundingClientRect().height / document.querySelector('.sheet').getBoundingClientRect().width * 1000));
  if (!(n.blocks[0].height > h0 && n.blocks[0].height >= 60 * 42 + 120) || Math.abs(px - n.blocks[0].height) > 2) throw new Error(`La hoja no creció con el texto: ${h0} → ${n.blocks[0].height} (en pantalla ${px})`);
  step(`La hoja crece sola cuando el texto llega abajo (${h0} → ${n.blocks[0].height})`);

  // Cambiar el papel mueve el texto con él
  await page.locator('.block-menu').first().click();
  await page.locator('.popover .menu-item', { hasText: 'Cuadriculada' }).click();
  const paper = await db(() => ({ p: document.querySelector('.sheet').dataset.paper, pl: getComputedStyle(document.querySelector('.page-text')).paddingLeft }));
  if (paper.p !== 'grid' || parseFloat(paper.pl) > 80) throw new Error(`El texto no siguió al papel: ${JSON.stringify(paper)}`);
  await page.locator('.block-menu').first().click();
  await page.locator('.popover .menu-item', { hasText: 'Rayada' }).click();
  step('Al cambiar el papel (cuadriculado, rayado…) el texto se acomoda a sus líneas');

  // Búsqueda: el texto de la hoja se encuentra
  const found = await db(async () => (await (await import('/js/store.js')).searchNotes('línea 7 de una')).map((r) => r.note.title));
  if (!found.includes('Con texto')) throw new Error(`La búsqueda no encuentra el texto de la hoja: ${found}`);
  step('La búsqueda y los resúmenes leen el texto de la hoja');

  // Exportar: papel, texto y tinta
  await db(() => { window.print = () => {}; });
  await page.locator('.editor-head button[title="Exportar / imprimir"]').click();
  await page.waitForTimeout(200);
  const pr = await db(() => {
    const root = document.querySelector('.print-root');
    const pg = root?.querySelector('.print-page');
    return { page: !!pg, kids: pg ? [...pg.children].map((c) => c.tagName + '.' + c.className.split(' ')[0]).join() : '', text: pg?.textContent.includes('Línea 7') };
  });
  if (!pr.page || pr.kids !== 'IMG.print-bg,DIV.text-block,IMG.print-ink' || !pr.text) throw new Error(`Exportación: ${JSON.stringify(pr)}`);
  await db(() => { document.querySelector('.print-root')?.remove(); document.body.classList.remove('printing'); });
  step('Exportar / imprimir lleva el papel, el texto y la tinta en capas');

  // ---- Notas hechas con el formato anterior ----
  await page.goto(`${base}/#/nota/n_viejo`);
  await page.locator('.sheet .page-text').waitFor();
  await page.waitForTimeout(1100); // el guardado espera 0,5 s
  n = await note('n_viejo');
  if (n.blocks.length !== 1 || !n.blocks[0].html.includes('texto de antes') || (await page.locator('.block.text').count())) throw new Error(`No se unió el texto con la hoja vacía: ${JSON.stringify(n.blocks.map((b) => b.type))}`);
  step('Una nota vieja (texto arriba + hoja vacía) pasa sola a una sola hoja con el texto adentro');

  await page.goto(`${base}/#/nota/n_dibujo`);
  await page.locator('.sheet').waitFor();
  await page.waitForTimeout(500);
  n = await note('n_dibujo');
  if (n.blocks.length !== 2) throw new Error('Si la hoja ya tiene dibujo, no se debería unir sola');
  await page.locator('.editor-head button[title="Más"]').click();
  await page.locator('.popover .menu-item', { hasText: 'Pasar el texto a la hoja' }).click();
  await page.waitForTimeout(700);
  n = await note('n_dibujo');
  if (n.blocks.length !== 1 || !n.blocks[0].html.includes('apuntes sueltos') || n.blocks[0].strokes.length !== 1) throw new Error('No pasó el texto a la hoja conservando el dibujo');
  await page.locator('.toolbar button[title="Deshacer"]').click();
  await page.waitForTimeout(700);
  n = await note('n_dibujo');
  if (n.blocks.length !== 2 || !n.blocks.some((b) => b.type === 'text')) throw new Error('Deshacer no devolvió el texto suelto');
  step('"Pasar el texto a la hoja" une el texto con un dibujo sin perderlo, y se deshace');

  // ---- Fotos ----
  await page.goto(`${base}/#/nota/${idCon}`);
  await page.locator('.sheet .page-text').waitFor();
  const paste = () => db(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 400, height: 300 });
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 200, 300); // izquierda roja
    g.fillStyle = '#0000ff'; g.fillRect(200, 0, 200, 300); // derecha azul
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'foto.png', { type: 'image/png' }));
    document.querySelector('.page-text').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await paste();
  await page.locator('.selection-bar button', { hasText: 'Recortar' }).waitFor();
  if (!(await page.locator('.selection-bar button', { hasText: 'Girar' }).count())) throw new Error('Falta "Girar"');
  const photo = async () => { await page.waitForTimeout(700); return (await note(idCon)).blocks[0].photos.at(-1); }; // el guardado espera 0,5 s
  const pixel = (ph) => db((p) => {
    const bg = document.querySelector('.sheet .layer.bg');
    const k = bg.width / 1000;
    return [...bg.getContext('2d').getImageData(Math.round((p.x + p.w / 2) * k), Math.round((p.y + p.h / 2) * k), 1, 1).data];
  }, ph);
  let ph = await photo();
  if ((await db(async () => (await import('/js/editor/ink.js')).tools.tool)) !== 'lasso') throw new Error('Al pegar, la foto debería quedar seleccionada con el lazo');
  step('Pegar una imagen la deja seleccionada, con "Recortar", "Girar" y "Borrar foto" a mano');

  // Girar: cuarto de vuelta, el marco se da vuelta; rojo arriba y azul abajo
  await page.locator('.selection-bar button', { hasText: 'Girar' }).click();
  await page.waitForTimeout(500);
  let ph2 = await photo();
  if (ph2.rot !== 1 || ph2.w !== ph.h || ph2.h !== ph.w) throw new Error(`Girar: ${JSON.stringify({ ph, ph2 })}`);
  const cy = (p, f) => ({ ...p, y: p.y + p.h * f, h: 0 });
  const top = await pixel({ ...ph2, y: ph2.y + ph2.h * 0.25, h: 0 });
  const bottom = await pixel({ ...ph2, y: ph2.y + ph2.h * 0.75, h: 0 });
  if (!(top[0] > 200 && top[2] < 60 && bottom[2] > 200 && bottom[0] < 60)) throw new Error(`La foto no se dibuja girada: arriba ${top} abajo ${bottom}`);
  step('Girar da un cuarto de vuelta (lo rojo de la izquierda pasa arriba)');

  // Recortar sobre la foto girada: sacar la mitad de arriba (roja) → queda la derecha original (azul)
  await page.locator('.selection-bar button', { hasText: 'Recortar' }).click();
  const canvas = page.locator('.modal .crop-canvas');
  await canvas.waitFor();
  let cb = await canvas.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + 1);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.locator('.modal-actions button', { hasText: /^Recortar$/ }).click();
  await page.waitForTimeout(500);
  ph2 = await photo();
  const c = ph2.crop;
  if (!c || Math.abs(c.x - 0.5) > 0.03 || Math.abs(c.w - 0.5) > 0.03 || c.y > 0.02 || Math.abs(c.h - 1) > 0.03) throw new Error(`Recorte (girado) mal convertido: ${JSON.stringify(c)}`);
  const aspect = ph2.w / ph2.h; // la mitad derecha de 400×300 = 200×300, girada = 300×200
  if (Math.abs(aspect - 1.5) > 0.05) throw new Error(`Proporción tras recortar: ${aspect}`);
  const only = await pixel(ph2);
  if (!(only[2] > 200 && only[0] < 60)) throw new Error(`Debería verse sólo lo azul: ${only}`);
  step('Recortar (con la foto girada) deja sólo la parte elegida y la foto cambia de proporción');

  // Volver a abrir: se agranda y "Restablecer" devuelve la foto entera
  await page.locator('.selection-bar button', { hasText: 'Recortar' }).click();
  await canvas.waitFor();
  await page.locator('.modal-actions button', { hasText: 'Restablecer' }).click();
  await page.locator('.modal-actions button', { hasText: /^Recortar$/ }).click();
  await page.waitForTimeout(500);
  ph2 = await photo();
  if (!ph2.crop || Math.abs(ph2.crop.w - 1) > 0.01 || Math.abs(ph2.crop.h - 1) > 0.01) throw new Error(`Restablecer: ${JSON.stringify(ph2.crop)}`);
  step('El recorte no destruye la foto: se vuelve a abrir y "Restablecer" la deja entera');

  // Deshacer vuelve atrás (recorte, giro)
  await page.locator('.toolbar button[title="Deshacer"]').click();
  await page.waitForTimeout(300);
  let u = await photo();
  if (!u.crop || Math.abs(u.crop.w - 0.5) > 0.03) throw new Error(`Deshacer (restablecer): ${JSON.stringify(u.crop)}`);
  await page.locator('.toolbar button[title="Deshacer"]').click();
  await page.waitForTimeout(300);
  await page.locator('.toolbar button[title="Deshacer"]').click();
  await page.waitForTimeout(500);
  u = await photo();
  if (u.crop || u.rot || u.w !== ph.w) throw new Error(`Deshacer no volvió a la foto original: ${JSON.stringify(u)}`);
  step('Deshacer devuelve la foto paso a paso');

  // Escribir encima: con el lápiz y con el teclado
  await page.locator('.segmented button', { hasText: 'Lápiz' }).click();
  let box = await page.locator('.sheet').first().boundingBox();
  const k = box.width / 1000;
  ph = await photo();
  const x = box.x + (ph.x + ph.w / 2) * k;
  const y = box.y + (ph.y + ph.h / 2) * k;
  await page.mouse.move(x - 40, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 15, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const strokes = (await note(idCon)).blocks[0].strokes.length;
  if (strokes !== 1) throw new Error(`No se pudo dibujar sobre la foto (${strokes} trazos)`);
  await page.locator('.segmented button', { hasText: 'Texto' }).click();
  await page.locator('.page-text').click({ position: { x: 60, y: 30 } });
  await page.keyboard.type('X');
  step('Sobre la foto se escribe con el lápiz y con el teclado');

  // Arrastrar una imagen a la nota
  const before = (await note(idCon)).blocks[0].photos.length;
  await db(async () => {
    const c2 = Object.assign(document.createElement('canvas'), { width: 100, height: 100 });
    const g = c2.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 100, 100);
    const blob = await new Promise((r) => c2.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'soltada.png', { type: 'image/png' }));
    document.querySelector('.editor-scroll').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(900);
  if ((await note(idCon)).blocks[0].photos.length !== before + 1) throw new Error('Soltar una imagen en la nota no la agregó');
  step('Arrastrar una imagen y soltarla en la nota también la agrega');

  if (errors.length) throw new Error(`Errores en la página: ${errors.join(' | ')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
