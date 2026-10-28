// En qué está cada materia según el calendario del campus: "cursando", "pasada" o "proxima".
// Las clases mandan: si hay o hubo clases estos días (o queda un examen pegado al final de la
// cursada), se está cursando; si todas fueron hace más de unos días, es pasada; si todas son
// futuras, próxima. Sin clases, cuentan los demás eventos (entregas, encuentros). Sin nada en el
// calendario no se decide (queda lo que dice el campus), salvo una materia del campus sin fecha de
// fin que empezó hace meses: esa ya pasó (el campus las da a todas por "en curso").
const DAY = 86400000;
export const AFTER_CLASSES = 30 * DAY; // un examen o entrega hasta 30 días después de la última clase sigue siendo de la cursada
export const SOON = 7 * DAY;           // empieza en menos de una semana: ya se cuenta como cursando
export const GRACE = 2 * DAY;          // terminó hace menos de dos días: todavía cursando
export const NEAR = 30 * DAY;          // sin clases: un evento a menos de un mes la deja en curso
export const STALE = 120 * DAY;        // sin eventos ni fecha de fin: empezó hace más de 4 meses → pasada

export function statusesFromCalendar(notebooks, events, classify, now = Date.now()) {
  const out = new Map();
  if (!events?.length) return out; // sin calendario no se toca nada
  const byNb = new Map();
  for (const ev of events) {
    if (!ev || !Number.isFinite(ev.start)) continue;
    const e = classify(ev, notebooks);
    if (!e.notebookId) continue;
    if (!byNb.has(e.notebookId)) byNb.set(e.notebookId, { classes: [], others: [] });
    byNb.get(e.notebookId)[e.kind === 'clase' ? 'classes' : 'others'].push(ev.start);
  }
  for (const nb of notebooks) {
    const a = byNb.get(nb.id);
    let st = null;
    if (a?.classes.length) {
      const c = [...a.classes].sort((x, y) => x - y);
      const first = c[0];
      const last = c[c.length - 1];
      let end = last;
      for (const o of a.others) if (o > last && o <= last + AFTER_CLASSES) end = Math.max(end, o);
      st = first > now + SOON ? 'proxima' : end >= now - GRACE ? 'cursando' : 'pasada';
    } else if (a?.others.length) {
      const o = [...a.others].sort((x, y) => x - y);
      st = o.some((t) => Math.abs(t - now) <= NEAR) ? 'cursando' : o[0] > now ? 'proxima' : 'pasada';
    } else if (nb.courseId != null && !nb.enddate && nb.startdate && nb.startdate < now - STALE && !nb.schedule?.length) {
      st = 'pasada';
    }
    if (st) out.set(nb.id, st);
  }
  return out;
}
