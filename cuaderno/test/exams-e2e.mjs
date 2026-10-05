// Preparación de exámenes: próximo examen, guía de estudio y exámenes para resolver.
//   node test/exams-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    await db.put('notebooks', { id: 'nb_c7704', name: 'Dirección de Operaciones [G. Vulcano]', courseId: 7704, schedule: [], sections: [], createdAt: 1 });
    const in3 = new Date(); in3.setDate(in3.getDate() + 3); in3.setHours(12, 0, 0, 0);
    await db.setSetting('campusEvents', [
      { id: 'm1', title: 'Examen Presencial | Dirección de Operaciones - Prof. Vulcano', start: in3.getTime(), end: in3.getTime() + 7200000, courseId: 7410, kind: 'evento', source: 'campus' },
      { id: 'm2', title: 'Finanzas Corporativas - Prof. Machinea', start: in3.getTime(), end: in3.getTime() + 7200000, courseId: 7410, kind: 'evento', source: 'campus' },
    ]);
  });
  await page.goto(`${base}/#/cuaderno/nb_c7704/examenes`);
  await page.locator('nav.tabs button.active', { hasText: 'Preparación de exámenes' }).waitFor();
  await page.locator('.exam-next', { hasText: 'Examen Presencial' }).waitFor();
  const days = await page.locator('.exam-days strong').innerText();
  if (days !== '3') throw new Error(`Cuenta regresiva: ${days}`);
  step('La pestaña muestra el próximo examen del campus y cuántos días faltan (3)');

  // Guía de estudio con fórmulas
  await page.locator('.exam-guide').locator('xpath=..').locator('button', { hasText: 'Escribir' }).click();
  await page.locator('.exam-guide-edit').fill('## Trampas\n- Fractil crítico $\\frac{C_u}{C_u+C_o}$\n- **σ√L** en el leadtime');
  await page.locator('button', { hasText: 'Guardar' }).click();
  await page.locator('.exam-guide h2', { hasText: 'Trampas' }).waitFor();
  if (!(await page.locator('.exam-guide .katex').count())) throw new Error('No se dibujó la fórmula');
  const saved = await page.evaluate(async () => (await (await import('/js/db.js')).get('notebooks', 'nb_c7704')).examPrep?.md);
  if (!saved?.includes('Fractil')) throw new Error('No se guardó la guía');
  step('Guía de estudio: se escribe, se guarda en la materia y muestra fórmulas');

  // Subir un examen anterior y una solución
  await page.locator('.exam-guide').locator('xpath=ancestor::div[contains(@class,"tab-body")]').locator('select').selectOption('examen');
  await page.locator('label', { hasText: 'Subir examen' }).locator('input').setInputFiles({ name: 'Final Febrero 2022.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) });
  await page.locator('.file-row', { hasText: 'Final Febrero 2022.pdf' }).waitFor();
  await page.locator('select').selectOption('solucion');
  await page.locator('label', { hasText: 'Subir examen' }).locator('input').setInputFiles({ name: 'Solucion Feb 2022.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) });
  await page.locator('.file-row', { hasText: 'Solucion Feb 2022.pdf' }).waitFor();
  const groups = await page.locator('.exam-group').allInnerTexts();
  if (groups.join() !== 'Examen anterior,Solución') throw new Error(`Grupos: ${groups}`);
  step('Exámenes anteriores y soluciones se suben y quedan agrupados');

  // No aparecen en Material, y "Resolver" abre una nota para escribir encima
  await page.goto(`${base}/#/cuaderno/nb_c7704/material`);
  await page.waitForTimeout(600);
  if (await page.locator('.file-row', { hasText: 'Final Febrero 2022.pdf' }).count()) throw new Error('El examen aparece también en Material');
  await page.goto(`${base}/#/cuaderno/nb_c7704/examenes`);
  await page.locator('.file-row', { hasText: 'Final Febrero 2022.pdf' }).locator('button', { hasText: 'Resolver' }).click();
  await page.waitForURL(/#\/nota\//, { timeout: 10000 });
  await page.locator('.sheet').first().waitFor();
  step('"Resolver" abre el examen en una nota para escribir con el lápiz (y no se mezcla con Material)');

  // Simulacro que viene con la app (srcUrl): se baja solo, se resuelve y se envía a corregir
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    await db.put('files', { id: 'sim_test', courseId: null, notebookId: 'nb_c7704', name: 'Simulacro final.pdf', size: 81232, mimetype: 'application/pdf', modified: 1, local: false, seen: true, addedAt: 2, exam: true, examKind: 'simulacro', srcUrl: '/exams/simulacro-dop-2026-10.pdf' }, { remote: true });
  });
  await page.goto(`${base}/#/cuaderno/nb_c7704/examenes`);
  const simRow = page.locator('.file-row', { hasText: 'Simulacro final.pdf' });
  await simRow.waitFor();
  await simRow.locator('button', { hasText: 'Resolver' }).click();
  await page.waitForURL(/#\/nota\//, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.sheet').length === 8, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const inkOnPage = await page.evaluate(() => {
    const bg = document.querySelector('.sheet .layer.bg');
    const d = bg.getContext('2d').getImageData(0, 0, bg.width, Math.min(bg.height, 400)).data;
    let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 0) dark++;
    return dark;
  });
  if (inkOnPage < 500) throw new Error(`La primera hoja del simulacro no se dibujó (píxeles oscuros: ${inkOnPage})`);
  step('El simulacro que viene con la app se baja solo y abre sus 8 hojas para resolver');
  const simNote = page.url().split('/nota/')[1];

  // Escribir algo y enviar a corregir
  await page.locator('.segmented button', { hasText: 'Lápiz' }).click();
  const sb = await page.locator('.sheet').first().boundingBox();
  await page.mouse.move(sb.x + 100, sb.y + 300); await page.mouse.down(); await page.mouse.move(sb.x + 400, sb.y + 330, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(700);
  await page.locator('.editor-head button[title="Más"]').click();
  await page.locator('.popover .menu-item', { hasText: 'Enviar a corregir' }).click();
  await page.waitForTimeout(2500);
  const corr = await page.evaluate(async (id) => {
    const db = await import('/js/db.js');
    const n = await db.get('notes', id);
    const blobs = (await db.all('blobs')).filter((b) => b.id.startsWith(`corr:${id}:`));
    return { pages: n.correction?.pages?.length, blobs: blobs.length, types: [...new Set(blobs.map((b) => b.blob.type))], maxKb: Math.round(Math.max(...blobs.map((b) => b.blob.size)) / 1024) };
  }, simNote);
  if (corr.pages !== 8 || corr.blobs !== 8 || corr.types.join() !== 'image/jpeg' || corr.maxKb > 400) throw new Error(`Enviar a corregir: ${JSON.stringify(corr)}`);
  step(`"Enviar a corregir" guarda las 8 hojas como JPEG (la más pesada: ${corr.maxKb} KB) y las deja listas para subir`);

  // Volver a la pestaña: ahora dice "Seguir resolviendo" y va a la misma nota
  await page.goto(`${base}/#/cuaderno/nb_c7704/examenes`);
  await simRow.locator('button', { hasText: 'Seguir resolviendo' }).click();
  await page.waitForURL(new RegExp(`/nota/${simNote}`));
  step('"Seguir resolviendo" vuelve a la misma nota');

  // Mi día: el examen con la cuenta regresiva y el simulacro a un toque
  await page.goto(`${base}/#/hoy`);
  const card = page.locator('.exams-today .exam-today', { hasText: 'Dirección de Operaciones' });
  await card.waitFor({ timeout: 8000 });
  if ((await card.locator('.exam-days strong').innerText()) !== '3') throw new Error('Mi día: cuenta regresiva');
  if (!(await card.innerText()).includes('enviado a corregir')) throw new Error('Mi día: no dice que el simulacro se envió a corregir');
  if (await page.locator('.exams-today', { hasText: 'Finanzas' }).count()) throw new Error('Mi día: mostró una clase como examen');
  await card.locator('button', { hasText: 'Seguir el simulacro' }).click();
  await page.waitForURL(new RegExp(`/nota/${simNote}`));
  await card.page().goto(`${base}/#/hoy`);
  await card.locator('button', { hasText: 'Preparación' }).click();
  await page.waitForURL(/#\/cuaderno\/nb_c7704\/examenes/);
  step('Mi día muestra el examen (faltan 3 días), que el simulacro ya se mandó a corregir, y lleva al simulacro y a Preparación');

  // Errores claros en vez de "Invalid URL"
  const errs = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const campus = await import('/js/campus.js');
    await db.put('files', { id: 'no_url', notebookId: 'nb_c7704', name: 'x.pdf', local: false }, { remote: true });
    await db.put('files', { id: 'bad_src', notebookId: 'nb_c7704', name: 'y.pdf', local: false, srcUrl: '/index.html' }, { remote: true });
    const out = [];
    for (const id of ['no_url', 'bad_src']) out.push(await campus.download(id).then(() => 'ok', (e) => e.message));
    const r = await fetch('/api/campus/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://campusvirtual.utdt.edu', token: 't' }) });
    out.push((await r.json()).error);
    return out;
  });
  if (!/sincronizar/.test(errs[0]) || !/no es un PDF/.test(errs[1]) || !/no viene del campus/.test(errs[2])) throw new Error(`Errores: ${JSON.stringify(errs)}`);
  step('Un archivo sin dirección o que no es un PDF da un mensaje claro (no "Invalid URL")');

  // Celular: sin scroll horizontal
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${base}/#/cuaderno/nb_c7704/examenes`);
  await page.locator('.exam-next').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`Scroll horizontal en celular: ${overflow}px`);
  step('En el celular entra sin scroll horizontal');

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
