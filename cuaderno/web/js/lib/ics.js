// Parser iCal (RFC 5545) chico, pensado para calendarios de clases:
// soporta eventos simples, de día completo y recurrentes semanales/diarios
// (RRULE con FREQ, INTERVAL, BYDAY, UNTIL, COUNT) y EXDATE.
// Los horarios con TZID se interpretan como hora local del dispositivo.

const DAY = 86400000;
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescape(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

export function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const allDay = params.VALUE === 'DATE' || h === undefined;
  if (allDay) return { time: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { time: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false };
  return { time: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime(), allDay: false };
}

function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...rawParams] = head.split(';');
  const params = {};
  for (const p of rawParams) {
    const [k, v] = p.split('=');
    if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

export function parseICS(text) {
  const events = [];
  let cur = null;
  let depth = 0;
  for (const line of unfold(text).split('\n')) {
    const l = parseLine(line.trimEnd());
    if (!l) continue;
    if (l.name === 'BEGIN') {
      if (l.value === 'VEVENT') cur = { exdates: [] };
      else if (cur) depth++;
      continue;
    }
    if (l.name === 'END') {
      if (l.value === 'VEVENT' && cur) {
        if (cur.start) events.push(cur);
        cur = null;
      } else if (cur && depth) depth--;
      continue;
    }
    if (!cur || depth) continue;
    switch (l.name) {
      case 'UID': cur.uid = l.value; break;
      case 'SUMMARY': cur.title = unescape(l.value); break;
      case 'DESCRIPTION': cur.description = unescape(l.value); break;
      case 'LOCATION': cur.location = unescape(l.value); break;
      case 'DTSTART': { const d = parseDate(l.value, l.params); if (d) { cur.start = d.time; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(l.value, l.params); if (d) cur.end = d.time; break; }
      case 'DURATION': cur.duration = parseDuration(l.value); break;
      case 'RRULE': cur.rrule = parseRRule(l.value); break;
      case 'EXDATE':
        for (const v of l.value.split(',')) {
          const d = parseDate(v, l.params);
          if (d) cur.exdates.push(d.time);
        }
        break;
      case 'RECURRENCE-ID': { const d = parseDate(l.value, l.params); if (d) cur.recurrenceId = d.time; break; }
      case 'STATUS': cur.status = l.value; break;
      default: break;
    }
  }
  for (const e of events) {
    if (e.end == null) e.end = e.start + (e.duration ?? (e.allDay ? DAY : 0));
  }
  return events;
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function parseRRule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    r[k.toUpperCase()] = val;
  }
  return {
    freq: r.FREQ,
    interval: Math.max(1, +(r.INTERVAL || 1)),
    until: r.UNTIL ? parseDate(r.UNTIL)?.time ?? null : null,
    count: r.COUNT ? +r.COUNT : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((d) => BYDAY[d.slice(-2)]).filter((d) => d !== undefined) : null,
  };
}

// Expande eventos (incluidos los recurrentes) dentro de [from, to).
export function expandEvents(events, from, to) {
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId != null) overrides.set(`${e.uid}|${e.recurrenceId}`, e);

  const out = [];
  const push = (e, start) => {
    const dur = e.end - e.start;
    if (start + dur <= from || start >= to) return;
    if (e.status === 'CANCELLED') return;
    out.push({
      id: `${e.uid || e.title}|${start}`,
      title: e.title || '(sin título)',
      description: e.description || '',
      location: e.location || '',
      start,
      end: start + dur,
      allDay: !!e.allDay,
    });
  };

  for (const e of events) {
    if (e.recurrenceId != null) { push(e, e.start); continue; }
    if (!e.rrule) { push(e, e.start); continue; }
    const { freq, interval, until, count, byday } = e.rrule;
    const ex = new Set(e.exdates);
    const limit = Math.min(to, until != null ? until + 1 : Infinity);
    let n = 0;
    const emit = (t) => {
      n++;
      if (ex.has(t)) return;
      const ov = overrides.get(`${e.uid}|${t}`);
      if (ov) return; // la instancia modificada se agrega por su cuenta
      push(e, t);
    };
    const base = new Date(e.start);
    if (freq === 'WEEKLY') {
      const days = byday && byday.length ? byday : [base.getDay()];
      const weekStart = new Date(base);
      weekStart.setDate(base.getDate() - base.getDay());
      for (let w = 0; ; w += interval) {
        let stop = false;
        for (const d of [...days].sort()) {
          const t = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + w * 7 + d,
            base.getHours(), base.getMinutes(), base.getSeconds()).getTime();
          if (t < e.start) continue;
          if (t >= limit || (count != null && n >= count)) { stop = true; break; }
          emit(t);
        }
        if (stop || w > 2000) break;
      }
    } else if (freq === 'DAILY' || freq === 'MONTHLY' || freq === 'YEARLY') {
      for (let i = 0; i < 5000; i += interval) {
        const t = new Date(base.getFullYear() + (freq === 'YEARLY' ? i : 0), base.getMonth() + (freq === 'MONTHLY' ? i : 0),
          base.getDate() + (freq === 'DAILY' ? i : 0), base.getHours(), base.getMinutes(), base.getSeconds()).getTime();
        if (t >= limit || (count != null && n >= count)) break;
        if (freq === 'DAILY' && byday && !byday.includes(new Date(t).getDay())) continue;
        emit(t);
      }
    } else {
      push(e, e.start);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
