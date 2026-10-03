// "Para esta clase": tocar un día de cursada muestra los PDFs y lecturas de esa clase,
// sacados de la sección del campus y del programa.   node test/classplan-e2e.mjs
import { createServer } from '../server/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);

// PDF mínimo con texto (una línea por renglón)
function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 11 Tf 50 780 Td 14 TL ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  const pdf = makePdf([
    'Programa Finanzas Corporativas 2026',
    'Cronograma',
    'Clase 1 (8/10): Introduccion. Lecturas: Brealey Myers Allen capitulo 1.',
    'Clase 2 (9/10): Valuacion de proyectos. Lectura: Koller Valuation.',
    'Caso Marriott Corporation para discutir en clase.',
    'Clase 3 (10/10): Costo de capital.',
  ]);
  await page.evaluate(async (pdf) => {
    const db = await import('/js/db.js');
    const U = 'https://campusvirtual.utdt.edu/pluginfile.php/1/';
    await db.put('notebooks', { id: 'nb_c7706', name: 'Finanzas Corporativas [M. Machinea]', courseId: 7706, status: 'cursando', schedule: [], createdAt: 1,
      sections: [
        { name: 'Finanzas Corporativas - Prof. Melani Machinea', modules: [{ name: 'Programa', type: 'resource', files: [{ name: 'Programa Finanzas 2026.pdf', url: `${U}prog.pdf` }] }] },
        { name: 'Clase 1 | Introducción', links: [{ url: 'https://utdt.zoom.us/rec/share/x', label: 'Grabación clase 1', kind: 'zoom' }], modules: [{ name: 'Slides', type: 'resource', files: [{ name: 'Clase 1 - Intro slides.pdf', url: `${U}c1.pdf` }] }] },
        { name: 'Material', modules: [{ name: 'Lecturas', type: 'resource', files: [{ name: 'Koller - Valuation.pdf', url: `${U}koller.pdf` }, { name: 'Marriott Corporation (caso).pdf', url: `${U}marriott.pdf` }, { name: 'Otro paper irrelevante.pdf', url: `${U}otro.pdf` }] }] },
      ] });
    const files = [['prog', 'Programa Finanzas 2026.pdf', 'prog.pdf'], ['c1', 'Clase 1 - Intro slides.pdf', 'c1.pdf'], ['koller', 'Koller - Valuation.pdf', 'koller.pdf'], ['marriott', 'Marriott Corporation (caso).pdf', 'marriott.pdf'], ['otro', 'Otro paper irrelevante.pdf', 'otro.pdf']];
    for (const [id, name, u] of files) await db.put('files', { id: `c7706_${id}`, courseId: 7706, notebookId: 'nb_c7706', name, url: `${U}${u}`, downloaded: id === 'prog', seen: true, modified: 1 });
    await db.put('blobs', { id: 'file:c7706_prog', blob: new Blob([pdf], { type: 'application/pdf' }) });
    const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
    await db.setSetting('campusEvents', [
      { id: 'moodle-1', title: 'Finanzas Corporativas - Prof. Machinea', start: at(8, 15), end: at(8, 18), courseId: 7410, kind: 'evento', source: 'campus' },
      { id: 'moodle-2', title: 'Finanzas Corporativas - Prof. Machinea', start: at(9, 9), end: at(9, 12), courseId: 7410, kind: 'evento', source: 'campus' },
      { id: 'moodle-3', title: 'Examen Presencial | Dirección de Operaciones - Prof. Vulcano', start: at(8, 12), end: at(8, 14), courseId: 7410, kind: 'evento', source: 'campus' },
      { id: 'moodle-4', title: 'TP 1 is due', start: at(9, 8), end: at(9, 8), courseId: 7706, kind: 'entrega', source: 'campus' },
    ]);
  }, pdf);

  // Calendario de esa semana: los días de cursada aparecen como clase de la materia
  await page.goto(`${base}/#/calendario/2026-10-08`);
  const classes = page.locator('.cal-event.clase');
  await classes.first().waitFor();
  if ((await classes.count()) !== 2) throw new Error(`Esperaba 2 clases, hay ${await classes.count()}`);
  if (await page.locator('.cal-event.clase', { hasText: 'Examen' }).count()) throw new Error('El examen quedó como clase');
  step('Los días de cursada del campus aparecen como clases de la materia (el examen no)');

  // Clase 1: sección "Clase 1" del campus + programa
  await classes.nth(0).click();
  await page.locator('.class-plan .file-row').first().waitFor({ timeout: 10000 });
  let txt = await page.locator('.class-plan').innerText();
  if (!/Clase 1 de 2/.test(txt) || !txt.includes('Clase 1 - Intro slides.pdf') || !txt.includes('Grabación clase 1')) throw new Error(`Clase 1 mal:\n${txt}`);
  if (!/Brealey/.test(txt)) throw new Error('Falta el pedazo del programa');
  step('Clase 1: muestra los PDFs de la sección "Clase 1", la grabación y lo que dice el programa');
  await page.locator('.modal button[aria-label="Cerrar"]').click();

  // Clase 2: no hay sección; las lecturas salen del programa
  await classes.nth(1).click();
  await page.locator('.class-plan .file-row').first().waitFor({ timeout: 10000 });
  txt = await page.locator('.class-plan').innerText();
  if (!/Clase 2 de 2/.test(txt) || !txt.includes('Koller - Valuation.pdf') || !txt.includes('Marriott Corporation (caso).pdf')) throw new Error(`Clase 2 sin lecturas del programa:\n${txt}`);
  if (txt.includes('Otro paper irrelevante') || txt.includes('Costo de capital')) throw new Error(`Clase 2 trae cosas de más:\n${txt}`);
  if (!txt.includes('TP 1 is due')) throw new Error('Falta la entrega');
  step('Clase 2: las lecturas salen del programa (Koller, caso Marriott) y muestra la entrega del día');

  // Tomar notas desde ahí
  await page.locator('.class-plan button', { hasText: 'Tomar notas' }).click();
  await page.waitForURL(/#\/nota\//);
  step('"Tomar notas de esta clase" abre la nota');

  // Mi día: debajo de la clase, qué leer
  await page.goto(`${base}/#/hoy/2026-10-09`);
  await page.locator('.class-reading', { hasText: 'Koller' }).waitFor({ timeout: 10000 });
  step(`Mi día muestra qué leer: "${(await page.locator('.class-reading span').first().innerText()).slice(0, 90)}"`);

  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
