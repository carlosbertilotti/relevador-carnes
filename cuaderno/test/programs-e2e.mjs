// Texto de programas y consignas de las materias en curso: se extrae de PDF,
// Word (.docx) y Word viejo (.doc) y queda marcado para sincronizar.
//   node test/programs-e2e.mjs
import { createServer } from '../server/server.js';
import JSZip from 'jszip';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = createServer();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://localhost:${app.address().port}`;
const browser = await chromium.launch();
const errors = [];
const step = (m) => console.log(`✓ ${m}`);

// .docx mínimo
const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Evaluación: trabajo final grupal 40%, participación 20%.</w:t></w:r></w:p></w:body></w:document>');
const docx = await zip.generateAsync({ type: 'nodebuffer' });
// .doc viejo: texto UTF-16 entre bytes binarios
const docBin = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3, 0xff, 0xfe]), Buffer.from('Programa de Marketing. Evaluación: examen final 50% y caso grupal 50%.', 'utf16le'), Buffer.from([0, 0, 0xff, 0x01, 0x02])]);

try {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/test-files/prog.docx', (r) => r.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: docx }));
  await page.route('**/test-files/prog.doc', (r) => r.fulfill({ status: 200, contentType: 'application/msword', body: docBin }));
  await page.goto(`${base}/#/hoy`);
  await page.waitForTimeout(800);
  const res = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const programs = await import('/js/programs.js');
    await db.put('notebooks', { id: 'nb_a', name: 'Dirección de Operaciones [G. Vulcano]', courseId: 1, schedule: [], sections: [], createdAt: 1 });
    await db.put('notebooks', { id: 'nb_b', name: 'Dirección de Marketing [C. Del Hoyo]', courseId: 2, schedule: [], sections: [], createdAt: 1 });
    await db.put('notebooks', { id: 'nb_old', name: 'Economía Empresarial [M. Celani]', courseId: 3, schedule: [], sections: [], createdAt: 1 });
    const soon = Date.now() + 5 * 86400000;
    await db.setSetting('campusEvents', [
      { id: 'e1', title: 'Dirección de Operaciones - Prof. Vulcano', start: soon, end: soon + 3600000, courseId: 99, kind: 'evento', source: 'campus' },
      { id: 'e2', title: 'Dirección de Marketing - Prof. Del Hoyo', start: soon, end: soon + 3600000, courseId: 99, kind: 'evento', source: 'campus' },
    ]);
    const f = (id, nb, name, srcUrl, module) => db.put('files', { id, notebookId: nb, name, module, srcUrl, size: 1000, modified: 5, local: false, seen: true, addedAt: 1 }, { remote: true });
    await f('p_pdf', 'nb_a', 'Programa Operaciones.pdf', '/exams/simulacro-dop-2026-10-5.pdf', 'Programa de la Materia');
    await f('p_docx', 'nb_b', 'Consignas TP.docx', '/test-files/prog.docx', 'Trabajo final');
    await f('p_doc', 'nb_b', 'Programa MARKETING.doc', '/test-files/prog.doc', 'Programa de la Materia');
    await f('p_old', 'nb_old', 'Programa Economía.pdf', '/exams/simulacro-dop-2026-10-5.pdf', 'Programa');
    await f('p_other', 'nb_a', 'Clase 1 - slides.pdf', '/exams/simulacro-dop-2026-10-5.pdf', 'Clase 1');
    const done = await programs.extractKeyDocs();
    const get = async (id) => { const row = await db.get('kv', `programText:${id}`); return row ? { text: row.value.text, mod: row._mod, err: row.value.error } : null; };
    return { done, pdf: await get('p_pdf'), docx: await get('p_docx'), doc: await get('p_doc'), old: await get('p_old'), other: await get('p_other'), again: await programs.extractKeyDocs() };
  });
  if (!/DIRECCI[ÓO]N DE OPERACIONES/i.test(res.pdf?.text || '') || !res.pdf.mod) throw new Error(`PDF: ${JSON.stringify(res.pdf)?.slice(0, 200)}`);
  step('PDF del programa: texto extraído y marcado para sincronizar');
  if (!/trabajo final grupal 40%/.test(res.docx?.text || '')) throw new Error(`DOCX: ${JSON.stringify(res.docx)}`);
  step('Consigna en Word (.docx): texto extraído');
  if (!/Evaluación: examen final 50% y caso grupal 50%/.test(res.doc?.text || '')) throw new Error(`DOC: ${JSON.stringify(res.doc)}`);
  step('Programa en Word viejo (.doc): texto rescatado');
  if (res.old || res.other) throw new Error(`Procesó de más: ${JSON.stringify({ old: !!res.old, other: !!res.other })}`);
  step('Solo procesa documentos clave de materias en curso (no slides ni materias pasadas)');
  if (res.again.length) throw new Error(`Reprocesó: ${res.again}`);
  step('No vuelve a procesar si el archivo no cambió');
  const synced = await page.evaluate(async () => (await import('/js/db.js')).isSyncedKey('programText:x'));
  if (!synced) throw new Error('programText no se sincroniza');
  step('Las claves programText:* se sincronizan entre dispositivos');
  if (errors.length) throw new Error(`Errores:\n${errors.join('\n')}`);
  console.log('\nTodo OK');
} catch (err) {
  console.error('✗', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  app.close();
}
