import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, expandEvents } from '../web/js/lib/ics.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:America/Argentina/Buenos_Aires
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:-0300
TZOFFSETTO:-0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:micro@utdt
SUMMARY:Microeconomía I\\, teórica
LOCATION:Aula 204
DTSTART;TZID=America/Argentina/Buenos_Aires:20260803T100000
DTEND;TZID=America/Argentina/Buenos_Aires:20260803T113000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261130T235959Z
EXDATE;TZID=America/Argentina/Buenos_Aires:20260810T100000
END:VEVENT
BEGIN:VEVENT
UID:micro@utdt
RECURRENCE-ID;TZID=America/Argentina/Buenos_Aires:20260805T100000
SUMMARY:Microeconomía I (cambio de aula)
LOCATION:Aula Magna
DTSTART;TZID=America/Argentina/Buenos_Aires:20260805T120000
DTEND;TZID=America/Argentina/Buenos_Aires:20260805T133000
END:VEVENT
BEGIN:VEVENT
UID:parcial@utdt
SUMMARY:Parcial
DTSTART;VALUE=DATE:20260915
END:VEVENT
BEGIN:VEVENT
UID:count@x
SUMMARY:Taller
DTSTART:20260801T130000Z
DURATION:PT1H
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
END:VCALENDAR`;

const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

test('parsea eventos, escapes y duración', () => {
  const evs = parseICS(ICS);
  assert.equal(evs.length, 4);
  assert.equal(evs[0].title, 'Microeconomía I, teórica');
  assert.equal(evs[0].end - evs[0].start, 90 * 60000);
  assert.equal(evs[2].allDay, true);
  assert.equal(evs[3].end - evs[3].start, 3600000);
});

test('expande clases semanales con EXDATE y excepciones', () => {
  const out = expandEvents(parseICS(ICS), local(2026, 8, 1), local(2026, 8, 15));
  const micro = out.filter((e) => e.title.startsWith('Microeconomía'));
  // lun 3, mié 5 (movida a las 12), lun 10 (excluida), mié 12
  assert.deepEqual(micro.map((e) => [new Date(e.start).getDate(), new Date(e.start).getHours(), e.location]), [
    [3, 10, 'Aula 204'],
    [5, 12, 'Aula Magna'],
    [12, 10, 'Aula 204'],
  ]);
});

test('respeta UNTIL y COUNT', () => {
  const evs = parseICS(ICS);
  const dec = expandEvents(evs, local(2026, 12, 1), local(2026, 12, 31));
  assert.equal(dec.filter((e) => e.title.startsWith('Micro')).length, 0);
  const taller = expandEvents(evs, local(2026, 7, 1), local(2026, 9, 1)).filter((e) => e.title === 'Taller');
  assert.equal(taller.length, 3);
});

test('eventos de día completo', () => {
  const out = expandEvents(parseICS(ICS), local(2026, 9, 15), local(2026, 9, 16));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Parcial');
  assert.equal(out[0].allDay, true);
});
