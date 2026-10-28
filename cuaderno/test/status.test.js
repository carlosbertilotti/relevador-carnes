// Cursando, pasada o próxima según el calendario del campus.
//   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusesFromCalendar } from '../web/js/lib/status.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-28T12:00:00-03:00');
const d = (n) => NOW + n * DAY;
// Clasificador de prueba: el evento ya trae su materia y si es clase.
const classify = (ev) => ({ ...ev, notebookId: ev.nb, kind: ev.clase ? 'clase' : 'evento' });
const clases = (nb, ...days) => days.map((n) => ({ nb, clase: true, start: d(n), title: 'clase' }));
const otro = (nb, n) => ({ nb, start: d(n), title: 'entrega o examen' });

test('el bloque actual se está cursando; lo de antes pasó y lo de después viene', () => {
  const nbs = [{ id: 'fin' }, { id: 'mkt' }, { id: 'conta' }, { id: 'futura' }];
  const events = [
    ...clases('fin', -20, -19, 1, 2, 16, 17), otro('fin', 37), // examen 20 días después de la última clase
    ...clases('mkt', -20, 3),
    ...clases('conta', -200, -120, -102), otro('conta', 15), otro('conta', 23), // llamados meses después: no la reviven
    ...clases('futura', 40, 41),
  ];
  const st = statusesFromCalendar(nbs, events, classify, NOW);
  assert.deepEqual(Object.fromEntries(st), { fin: 'cursando', mkt: 'cursando', conta: 'pasada', futura: 'proxima' });
});

test('después de la última clase sigue en curso si queda el examen; después, pasada', () => {
  const nbs = [{ id: 'fin' }];
  const events = [...clases('fin', -30, -16), otro('fin', 5)];
  assert.equal(statusesFromCalendar(nbs, events, classify, NOW).get('fin'), 'cursando');
  assert.equal(statusesFromCalendar(nbs, events, classify, d(4)).get('fin'), 'cursando');
  assert.equal(statusesFromCalendar(nbs, events, classify, d(8)).get('fin'), 'pasada');
  // terminó anteayer: todavía cursando (margen de dos días); hace tres, pasada
  assert.equal(statusesFromCalendar(nbs, clases('fin', -40, -1), classify, NOW).get('fin'), 'cursando');
  assert.equal(statusesFromCalendar(nbs, clases('fin', -40, -3), classify, NOW).get('fin'), 'pasada');
  // empieza en menos de una semana: ya se cuenta como cursando
  assert.equal(statusesFromCalendar(nbs, clases('fin', 5, 6), classify, NOW).get('fin'), 'cursando');
});

test('sin clases cuentan los otros eventos; sin nada, sólo las del campus viejas pasan', () => {
  const nbs = [
    { id: 'lab' },                                                     // encuentros sueltos
    { id: 'vieja' },                                                   // eventos de hace meses
    { id: 'intro', courseId: 1, startdate: d(-230) },                  // del campus, sin fecha de fin ni eventos
    { id: 'nueva', courseId: 2, startdate: d(-60) },                   // empezó hace poco
    { id: 'conFin', courseId: 3, startdate: d(-230), enddate: d(30) }, // tiene fecha de fin: decide el campus
    { id: 'aMano' },                                                   // creada a mano, sin datos
    { id: 'horario', courseId: 4, startdate: d(-230), schedule: [{ day: 1, start: '08:30' }] },
  ];
  const events = [otro('lab', -150), otro('lab', 1), otro('vieja', -200), otro('vieja', -90)];
  const st = statusesFromCalendar(nbs, events, classify, NOW);
  assert.deepEqual(Object.fromEntries(st), { lab: 'cursando', vieja: 'pasada', intro: 'pasada' });
});

test('sin calendario no se decide nada', () => {
  assert.equal(statusesFromCalendar([{ id: 'x', courseId: 1, startdate: d(-300) }], [], classify, NOW).size, 0);
  assert.equal(statusesFromCalendar([{ id: 'x' }], null, classify, NOW).size, 0);
  // eventos sin materia o sin fecha se ignoran
  const st = statusesFromCalendar([{ id: 'x' }], [{ nb: null, start: d(0) }, { nb: 'x', start: NaN }], classify, NOW);
  assert.equal(st.size, 0);
});
