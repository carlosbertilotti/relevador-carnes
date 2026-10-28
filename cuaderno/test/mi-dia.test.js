// El mensaje de "Mi día" para Telegram: qué entra en cada sección, el orden, lo atrasado,
// el adelanto de mañana y el corte en mensajes de 4096 caracteres.
//   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, chunk, plusDays, ymd } from '../scripts/mi-dia-telegram.mjs';

const t = (id, v) => ({ id: `todo:${id}`, data: { value: { id, done: false, ...v } } });
const DAY = '2026-10-29';
// 12:00 y 19:00 de Buenos Aires del 29/10 (UTC-3)
const ms = (h) => Date.parse(`${DAY}T${String(h).padStart(2, '0')}:00:00-03:00`);
const raw = {
  notebooks: [
    { id: 'nb_fin', data: { name: 'Finanzas Corporativas [M. Machinea]', color: '#9b6cd6' } },
    { id: 'nb_mkt', data: { name: 'Dirección de Marketing [C. Del Hoyo]', color: '#c2410c' } },
  ],
  todos: [
    t('r1', { due: DAY, read: true, title: 'Pre-read de medios', notebookId: 'nb_mkt', minutes: 30, order: 2 }),
    t('r2', { due: DAY, read: true, title: 'BMA cap. 17 <y 18>', notebookId: 'nb_fin', minutes: 60, order: 1 }),
    t('a1', { due: DAY, title: '15:00 · Comunicación S3', notebookId: null, order: 3 }),
    t('a0', { due: DAY, title: 'Entregar el Quiz', notebookId: 'nb_fin', order: 0, done: true }),
    t('l1', { due: '2026-10-12', title: 'Guía U1', notebookId: 'nb_fin' }),
    t('l2', { due: '2026-10-20', read: true, title: 'Slides de la clase 2', notebookId: 'nb_fin' }),
    t('m1', { due: '2026-10-30', title: '09:00 · Finanzas C3', notebookId: 'nb_fin', order: 1 }),
    t('m2', { due: '2026-10-30', read: true, title: 'Leer para la clase 4', notebookId: 'nb_fin', order: 2 }),
    t('x1', { due: '2026-11-03', title: 'Ayudantía 2', notebookId: 'nb_fin' }),
    { id: 'todo:roto', data: { value: 'no es un objeto' } },
  ],
  events: { value: [
    { id: 'e1', start: ms(12), end: ms(14), title: 'Leadership Lab - Coaching 3', kind: 'evento' },
    { id: 'e2', start: Date.parse('2026-10-30T19:00:00-03:00'), end: Date.parse('2026-10-30T21:00:00-03:00'), title: 'Ayudantía 2 Online | Finanzas', kind: 'evento' },
    { id: 'e3', start: Date.parse('2026-10-31T09:00:00-03:00'), end: Date.parse('2026-10-31T10:00:00-03:00'), title: 'No es de hoy ni de mañana', kind: 'evento' },
  ] },
};

test('arma las secciones del día en orden y con la materia', () => {
  const msg = buildMessage(raw, DAY);
  assert.match(msg, /^📒 <b>Jueves 29 de octubre<\/b>/);
  const i = (s) => { const k = msg.indexOf(s); assert.ok(k >= 0, `falta "${s}"`); return k; };
  assert.ok(i('🎓 <b>Campus</b>') < i('📖 <b>Para leer</b> <i>(1 h 30 min)</i>'));
  assert.ok(i('📖 <b>Para leer</b> <i>(1 h 30 min)</i>') < i('✅ <b>Para hacer</b>'));
  assert.ok(i('✅ <b>Para hacer</b>') < i('⏰ <b>Atrasadas (2)</b>'));
  assert.ok(i('⏰ <b>Atrasadas (2)</b>') < i('➡️ <b>Mañana, vie 30/10</b>'));
  // por "order": BMA antes que el pre-read; el título se escapa para HTML
  assert.ok(i('📖 BMA cap. 17 &lt;y 18&gt; — <i>Finanzas Corporativas · 1 h</i>') < i('📖 Pre-read de medios — <i>Dirección de Marketing · 30 min</i>'));
  assert.match(msg, /• 15:00 · Comunicación S3\n/);
  assert.doesNotMatch(msg, /Entregar el Quiz/, 'las hechas no van');
  assert.match(msg, /• 12:00 · Leadership Lab - Coaching 3/);
  assert.match(msg, /• Guía U1 — <i>Finanzas Corporativas · lun 12\/10<\/i>\n• 📖 Slides de la clase 2 — <i>Finanzas Corporativas · mar 20\/10<\/i>/);
  assert.match(msg, /➡️ <b>Mañana, vie 30\/10<\/b>\n• 19:00 · Ayudantía 2 Online \| Finanzas\n• 09:00 · Finanzas C3 — <i>Finanzas Corporativas<\/i>\n• 📖 Leer para la clase 4/);
  assert.doesNotMatch(msg, /Ayudantía 2 — |No es de hoy/, 'lo de pasado mañana no entra');
});

test('un día sin nada lo dice, y las atrasadas de más se resumen', () => {
  const msg = buildMessage({ notebooks: [], todos: [], events: { value: [] } }, '2026-10-25');
  assert.match(msg, /Nada pendiente para hoy/);
  assert.doesNotMatch(msg, /Atrasadas|Mañana/);
  const many = { notebooks: [], events: { value: [] }, todos: Array.from({ length: 8 }, (_, k) => t(`l${k}`, { due: `2026-10-${10 + k}`, title: `Vieja ${k}` })) };
  const m2 = buildMessage(many, DAY);
  assert.match(m2, /⏰ <b>Atrasadas \(8\)<\/b>/);
  assert.match(m2, /Vieja 4/);
  assert.doesNotMatch(m2, /Vieja 5/);
  assert.match(m2, /… y 3 más en Tareas/);
});

test('fechas: el día es el de Buenos Aires y mañana cruza el mes', () => {
  assert.equal(ymd(Date.parse('2026-10-29T01:30:00Z')), '2026-10-28'); // todavía es 28 a las 22:30 en Buenos Aires
  assert.equal(ymd(Date.parse('2026-10-29T03:30:00Z')), '2026-10-29');
  assert.equal(plusDays('2026-10-31', 1), '2026-11-01');
  assert.match(buildMessage({ notebooks: [], todos: [t('z', { due: '2026-11-01', title: 'Apuntes' })], events: null }, '2026-10-31'), /Mañana, dom 1\/11/);
});

test('corta en mensajes de menos de 4096 caracteres sin partir líneas', () => {
  const lines = Array.from({ length: 300 }, (_, k) => `• línea número ${k} con bastante texto para ocupar lugar`);
  const parts = chunk(lines.join('\n'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.deepEqual(parts.join('\n').split('\n'), lines);
  assert.deepEqual(chunk('corto'), ['corto']);
});
