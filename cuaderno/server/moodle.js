// Cliente mínimo de la API de Web Services de Moodle (la misma que usa la app
// oficial "Campus Virtual Di Tella"). Documentación:
// https://docs.moodle.org/dev/Web_service_API_functions

export const DEFAULT_MOODLE_URL = process.env.MOODLE_URL || 'https://campusvirtual.utdt.edu';
// Si está definida (ej. "campusvirtual.utdt.edu"), el servidor sólo habla con esos campus.
// El campus por defecto siempre está permitido.
const ALLOWED_HOSTS = (process.env.MOODLE_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
if (ALLOWED_HOSTS.length) ALLOWED_HOSTS.push(new URL(DEFAULT_MOODLE_URL).hostname.toLowerCase());

export class MoodleError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Moodle espera arrays/objetos aplanados: courseids[0]=1&options[timestart]=...
export function flattenParams(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flattenParams(v, key, out);
    else out.append(key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return out;
}

export function normalizeBase(url) {
  const u = new URL(url || DEFAULT_MOODLE_URL);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new MoodleError('El campus debe usar https', 'badurl', 400);
  }
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) {
    throw new MoodleError(`Este servidor sólo se conecta con ${ALLOWED_HOSTS.join(', ')}`, 'badurl', 400);
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export async function login(base, username, password) {
  const res = await fetch(`${base}/login/token.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, service: 'moodle_mobile_app' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.token) {
    throw new MoodleError(data.error || 'No se pudo iniciar sesión en el campus', data.errorcode || 'login', 401);
  }
  return data.token;
}

export async function call(base, token, wsfunction, params = {}) {
  const body = flattenParams(params);
  body.set('wstoken', token);
  body.set('wsfunction', wsfunction);
  body.set('moodlewsrestformat', 'json');
  const res = await fetch(`${base}/webservice/rest/server.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (data && data.exception) {
    const status = data.errorcode === 'invalidtoken' ? 401 : 502;
    throw new MoodleError(data.message || data.errorcode, data.errorcode, status);
  }
  if (!res.ok) throw new MoodleError(`El campus respondió ${res.status}`, 'http', 502);
  return data;
}

const DOWNLOADABLE = /\.(pdf|docx?|pptx?|xlsx?|txt|md|png|jpe?g|gif|zip|csv|ipynb|py|r|rmd)$/i;

// Devuelve todo lo que la app necesita en un solo viaje: materias, contenido
// de cada una (secciones, recursos y archivos) y eventos del calendario.
export async function snapshot(base, token, { daysAhead = 60, daysBack = 7 } = {}) {
  const site = await call(base, token, 'core_webservice_get_site_info');
  const courses = await call(base, token, 'core_enrol_get_users_courses', { userid: site.userid });
  const now = Math.floor(Date.now() / 1000);

  const visible = courses.filter((c) => !c.hidden);
  const status = await classifyCourses(base, token, visible, now);

  // Contenido de a pocas materias por vez para no saturar el campus.
  const detailed = await mapLimit(visible, 4, async (c) => {
    const base_ = { ...pickCourse(c), status: status.get(c.id) || 'cursando' };
    try {
      const sections = await call(base, token, 'core_course_get_contents', { courseid: c.id });
      return { ...base_, sections: sections.map(pickSection) };
    } catch (err) {
      return { ...base_, sections: [], error: err.message };
    }
  });

  let events = [];
  try {
    const ev = await call(base, token, 'core_calendar_get_calendar_events', {
      events: { courseids: visible.filter((c) => status.get(c.id) !== 'pasada').map((c) => c.id) },
      options: { userevents: 1, siteevents: 1, timestart: now - daysBack * 86400, timeend: now + daysAhead * 86400 },
    });
    events = (ev.events || []).map((e) => ({
      id: `moodle-${e.id}`,
      title: e.name,
      description: stripHtml(e.description || ''),
      start: e.timestart * 1000,
      end: (e.timestart + (e.timeduration || 0)) * 1000,
      courseId: e.courseid || null,
      kind: e.eventtype === 'due' || e.modulename ? 'entrega' : 'evento',
      source: 'campus',
      url: e.url || null,
    }));
  } catch {
    // Algunas instalaciones restringen esta función; el resto sigue sirviendo.
  }

  return {
    site: { name: site.sitename, user: site.fullname, userid: site.userid, url: base },
    courses: detailed,
    events,
    syncedAt: Date.now(),
  };
}

// "cursando" / "pasada" / "proxima", igual que "Mis cursos" del campus
// (core_course_get_enrolled_courses_by_timeline_classification). Si el campus
// no permite esa función, se decide por las fechas de la materia.
export async function classifyCourses(base, token, courses, now = Math.floor(Date.now() / 1000)) {
  const out = new Map();
  const kinds = { inprogress: 'cursando', past: 'pasada', future: 'proxima' };
  try {
    for (const [classification, label] of Object.entries(kinds)) {
      const r = await call(base, token, 'core_course_get_enrolled_courses_by_timeline_classification', { classification, limit: 0 });
      for (const c of r.courses || []) out.set(c.id, label);
    }
  } catch {
    out.clear();
  }
  for (const c of courses) {
    if (out.has(c.id)) continue;
    if (c.enddate && c.enddate < now) out.set(c.id, 'pasada');
    else if (c.startdate && c.startdate > now) out.set(c.id, 'proxima');
    else out.set(c.id, 'cursando');
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function pickCourse(c) {
  return {
    id: c.id,
    name: c.fullname,
    shortname: c.shortname,
    summary: stripHtml(c.summary || ''),
    startdate: c.startdate ? c.startdate * 1000 : null,
    enddate: c.enddate ? c.enddate * 1000 : null,
  };
}

// Links que aparecen en el texto de secciones, etiquetas y recursos URL
// (ahí suelen estar las grabaciones de Zoom de cada clase).
const ZOOM_REC = /zoom\.us\/rec\//i;
export function extractLinks(html, fallbackLabel = '') {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const url = m[1].replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ url, label: stripHtml(m[2]) || fallbackLabel || url });
  }
  // Links pegados como texto, sin <a>
  for (const u of String(html || '').replace(/<a\b[\s\S]*?<\/a>/gi, ' ').match(/https?:\/\/[^\s"'<>]+/gi) || []) {
    out.push({ url: u.replace(/&amp;/g, '&'), label: fallbackLabel || u });
  }
  return out;
}
const linkKind = (url) => (ZOOM_REC.test(url) ? 'zoom' : /\.(mp4|m4v|mov|webm)(\?|$)/i.test(url) ? 'video' : 'link');

function pickSection(s) {
  const links = [];
  const add = (list) => {
    for (const l of list) if (!links.some((x) => x.url === l.url)) links.push({ ...l, kind: linkKind(l.url) });
  };
  add(extractLinks(s.summary, s.name));
  for (const m of s.modules || []) {
    if (m.uservisible === false) continue;
    add(extractLinks(m.description, m.name));
    add((m.contents || []).filter((c) => c.type === 'url' && c.fileurl).map((c) => ({ url: c.fileurl, label: m.name })));
  }
  return {
    id: s.id,
    name: s.name,
    summary: stripHtml(s.summary || ''),
    links,
    modules: (s.modules || [])
      .filter((m) => m.uservisible !== false)
      .map((m) => ({
        id: m.id,
        name: m.name,
        type: m.modname,
        url: m.url || null,
        externalUrl: (m.contents || []).find((c) => c.type === 'url')?.fileurl || null,
        description: stripHtml(m.description || ''),
        files: (m.contents || [])
          .filter((f) => f.type === 'file')
          .map((f) => ({
            name: f.filename,
            url: f.fileurl,
            size: f.filesize,
            mimetype: f.mimetype || null,
            modified: (f.timemodified || 0) * 1000,
            downloadable: DOWNLOADABLE.test(f.filename),
          })),
      })),
  };
}

export function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Las URLs de archivos de Moodle aceptan el token como parámetro.
export function fileUrlWithToken(base, fileurl, token) {
  const u = new URL(fileurl);
  const b = new URL(base);
  if (u.origin !== b.origin) throw new MoodleError('Archivo fuera del campus', 'badfile', 400);
  if (u.pathname.includes('/pluginfile.php') && !u.pathname.includes('/webservice/pluginfile.php')) {
    u.pathname = u.pathname.replace('/pluginfile.php', '/webservice/pluginfile.php');
  }
  u.searchParams.set('token', token);
  return u;
}
