// Clase en vivo: la compu mira la grabación y el iPad toma notas sin tocar nada.
//   node test/live-e2e.mjs
import { createServer } from '../server/server.js';
import { createMockSupabase } from './mock-supabase.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const supa = createMockSupabase();
const supaUrl = await supa.listen();
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
const ZOOM = 'https://utdt.zoom.us/rec/share/clase4';
const secs = (t) => t.split(':').reduce((a, n) => a * 60 + Number(n), 0);

async function device(name) {
  const ctx = await browser.newContext();
  await ctx.route(/zoom\.us/, (r) => r.fulfill({ contentType: 'text/html', body: 'Zoom' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async (url) => {
    const db = await import('/js/db.js');
    await db.setSetting('appKey', 'clave-test');
    await db.setSetting('syncUrlOverride', url);
    (await import('/js/live.js')).start();
  }, supaUrl);
  const run = (fn, arg) => page.evaluate(fn, arg);
  const sync = () => run(async () => (await import('/js/sync.js')).syncNow());
  return { ctx, page, run, sync };
}

try {
  const mac = await device('mac');
  const ipad = await device('ipad');
  await mac.run(async (url) => {
    const db = await import('/js/db.js');
    await db.put('notebooks', { id: 'nb_c9', name: 'Dirección de Operaciones', courseId: 9, schedule: [], createdAt: 1,
      sections: [{ name: 'Clase 4', summary: '', links: [{ url, label: 'Grabación clase 4', kind: 'zoom' }], modules: [] }] });
  }, ZOOM);
  await mac.sync(); await ipad.sync();

  // Compu: Material → Ver y tomar notas → ▶
  await mac.page.goto(`${base}/#/cuaderno/nb_c9/material`);
  const popup = mac.ctx.waitForEvent('page');
  await mac.page.locator('.video-row button', { hasText: 'Ver y tomar notas' }).click();
  await (await popup).close();
  await mac.page.locator('.video-panel').waitFor();
  await mac.page.locator('.video-bar button[title="Reproducir / pausar"]').click();
  await mac.sync();
  step('Compu: abre la grabación y arranca el cronómetro');

  // iPad: sin tocar nada, abre la nota de la clase y sigue el minuto
  await ipad.page.waitForURL(/#\/nota\//, { timeout: 15000 });
  await ipad.page.locator('.video-follow:not([hidden])').waitFor({ timeout: 8000 });
  await ipad.page.waitForTimeout(1500);
  const [tm, ti] = await Promise.all([mac.page.locator('.video-time').textContent(), ipad.page.locator('.video-time').textContent()]);
  if (Math.abs(secs(tm) - secs(ti)) > 1) throw new Error(`Desfasados: compu ${tm}, iPad ${ti}`);
  step(`iPad: abrió sola la nota y va al mismo minuto (compu ${tm} · iPad ${ti})`);

  // Compu ajusta a 20:00 → el iPad salta
  await mac.page.locator('.video-bar button', { hasText: 'Ajustar' }).click();
  await mac.page.locator('.modal input').fill('20:00');
  await mac.page.locator('.modal button', { hasText: 'Ajustar' }).click();
  await ipad.page.waitForFunction(() => /^20:0\d$/.test(document.querySelector('.video-time')?.textContent || ''), null, { timeout: 8000 });
  step('Compu ajusta a 20:00 y el iPad salta solo');

  // Compu pausa → el iPad se detiene
  await mac.page.locator('.video-bar button[title="Reproducir / pausar"]').click();
  await ipad.page.waitForFunction(() => !document.querySelector('.video-time')?.classList.contains('on'), null, { timeout: 8000 });
  const p1 = await ipad.page.locator('.video-time').textContent();
  await ipad.page.waitForTimeout(1500);
  const p2 = await ipad.page.locator('.video-time').textContent();
  if (p1 !== p2) throw new Error(`El iPad sigue corriendo en pausa: ${p1} → ${p2}`);
  step(`Compu pausa y el iPad se detiene en ${p2}`);

  // Compu sigue → iPad escribe con el lápiz: el trazo queda en el minuto de la clase
  await mac.page.locator('.video-bar button[title="Reproducir / pausar"]').click();
  await ipad.page.waitForFunction(() => document.querySelector('.video-time')?.classList.contains('on'), null, { timeout: 8000 });
  await ipad.page.locator('.segmented button', { hasText: 'Lápiz' }).click();
  const sheet = ipad.page.locator('.sheet').last();
  await sheet.scrollIntoViewIfNeeded();
  const box = await sheet.boundingBox();
  await ipad.page.mouse.move(box.x + 60, 420);
  await ipad.page.mouse.down();
  await ipad.page.mouse.move(box.x + 200, 460, { steps: 8 });
  await ipad.page.mouse.up();
  await ipad.page.waitForTimeout(900);
  const noteId = ipad.page.url().split('/nota/')[1];
  const t = await ipad.run(async (id) => {
    const n = await (await import('/js/db.js')).get('notes', id);
    return n.blocks.flatMap((b) => b.strokes || []).at(-1);
  }, noteId);
  if (t?.rec !== 'video' || t.t < 1200000 || t.t > 1210000) throw new Error(`Trazo con minuto incorrecto: ${JSON.stringify(t && { rec: t.rec, t: t.t })}`);
  step(`iPad: el trazo queda en el minuto ${Math.round(t.t / 1000)} s de la clase`);

  // Lo del iPad llega a la compu y la compu (que sólo mira) no lo pisa
  await ipad.sync();
  await mac.page.locator('.video-bar button[title="Reproducir / pausar"]').click(); // pausa: guarda el minuto
  await mac.sync(); await mac.page.waitForTimeout(500); await mac.sync(); await ipad.sync();
  const strokes = await Promise.all([mac, ipad].map((d) => d.run(async (id) => (await (await import('/js/db.js')).get('notes', id)).blocks.flatMap((b) => b.strokes || []).length, noteId)));
  if (strokes.some((n) => n < 1)) throw new Error(`Se perdió el trazo del iPad: ${strokes}`);
  step('Las notas del iPad llegan a la compu y no se pisan');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
  supa.server.close();
}
