import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionKey, findSection, programExcerpt, filesMentioned, pickProgram, numberSessions, parseDayMonth } from '../web/js/lib/plan.js';

test('sectionKey entiende cómo nombra las clases el campus', () => {
  assert.deepEqual(sectionKey('Clase 3 | Competencias y ventaja competitiva'), { n: 3 });
  assert.deepEqual(sectionKey('SESIÓN 2 | Escucha activa'), { n: 2 });
  assert.deepEqual(sectionKey('Clase 1: 5 de Junio - Ariel Castiglioni'), { n: 1, day: 5, month: 6 });
  assert.deepEqual(sectionKey('🔵 Segundo fin de semana'), { weekend: 2 });
  assert.deepEqual(sectionKey('Clase 2 | Testing y AB testing'), { n: 2 });
  assert.deepEqual(sectionKey('Grabaciones de las clases'), {});
  assert.deepEqual(parseDayMonth('Ayudantía 14/8'), { day: 14, month: 8 });
});

test('findSection: por fecha, por número o por fin de semana', () => {
  const sections = [{ name: 'Programa' }, { name: 'Clase 1: 5 de Junio' }, { name: 'Clase 2: 6 de Junio' }, { name: 'Clase 3 | Algo' }, { name: 'Segundo fin de semana' }];
  assert.equal(findSection(sections, { n: 9, date: new Date(2026, 5, 6) }).name, 'Clase 2: 6 de Junio');
  assert.equal(findSection(sections, { n: 3, date: new Date(2026, 8, 1) }).name, 'Clase 3 | Algo');
  assert.equal(findSection(sections, { n: 7, weekend: 2 }).name, 'Segundo fin de semana');
  assert.equal(findSection(sections, { n: 8 }), null);
});

const PROGRAMA = `PROGRAMA
Contenido
Clase 1 Introducción ............ 3
Clase 2 Estrategia .............. 4

Cronograma de clases
Clase 1 (8/10): Introducción a las finanzas corporativas.
Lecturas: Brealey, Myers & Allen, Capítulo 1. Caso: Marriott Corporation.

Clase 2 (9/10): Valuación de proyectos y flujo de fondos.
Lecturas obligatorias: Koller – Valuation, cap. 5 y 6.
Trabajo práctico 1 (entregar antes de la clase 3).

Clase 3 (10 de octubre): Costo de capital.
Lectura: "The cost of capital" (Harvard Note).
`;

test('programExcerpt toma la parte de esa clase (por fecha o por número)', () => {
  const byDate = programExcerpt(PROGRAMA, { n: 99, date: new Date(2026, 9, 9) });
  assert.match(byDate, /^Clase 2 \(9\/10\)/);
  assert.match(byDate, /Koller/);
  assert.doesNotMatch(byDate, /Costo de capital/);
  const byN = programExcerpt(PROGRAMA, { n: 1 });
  assert.match(byN, /Marriott/);
  assert.doesNotMatch(byN, /Koller/);
  const longDate = programExcerpt(PROGRAMA, { n: 3, date: new Date(2026, 9, 10) });
  assert.match(longDate, /Harvard Note/);
  assert.equal(programExcerpt(PROGRAMA, { n: 12 }), null);
});

test('filesMentioned encuentra los PDFs que nombra el programa', () => {
  const files = [
    { name: 'Marriott Corporation - Case.pdf' },
    { name: 'Koller Valuation cap 5-6.pdf' },
    { name: 'Clase 4 - slides.pdf' },
    { name: 'Brealey Myers Allen - Capitulo 1.pdf' },
  ];
  const ex = programExcerpt(PROGRAMA, { n: 1 });
  assert.deepEqual(filesMentioned(ex, files).map((f) => f.name).sort(), ['Brealey Myers Allen - Capitulo 1.pdf', 'Marriott Corporation - Case.pdf']);
});

test('pickProgram prefiere el cronograma; numberSessions numera por fecha y fin de semana', () => {
  assert.equal(pickProgram([{ name: 'Programa X.pdf' }, { name: 'Cronograma X.pdf' }, { name: 'otra.pdf' }]).name, 'Cronograma X.pdf');
  const evs = [new Date(2026, 9, 10, 9), new Date(2026, 9, 8, 15), new Date(2026, 9, 9, 9), new Date(2026, 9, 29, 15)].map((d) => ({ start: d.getTime() }));
  const s = numberSessions(evs);
  assert.deepEqual(s.map((x) => [new Date(x.ev.start).getDate(), x.n, x.weekend]), [[8, 1, 1], [9, 2, 1], [10, 3, 1], [29, 4, 2]]);
});
