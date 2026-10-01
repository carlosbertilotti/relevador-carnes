// "Ver clase": grabación de Zoom del campus → nota con cronómetro, marcas y trazos con minuto.
//   node test/video-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
const ZOOM = 'https://utdt.zoom.us/rec/share/abc123';

try {
  const ctx = await browser.newContext();
  await ctx.route(/zoom\.us/, (r) => r.fulfill({ contentType: 'text/html', body: 'Zoom' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async (url) => {
    const db = await import('/js/db.js');
    await db.put('notebooks', { id: 'nb_c9', name: 'Dirección de Operaciones', courseId: 9, schedule: [], createdAt: 1,
      sections: [{ name: 'Clase 3', summary: '', links: [{ url, label: 'Grabación clase 3', kind: 'zoom' }], modules: [{ name: 'Grabación clase 3', type: 'url', url: 'https://campusvirtual.utdt.edu/mod/url/view.php?id=1', externalUrl: url, files: [] }] }] });
  }, ZOOM);
  await page.goto(`${base}/#/cuaderno/nb_c9/material`);
  const row = page.locator('.video-row', { hasText: 'Grabación clase 3' });
  await row.waitFor({ timeout: 8000 });
  if (await page.locator('.file-row.link', { hasText: 'Grabación clase 3' }).count()) throw new Error('El link de Zoom aparece duplicado');
  step('Material muestra la grabación de Zoom de la clase');

  const popupP = ctx.waitForEvent('page', { timeout: 5000 });
  await row.locator('button', { hasText: 'Ver y tomar notas' }).click();
  const popup = await popupP;
  if (!popup.url().startsWith(ZOOM)) throw new Error(`Abrió ${popup.url()}`);
  await popup.close();
  await page.locator('.video-panel').waitFor({ timeout: 8000 });
  if (/null/.test(await page.locator('.video-panel').innerText())) throw new Error('El panel muestra "null"');
  if (!(await page.locator('.video-hint:not([hidden])').count())) throw new Error('Falta el aviso de tocar ▶');
  step('Abre Zoom y la nota de la clase con el cronómetro');

  // Cronómetro: ajustar a 12:00 y marcar
  await page.locator('.video-bar button', { hasText: 'Ajustar' }).click();
  await page.locator('.modal input').fill('12:00');
  await page.locator('.modal button', { hasText: 'Ajustar' }).click();
  await page.locator('.video-bar button[title="Reproducir / pausar"]').click();
  await page.waitForTimeout(1700);
  const t = await page.locator('.video-time').textContent();
  if (!/^12:0[1-3]$/.test(t)) throw new Error(`Cronómetro: ${t}`);
  await page.locator('.video-bar button', { hasText: 'Marcar' }).click();
  const chip = page.locator('.text-block .ts');
  await chip.first().waitFor();
  step(`Cronómetro corre (${t}) y "Marcar" deja ${await chip.first().textContent()} en la nota`);

  // Un trazo guarda el minuto del video
  const canvas = page.locator('.sheet').last();
  await canvas.scrollIntoViewIfNeeded();
  await page.locator('.segmented button', { hasText: 'Lápiz' }).click();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 50, 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, 440, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const saved = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const n = (await db.all('notes')).find((x) => x.video?.url);
    const st = n.blocks.flatMap((b) => b.strokes || []).at(-1);
    return { title: n.title, rec: st?.rec, t: st?.t, html: n.blocks.map((b) => b.html || '').join(''), open: n.video.open, id: n.id };
  });
  if (!(await page.evaluate(() => document.body.classList.contains('sidebar-hidden')))) throw new Error('La barra de materias no se escondió al escribir');
  await page.locator('.editor-head button[title="Mostrar / esconder las materias"]').click();
  if (await page.evaluate(() => document.body.classList.contains('sidebar-hidden'))) throw new Error('El botón no volvió a mostrar las materias');
  step('Al escribir se esconde la barra de materias y el botón la vuelve a mostrar');
    if (saved.rec !== 'video' || !(saved.t > 720000)) throw new Error(`Trazo sin minuto: ${JSON.stringify(saved)}`);
  if (!saved.html.includes('data-t="72')) throw new Error(`Marca no guardada: ${saved.html}`);
  step(`Trazo guardado en el minuto ${Math.round(saved.t / 1000)} s; nota "${saved.title}"`);

  // Tocar la marca vuelve a ese minuto
  await page.locator('.video-bar button', { hasText: '+10 s' }).click();
  await page.locator('.video-bar button', { hasText: '+10 s' }).click();
  await chip.first().click();
  const back = await page.locator('.video-time').textContent();
  if (!/^12:0[1-3]$/.test(back)) throw new Error(`La marca no volvió al minuto: ${back}`);
  step('Tocar la marca vuelve al minuto');

  // Volver a Material: "Seguir viendo" abre la misma nota
  await page.goto(`${base}/#/cuaderno/nb_c9/material`);
  await row.locator('button', { hasText: 'Seguir viendo' }).waitFor();
  const p2 = ctx.waitForEvent('page');
  await row.locator('button', { hasText: 'Seguir viendo' }).click();
  await (await p2).close();
  await page.waitForURL(new RegExp(`/nota/${saved.id}`));
  step('"Seguir viendo" vuelve a la misma nota');

  // Video descargado: se reproduce dentro de la nota
  const bytes = await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const iv = setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360},80%,50%)`; g.fillRect(0, 0, 160, 90); }, 60);
    rec.start();
    await new Promise((r) => setTimeout(r, 1500));
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    clearInterval(iv);
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  await page.locator('.video-bar input[type=file]').setInputFiles({ name: 'clase3.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });
  await page.locator('video.class-video').waitFor();
  await page.locator('.video-bar button', { hasText: 'Ir a un trazo' }).click();
  if (!(await page.locator('video.class-video').count())) throw new Error('El video desapareció');
  await page.locator('.video-bar button', { hasText: 'Tocá un trazo' }).click();
  step('Video descargado: se carga y se reproduce dentro de la nota');

  // Cerrar el panel
  await page.locator('.video-panel').waitFor();
  await page.locator('.video-bar button[title="Cerrar"]').click();
  if (await page.locator('.video-panel').count()) throw new Error('No se cerró');
  step('Cerrar el panel');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
