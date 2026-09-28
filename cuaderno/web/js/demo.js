// Datos de ejemplo para probar la app sin conectar el campus: abrir con ?demo
import * as db from './db.js';
import * as store from './store.js';

export async function seedDemo() {
  if ((await store.listNotebooks()).length) return;
  const micro = await store.createNotebook({
    name: 'Microeconomía I',
    shortname: 'ECO101',
    schedule: [{ day: 1, start: '10:00', end: '11:30', room: 'Aula 204' }, { day: 3, start: '10:00', end: '11:30', room: 'Aula 204' }],
  });
  const stats = await store.createNotebook({
    name: 'Estadística',
    shortname: 'MAT210',
    schedule: [{ day: 2, start: '14:00', end: '15:30', room: 'Aula Magna' }, { day: 4, start: '14:00', end: '15:30', room: 'Aula Magna' }],
  });
  await store.createNotebook({
    name: 'Historia Argentina',
    schedule: [{ day: 5, start: '08:30', end: '10:00', room: 'Aula 12' }],
  });
  const note = await store.createNote(micro.id, {
    title: 'Microeconomía I — Elasticidades',
    blocks: [store.newTextBlock(
      '<h1>Elasticidades</h1><p>La <b>elasticidad precio de la demanda</b> mide cuánto cambia la cantidad demandada ante un cambio del precio.</p>'
      + '<h2>Fórmula</h2><pre>ε = (ΔQ/Q) / (ΔP/P)</pre>'
      + '<ul class="checklist"><li data-checked="">Leer cap. 5 del Varian</li><li>Hacer la guía 3</li></ul>'
      + '<ul><li>|ε| &gt; 1 → elástica</li><li>|ε| &lt; 1 → inelástica</li></ul>',
    ), store.newInkBlock({ paper: 'grid' })],
  });
  note.pinned = true;
  await store.saveNote(note);
  await store.createNote(stats.id, {
    title: 'Estadística — Distribución normal',
    classDate: store.ymd(Date.now() - 2 * 86400000),
    blocks: [store.newTextBlock('<h2>Distribución normal</h2><p>Simétrica, media = mediana = moda. 68–95–99,7.</p>'), store.newInkBlock({ paper: 'cornell' })],
  });
  const now = Date.now();
  await db.setSetting('campusEvents', [
    { id: 'demo-1', title: 'Entrega TP 2 — Microeconomía', start: now + 3 * 86400000, end: now + 3 * 86400000, kind: 'entrega', source: 'campus', courseId: null },
    { id: 'demo-2', title: 'Parcial de Estadística', start: now + 8 * 86400000, end: now + 8 * 86400000 + 7200000, kind: 'entrega', source: 'campus', courseId: null },
  ]);
}
