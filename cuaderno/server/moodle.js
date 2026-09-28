// Cliente mínimo de la API de Web Services de Moodle (la misma que usa la app
// oficial "Campus Virtual Di Tella"). Documentación:
// https://docs.moodle.org/dev/Web_service_API_functions

export const DEFAULT_MOODLE_URL = process.env.MOODLE_URL || 'https://campus.utdt.edu';
// Si está definida (ej. "campus.utdt.edu"), el servidor sólo habla con esos campus.
const ALLOWED_HOSTS = (process.env.MOODLE_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

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

  const visible = courses.filter((c) => !c.hidden && (!c.enddate || c.enddate > now - 30 * 86400));
  const detailed = await Promise.all(
    visible.map(async (c) => {
      let sections = [];
      try {
        sections = await call(base, token, 'core_course_get_contents', { courseid: c.id });
      } catch (err) {
        return { ...pickCourse(c), sections: [], error: err.message };
      }
      return { ...pickCourse(c), sections: sections.map(pickSection) };
    }),
  );

  let events = [];
  try {
    const ev = await call(base, token, 'core_calendar_get_calendar_events', {
      events: { courseids: visible.map((c) => c.id) },
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

function pickSection(s) {
  return {
    id: s.id,
    name: s.name,
    summary: stripHtml(s.summary || ''),
    modules: (s.modules || [])
      .filter((m) => m.uservisible !== false)
      .map((m) => ({
        id: m.id,
        name: m.name,
        type: m.modname,
        url: m.url || null,
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
