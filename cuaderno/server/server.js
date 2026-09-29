// Servidor de Cuaderno: sirve la app (PWA) y hace de puente con el Campus
// Virtual (Moodle) y con calendarios iCal, que no se pueden leer directo desde
// el navegador por CORS. No guarda nada: el token del campus vive en el
// dispositivo y viaja en cada pedido.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import * as moodle from './moodle.js';
import { resumir } from './resumen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const VENDOR = {
  '/vendor/pdfjs/': path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build'),
  '/vendor/perfect-freehand/': path.join(ROOT, 'node_modules/perfect-freehand/dist/esm'),
  '/vendor/mammoth/': path.join(ROOT, 'node_modules/mammoth'),
  '/vendor/jszip/': path.join(ROOT, 'node_modules/jszip/dist'),
  '/vendor/dompurify/': path.join(ROOT, 'node_modules/dompurify/dist'),
  '/vendor/marked/': path.join(ROOT, 'node_modules/marked/lib'),
  '/vendor/katex/': path.join(ROOT, 'node_modules/katex/dist'),
};
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req, max = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Pedido demasiado grande'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (!isIP(h)) return false;
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

const api = {
  'GET /api/health': async () => ({ ok: true, campus: moodle.DEFAULT_MOODLE_URL, ai: !!process.env.ANTHROPIC_API_KEY }),

  'POST /api/campus/login': async (body) => {
    const base = moodle.normalizeBase(body.url);
    if (!body.username || !body.password) throw Object.assign(new Error('Faltan usuario o contraseña'), { status: 400 });
    const token = await moodle.login(base, body.username, body.password);
    const site = await moodle.call(base, token, 'core_webservice_get_site_info');
    return { token, site: { name: site.sitename, user: site.fullname, userid: site.userid, url: base } };
  },

  'POST /api/campus/sync': async (body) => {
    const base = moodle.normalizeBase(body.url);
    if (!body.token) throw Object.assign(new Error('Falta el token del campus'), { status: 400 });
    return moodle.snapshot(base, body.token, { daysAhead: body.daysAhead || 60 });
  },

  'POST /api/campus/file': async (body, res) => {
    const base = moodle.normalizeBase(body.url);
    const target = moodle.fileUrlWithToken(base, body.fileurl, body.token);
    const upstream = await fetch(target, { redirect: 'follow' });
    if (!upstream.ok) throw Object.assign(new Error(`No se pudo bajar el archivo (${upstream.status})`), { status: 502 });
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    // Moodle devuelve un JSON de error con 200 cuando el token no sirve.
    if (type.includes('application/json')) {
      const err = await upstream.json().catch(() => ({}));
      throw Object.assign(new Error(err.error || err.message || 'El campus rechazó la descarga'), { status: 401 });
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    Readable.fromWeb(upstream.body).pipe(res);
    return undefined;
  },

  'POST /api/resumen': async (body) => resumir(body),

  'POST /api/ics': async (body) => {
    let u;
    try {
      u = new URL(String(body.url || '').replace(/^webcal:/, 'https:'));
    } catch {
      throw Object.assign(new Error('URL de calendario inválida'), { status: 400 });
    }
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) {
      throw Object.assign(new Error('Sólo se aceptan calendarios públicos por https'), { status: 400 });
    }
    const upstream = await fetch(u, { headers: { Accept: 'text/calendar' } });
    const text = await upstream.text();
    if (!upstream.ok || !text.includes('BEGIN:VCALENDAR')) {
      throw Object.assign(new Error('La URL no devolvió un calendario iCal'), { status: 502 });
    }
    return { ics: text };
  },
};

async function serveStatic(req, res, pathname) {
  let dir = WEB;
  let rel = pathname;
  for (const [prefix, vdir] of Object.entries(VENDOR)) {
    if (pathname.startsWith(prefix)) {
      dir = vdir;
      rel = pathname.slice(prefix.length - 1);
    }
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(dir, path.normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(dir)) return send(res, 403, 'Prohibido');
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('no file');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': dir === WEB ? 'no-cache' : 'public, max-age=604800',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    // SPA: cualquier ruta desconocida sin extensión devuelve la app.
    if (!path.extname(pathname)) {
      const html = await readFile(path.join(WEB, 'index.html'));
      return send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    }
    send(res, 404, 'No encontrado');
  }
}

// Atiende una ruta de la API. Lo usan el servidor local y las funciones de Vercel (api/).
export async function handleApi(req, res, route) {
  const handler = api[`${req.method} ${route}`];
  if (!handler) return send(res, 404, { error: 'Ruta desconocida' });
  if (APP_PASSWORD && route !== '/api/health' && !sameKey(req.headers['x-cuaderno-key'], APP_PASSWORD)) {
    return send(res, 401, { error: 'Clave de Cuaderno incorrecta', code: 'appkey' });
  }
  try {
    const body = req.method === 'POST' ? await requestBody(req, route === '/api/resumen' ? 4_200_000 : MAX_BODY) : {};
    const out = await handler(body, res);
    if (out !== undefined) send(res, 200, out);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500 && status !== 503) console.error(`[${route}]`, err);
    if (!res.headersSent) send(res, status, { error: err.message || 'Error', code: err.code || null });
    else res.destroy(err);
  }
}

function sameKey(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// En Vercel el cuerpo ya viene leído en req.body; en el servidor local hay que leerlo.
async function requestBody(req, max) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    try { return JSON.parse(String(req.body) || '{}'); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
  }
  return readJson(req, max);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    return handleApi(req, res, pathname);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Cuaderno listo en http://localhost:${PORT}  (campus: ${moodle.DEFAULT_MOODLE_URL})`);
  });
}
