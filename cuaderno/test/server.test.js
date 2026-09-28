import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/server.js';
import { createMockMoodle, TOKEN } from './mock-moodle.js';
import { flattenParams, fileUrlWithToken } from '../server/moodle.js';

let app;
let appUrl;
let mock;
let moodleUrl;

before(async () => {
  mock = createMockMoodle();
  moodleUrl = await mock.listen();
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.close(); mock.server.close(); });

const post = (path, body) => fetch(appUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('aplana parámetros al estilo Moodle', () => {
  const p = flattenParams({ events: { courseids: [3, 4] }, options: { userevents: true } });
  assert.equal(p.toString(), 'events%5Bcourseids%5D%5B0%5D=3&events%5Bcourseids%5D%5B1%5D=4&options%5Buserevents%5D=1');
});

test('reescribe pluginfile a webservice/pluginfile con token y rechaza otros hosts', () => {
  const u = fileUrlWithToken('https://campus.utdt.edu', 'https://campus.utdt.edu/pluginfile.php/1/a.pdf', 'T');
  assert.equal(u.toString(), 'https://campus.utdt.edu/webservice/pluginfile.php/1/a.pdf?token=T');
  assert.throws(() => fileUrlWithToken('https://campus.utdt.edu', 'https://evil.example/pluginfile.php/1', 'T'));
});

test('login con usuario y contraseña', async () => {
  const ok = await post('/api/campus/login', { url: moodleUrl, username: 'alumno', password: 'clave' });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.token, TOKEN);
  assert.equal(data.site.user, 'Alumna de Prueba');

  const bad = await post('/api/campus/login', { url: moodleUrl, username: 'alumno', password: 'mal' });
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).error, /equivocados/);
});

test('sync devuelve materias, material y eventos', async () => {
  const res = await post('/api/campus/sync', { url: moodleUrl, token: TOKEN });
  assert.equal(res.status, 200);
  const snap = await res.json();
  assert.equal(snap.courses.length, 2);
  const eco = snap.courses.find((c) => c.id === 11);
  const files = eco.sections.flatMap((s) => s.modules.flatMap((m) => m.files));
  assert.deepEqual(files.map((f) => f.name), ['programa.pdf', 'clase1-11.pdf']);
  assert.equal(snap.events[0].kind, 'entrega');
  assert.equal(snap.events[0].description, 'Subir en PDF');
});

test('token vencido devuelve 401', async () => {
  const res = await post('/api/campus/sync', { url: moodleUrl, token: 'viejo' });
  assert.equal(res.status, 401);
});

test('descarga archivos del campus', async () => {
  const snap = await (await post('/api/campus/sync', { url: moodleUrl, token: TOKEN })).json();
  const f = snap.courses[0].sections[1].modules[0].files[0];
  const res = await post('/api/campus/file', { url: moodleUrl, token: TOKEN, fileurl: f.url });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(Buffer.from(await res.arrayBuffer()).toString('latin1'), /^%PDF/);
});

test('el proxy iCal no accede a la red interna', async () => {
  for (const url of ['http://example.com/a.ics', 'https://127.0.0.1/a.ics', 'https://localhost/a.ics', 'https://192.168.0.2/x.ics']) {
    const res = await post('/api/ics', { url });
    assert.equal(res.status, 400, url);
  }
});

test('sirve la app y las librerías', async () => {
  const html = await fetch(`${appUrl}/`);
  assert.match(await html.text(), /<title>Cuaderno<\/title>/);
  const pf = await fetch(`${appUrl}/vendor/perfect-freehand/index.mjs`);
  assert.equal(pf.status, 200);
  const trav = await fetch(`${appUrl}/..%2f..%2fpackage.json`);
  assert.notEqual(trav.status, 200);
});
