// Qué toca en cada clase: se arma con las secciones del campus ("Clase 3 | …",
// "SESIÓN 2", "Clase 1: 5 de Junio", "Segundo fin de semana") y con el texto del
// programa de la materia (las partes que hablan de esa clase o de esa fecha).
// Sin dependencias del navegador, para poder probarlo solo.

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ORDINALS = [[/\b(primer[oa]?|1r[oa]?|1er[oa]?|1°|1º)\b/, 1], [/\b(segund[oa]|2d[oa]|2°|2º)\b/, 2], [/\b(tercer[oa]?|3r[oa]?|3er[oa]?|3°|3º)\b/, 3],
  [/\b(cuart[oa]|4t[oa]|4°|4º)\b/, 4], [/\b(quint[oa]|5t[oa]|5°|5º)\b/, 5], [/\b(sext[oa]|6t[oa]|6°|6º)\b/, 6], [/\b(septim[oa]|7°|7º)\b/, 7], [/\b(octav[oa]|8°|8º)\b/, 8]];
const SESSION_WORD = '(?:clase|sesion|session|semana|encuentro|modulo|unidad|class|meeting)';

// "Clase 3 | Competencias…" → { n: 3 }; "Primer fin de semana" → { weekend: 1 };
// "Clase 1: 5 de Junio" → { n: 1, day: 5, month: 6 }
export function sectionKey(name) {
  const t = norm(name);
  const out = {};
  const m = t.match(new RegExp(`(?:^|[^a-z])${SESSION_WORD}\\s*(?:n[°º.]?\\s*|nro\\.?\\s*|#\\s*)?0*(\\d{1,2})\\b`));
  if (m) out.n = Number(m[1]);
  if (/fin(es)? de semana/.test(t)) {
    for (const [re, k] of ORDINALS) if (re.test(t)) { out.weekend = k; break; }
  } else if (out.n == null && new RegExp(SESSION_WORD).test(t)) {
    for (const [re, k] of ORDINALS) if (re.test(t)) { out.n = k; break; }
  }
  const d = parseDayMonth(t);
  if (d) Object.assign(out, d);
  return out;
}

// Primera fecha "5 de junio" o "5/6" que aparezca en el texto.
export function parseDayMonth(text) {
  const t = norm(text);
  const m1 = t.match(new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s+)?(${MONTHS.join('|')})\\b`));
  if (m1) return { day: Number(m1[1]), month: MONTHS.indexOf(m1[2]) + 1 };
  const m2 = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/);
  if (m2 && Number(m2[2]) >= 1 && Number(m2[2]) <= 12 && Number(m2[1]) <= 31) return { day: Number(m2[1]), month: Number(m2[2]) };
  return null;
}

// La sección del campus que corresponde a la clase n (o a esa fecha / ese fin de semana).
export function findSection(sections, { n, date, weekend }) {
  const keyed = (sections || []).map((s) => ({ s, k: sectionKey(s.name) }));
  if (date) {
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const byDate = keyed.find(({ k }) => k.day === day && k.month === month);
    if (byDate) return byDate.s;
  }
  const byN = keyed.find(({ k }) => k.n === n && k.weekend == null);
  if (byN) return byN.s;
  if (weekend) {
    const byW = keyed.find(({ k }) => k.weekend === weekend);
    if (byW) return byW.s;
  }
  return null;
}

// Fecha escrita de varias formas: "10/10", "10 de octubre", "10-oct".
function dateNeedles(date) {
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const mon = MONTHS[m - 1];
  return [
    new RegExp(`\\b0?${d}\\s*/\\s*0?${m}\\b`),
    new RegExp(`\\b0?${d}\\s*(?:de\\s+)?${mon}\\b`),
    new RegExp(`\\b0?${d}[-\\s]${mon.slice(0, 3)}\\b`),
  ];
}

// El pedazo del programa que habla de la clase n (o de esa fecha).
export function programExcerpt(text, { n, date, max = 1400 }) {
  if (!text) return null;
  const flat = String(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  const t = norm(flat);
  const markers = [];
  const re = new RegExp(`(?:^|[^a-z])(${SESSION_WORD})\\s*(?:n[°º.]?\\s*|nro\\.?\\s*|#\\s*)?0*(\\d{1,2})\\b`, 'g');
  let m;
  while ((m = re.exec(t))) markers.push({ at: m.index + (m[0].length - m[0].trimStart().length), n: Number(m[2]), word: m[1] });
  const cut = (from) => {
    // hasta el próximo marcador de otra clase (o la próxima fecha distinta)
    const next = markers.find((x) => x.at > from + 5 && x.n !== markers.find((y) => y.at === from)?.n);
    const end = Math.min(next ? next.at : flat.length, from + max);
    return flat.slice(from, end).trim();
  };
  if (date) {
    for (const needle of dateNeedles(date)) {
      const hit = t.search(needle);
      if (hit >= 0) {
        // empezar en el marcador de clase anterior más cercano (si está cerca) o en la línea
        const prev = [...markers].reverse().find((x) => x.at <= hit && hit - x.at < 200);
        const lineStart = t.lastIndexOf('\n', hit) + 1;
        const from = prev ? prev.at : lineStart;
        const seg = cut(from);
        if (seg.length > 20) return seg;
      }
    }
  }
  if (n != null) {
    // el marcador de esa clase con más texto después (el índice del programa suele repetirlos)
    let best = null;
    for (const x of markers.filter((y) => y.n === n)) {
      const seg = cut(x.at);
      if (!best || seg.length > best.length) best = seg;
    }
    if (best && best.length > 20) return best;
  }
  return null;
}

const STOP = new Set(['para', 'como', 'with', 'from', 'that', 'this', 'clase', 'sesion', 'lectura', 'lecturas', 'caso', 'casos', 'case', 'nota', 'notas', 'version', 'final', 'parte', 'capitulo', 'chapter', 'del', 'los', 'las', 'the', 'and', 'programa', 'slides', 'presentacion', 'ppt', 'pdf', 'docx', 'xlsx']);
export function nameTokens(name) {
  return norm(String(name || '').replace(/\.[a-z0-9]{2,5}$/i, ''))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !/^\d+$/.test(w) && !STOP.has(w));
}

// Archivos de la materia que el texto (pedazo del programa) menciona.
export function filesMentioned(text, files) {
  if (!text) return [];
  const hay = norm(text);
  const out = [];
  for (const f of files) {
    const toks = [...new Set(nameTokens(f.name))];
    if (!toks.length) continue;
    const hits = toks.filter((w) => hay.includes(w)).length;
    const score = hits / toks.length;
    if ((hits >= 2 && score >= 0.5) || (toks.length === 1 && hits === 1 && toks[0].length >= 6)) out.push({ f, score });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.f);
}

// Programa de la materia entre sus archivos (prefiere el cronograma).
export function pickProgram(files) {
  const cands = files.filter((f) => /\.pdf$/i.test(f.name) && /(cronograma|programa|syllabus|plan de clases)/i.test(`${f.name} ${f.module || ''}`));
  return cands.find((f) => /cronograma/i.test(f.name)) || cands[0] || null;
}

// Número de clase y de fin de semana de cada clase (en orden por fecha).
export function numberSessions(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const weeks = [];
  return sorted.map((ev, i) => {
    const d = new Date(ev.start);
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    if (!weeks.includes(monday)) weeks.push(monday);
    return { ev, n: i + 1, weekend: weeks.indexOf(monday) + 1, total: sorted.length };
  });
}
