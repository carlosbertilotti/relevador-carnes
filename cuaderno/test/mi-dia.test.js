// "Mi día" para Telegram: la agenda (campus y tareas con hora, sin repetir), qué entra en cada
// sección, lo atrasado, el adelanto de mañana, el texto de respaldo y la imagen (HTML).
//   npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDay, buildMessage, buildCaption, buildHtml, splitTime, chunk, plusDays, ymd, pngSize } from '../scripts/mi-dia-telegram.mjs';

const t = (id, v) => ({ id: `todo:${id}`, data: { value: { id, done: false, ...v } } });
const DAY = '2026-10-29';
const at = (day, h, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
const raw = {
  notebooks: [
    { id: 'nb_fin', data: { name: 'Finanzas Corporativas [M. Machinea]', color: '#9b6cd6' } },
    { id: 'nb_mkt', data: { name: 'Dirección de Marketing [C. Del Hoyo]', color: '#c2410c' } },
    { id: 'nb_com', data: { name: 'Comunicación Efectiva [L. Peverengo]', color: '#0f766e' } },
  ],
  todos: [
    t('a1', { due: DAY, title: '15:00 · Comunicación S3: llevar la presentación de 1 minuto', notebookId: 'nb_com', order: 3 }),
    t('a2', { due: DAY, title: 'Antes de las 15:00 · Repasar la presentación', notebookId: 'nb_com', order: 2 }),
    t('a3', { due: DAY, title: '12:00 a 14:30 · Leadership Lab: Coaching Grupal 3', order: 1, minutes: 150 }),
    t('q', { due: DAY, title: '12:00 · Entregar el Quiz #1 de Finanzas', notebookId: 'nb_fin', done: true }),
    t('r1', { due: DAY, read: true, title: 'Pre-read de medios', notebookId: 'nb_mkt', minutes: 30, order: 5 }),
    t('r2', { due: DAY, read: true, title: 'BMA cap. 17 <y 18>', notebookId: 'nb_fin', minutes: 60, order: 4 }),
    t('p1', { due: DAY, title: 'Escribirle al grupo del TP', notebookId: 'nb_mkt', order: 6 }),
    t('l1', { due: '2026-10-12', title: 'Guía U1', notebookId: 'nb_fin' }),
    t('m1', { due: '2026-10-30', title: '09:00 · Finanzas C3', notebookId: 'nb_fin', order: 1 }),
    t('m2', { due: '2026-10-30', read: true, title: 'Leer para la clase 4', notebookId: 'nb_fin', order: 2 }),
    t('x1', { due: '2026-11-03', title: 'Ayudantía 2', notebookId: 'nb_fin' }),
    { id: 'todo:roto', data: { value: 'no es un objeto' } },
  ],
  events: { value: [
    { id: 'e1', start: at(DAY, 12), end: at(DAY, 14, 30), title: 'Leadership Lab - Coaching Grupal 3 + El otro en el centro' },
    { id: 'e2', start: at(DAY, 12), end: at(DAY, 12), title: 'Vencimiento de Quiz #1 - Entrega jueves 29/10, 12h' },
    { id: 'e3', start: at(DAY, 15), end: at(DAY, 18, 15), title: 'Comunicación Efectiva - Prof. Lacombe' },
    { id: 'e4', start: at(DAY, 18, 30), end: at(DAY, 21, 45), title: 'Dirección de Marketing - Prof. Del Hoyo' },
    { id: 'e5', start: at('2026-10-30', 9), end: at('2026-10-30', 13), title: 'Finanzas Corporativas - Prof. Machinea' },
    { id: 'e6', start: at('2026-10-31', 8, 30), end: at('2026-10-31', 12), title: 'No es de hoy ni de mañana' },
  ] },
};

test('la hora al principio del título se separa', () => {
  assert.deepEqual(splitTime('12:00 a 14:30 · Leadership Lab'), { time: '12:00 a 14:30', text: 'Leadership Lab' });
  assert.deepEqual(splitTime('Antes de las 15:00 · Repasar'), { time: 'Antes de las 15:00', text: 'Repasar' });
  assert.deepEqual(splitTime('9:00 · Algo'), { time: '9:00', text: 'Algo' });
  assert.deepEqual(splitTime('Leer el BMA'), { time: null, text: 'Leer el BMA' });
});

test('la agenda junta campus y tareas con hora, en orden y sin repetir', () => {
  const d = buildDay(raw, DAY);
  assert.deepEqual(d.agenda.map((a) => `${a.time} ${a.text}`), [
    '12:00 a 14:30 Leadership Lab: Coaching Grupal 3', // la tarea reemplaza al evento del campus (misma hora y palabras)
    'Antes de las 15:00 Repasar la presentación',
    '15:00 Comunicación S3: llevar la presentación de 1 minuto',
    '18:30 Dirección de Marketing - Prof. Del Hoyo',
  ]);
  assert.ok(!d.agenda.some((a) => /Quiz/.test(a.text)), 'el vencimiento del quiz ya hecho no aparece (la tarea hecha lo cubre)');
  assert.deepEqual(d.reads.map((r) => r.text), ['BMA cap. 17 <y 18>', 'Pre-read de medios']);
  assert.equal(d.readMinutes, 90);
  assert.deepEqual(d.tasks.map((r) => r.text), ['Escribirle al grupo del TP']);
  assert.deepEqual(d.late.map((r) => r.text), ['Guía U1']);
  assert.deepEqual(d.tomorrow.agenda.map((a) => `${a.time} ${a.text}`), ['09:00 Finanzas C3']);
  assert.deepEqual(d.tomorrow.items.map((a) => a.text), ['Leer para la clase 4']);
});

test('el texto de respaldo y el epígrafe de la imagen', () => {
  const msg = buildMessage(raw, DAY);
  assert.match(msg, /^📒 <b>Jueves 29 de octubre<\/b>/);
  const i = (s) => { const k = msg.indexOf(s); assert.ok(k >= 0, `falta "${s}"`); return k; };
  assert.ok(i('🗓 <b>Agenda</b>') < i('📖 <b>Para leer</b> <i>(1 h 30 min)</i>'));
  assert.ok(i('📖 <b>Para leer</b>') < i('✅ <b>Para hacer</b>'));
  assert.ok(i('✅ <b>Para hacer</b>') < i('⏰ <b>Atrasadas (1)</b>'));
  assert.ok(i('⏰ <b>Atrasadas (1)</b>') < i('➡️ <b>Mañana, vie 30/10</b>'));
  assert.match(msg, /• 📖 BMA cap\. 17 &lt;y 18&gt; — <i>Finanzas Corporativas · 1 h<\/i>/);
  assert.match(msg, /• Guía U1 — <i>Finanzas Corporativas · lun 12\/10<\/i>/);
  assert.doesNotMatch(msg, /Ayudantía 2|No es de hoy/);
  assert.equal(buildCaption(raw, DAY), '📒 <b>Jueves 29 de octubre</b> · 4 en agenda · 2 para leer · 1 para hacer · 1 atrasada');
  assert.match(buildCaption({ notebooks: [], todos: [], events: null }, DAY), /nada pendiente/);
});

test('la imagen: secciones, colores de la materia y todo escapado', () => {
  const html = buildHtml(raw, DAY);
  for (const s of ['Jueves 29 de octubre', '>Agenda<', '>Para leer<', '>Para hacer<', 'Atrasadas · 1', 'Mañana, vie 30/10', '1 h 30 min']) assert.ok(html.includes(s), `falta "${s}"`);
  assert.ok(html.includes('BMA cap. 17 &lt;y 18&gt;') && !html.includes('<y 18>'));
  assert.ok(html.includes('--c:#9b6cd6'), 'color de Finanzas');
  assert.ok(html.includes('class="tag">LEER<'));
  const empty = buildHtml({ notebooks: [], todos: [], events: null }, '2026-10-25');
  assert.match(empty, /Nada pendiente para hoy/);
  assert.doesNotMatch(empty, /Atrasadas|Mañana,/);
});

test('fechas: el día es el de Buenos Aires y mañana cruza el mes', () => {
  assert.equal(ymd(Date.parse('2026-10-29T01:30:00Z')), '2026-10-28');
  assert.equal(ymd(Date.parse('2026-10-29T03:30:00Z')), '2026-10-29');
  assert.equal(plusDays('2026-10-31', 1), '2026-11-01');
  assert.match(buildMessage({ notebooks: [], todos: [t('z', { due: '2026-11-01', title: 'Apuntes' })], events: null }, '2026-10-31'), /Mañana, dom 1\/11/);
});

test('las atrasadas de más se resumen', () => {
  const many = { notebooks: [], events: null, todos: Array.from({ length: 8 }, (_, k) => t(`l${k}`, { due: `2026-10-${10 + k}`, title: `Vieja ${k}` })) };
  const m = buildMessage(many, DAY);
  assert.match(m, /⏰ <b>Atrasadas \(8\)<\/b>/);
  assert.match(m, /Vieja 4/);
  assert.doesNotMatch(m, /Vieja 5/);
  assert.match(m, /… y 3 más en Tareas/);
});

test('corta en mensajes de menos de 4096 caracteres y lee el tamaño del PNG', () => {
  const lines = Array.from({ length: 300 }, (_, k) => `• línea número ${k} con bastante texto para ocupar lugar`);
  const parts = chunk(lines.join('\n'));
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4000));
  assert.deepEqual(parts.join('\n').split('\n'), lines);
  const png = Buffer.alloc(24); png.writeUInt32BE(1440, 16); png.writeUInt32BE(2200, 20);
  assert.deepEqual(pngSize(png), { width: 1440, height: 2200 });
});
