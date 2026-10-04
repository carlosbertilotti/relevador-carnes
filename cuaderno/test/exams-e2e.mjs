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
