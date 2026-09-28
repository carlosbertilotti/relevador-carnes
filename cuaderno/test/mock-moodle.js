// Moodle falso con la misma forma de respuesta que campusvirtual.utdt.edu, para tests
// y para probar la app sin la cuenta real: `node test/mock-moodle.js` y en la
// app conectar a http://localhost:5174 con usuario "alumno" / contraseña "clave".
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TOKEN = '5f3c2a9e8b7d6c1f0a4e3d2c1b0a9f8e';
const now = Math.floor(Date.now() / 1000);

export function tinyPdf(text = 'Clase 1') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 36 Tf 72 740 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

export function createMockMoodle() {
  let base = '';
  const courses = [
    { id: 11, fullname: 'ECO101 - Microeconomía I (2026-2)', shortname: 'ECO101', summary: '<p>Curso introductorio</p>', startdate: now - 60 * 86400, enddate: now + 60 * 86400 },
    { id: 12, fullname: 'Estadística', shortname: 'MAT210', summary: '', startdate: now - 60 * 86400, enddate: 0 },
  ];
  const contents = (courseid) => [
    { id: 1, name: 'General', summary: '<p>Programa y bibliografía</p>', modules: [
      { id: 100 + courseid, name: 'Programa', modname: 'resource', url: `${base}/mod/resource/view.php?id=1`, contents: [
        { type: 'file', filename: 'programa.pdf', fileurl: `${base}/webservice/pluginfile.php/1/mod_resource/content/0/programa.pdf?forcedownload=1`, filesize: 900, timemodified: now - 86400, mimetype: 'application/pdf' },
      ] },
      { id: 200 + courseid, name: 'Foro de novedades', modname: 'forum', url: `${base}/mod/forum/view.php?id=2`, contents: [] },
    ] },
    { id: 2, name: 'Semana 1', summary: '', modules: [
      { id: 300 + courseid, name: 'Diapositivas clase 1', modname: 'resource', url: `${base}/mod/resource/view.php?id=3`, contents: [
        { type: 'file', filename: `clase1-${courseid}.pdf`, fileurl: `${base}/pluginfile.php/2/mod_resource/content/0/clase1-${courseid}.pdf`, filesize: 900, timemodified: now - 3600, mimetype: 'application/pdf' },
      ] },
      { id: 400 + courseid, name: 'TP 1', modname: 'assign', url: `${base}/mod/assign/view.php?id=4`, contents: [] },
    ] },
  ];
  const fns = {
    core_webservice_get_site_info: () => ({ sitename: 'Campus Virtual Di Tella (prueba)', fullname: 'Alumna de Prueba', userid: 7 }),
    core_enrol_get_users_courses: () => courses,
    core_course_get_contents: (p) => contents(Number(p.get('courseid'))),
    core_calendar_get_calendar_events: () => ({ events: [
      { id: 1, name: 'Entrega TP 1', description: '<p>Subir en PDF</p>', timestart: now + 3 * 86400, timeduration: 0, courseid: 11, eventtype: 'due', modulename: 'assign' },
    ] }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const p = new URLSearchParams(body || url.search);
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (url.pathname === '/login/token.php') {
      if (p.get('username') === 'alumno' && p.get('password') === 'clave') return json({ token: TOKEN, privatetoken: null });
      return json({ error: 'Nombre de usuario o contraseña equivocados', errorcode: 'invalidlogin' });
    }
    if (url.pathname === '/webservice/rest/server.php') {
      if (p.get('wstoken') !== TOKEN) return json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Token no válido' });
      const fn = fns[p.get('wsfunction')];
      if (!fn) return json({ exception: 'dml_missing_record_exception', errorcode: 'invalidrecord', message: 'Función desconocida' });
      return json(fn(p));
    }
    if (url.pathname.startsWith('/webservice/pluginfile.php')) {
      if (url.searchParams.get('token') !== TOKEN) return json({ error: 'Token inválido', errorcode: 'invalidtoken' });
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(tinyPdf(url.pathname.split('/').pop().replace('.pdf', '')));
    }
    res.writeHead(404);
    res.end('not found');
  });
  return {
    server,
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        base = `http://localhost:${server.address().port}`;
        resolve(base);
      }));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = createMockMoodle();
  m.listen(Number(process.env.PORT || 5174)).then((b) => console.log(`Moodle de prueba en ${b} (usuario: alumno / clave)`));
}
