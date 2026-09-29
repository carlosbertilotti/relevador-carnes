// Service worker: la app abre y funciona sin conexión (las notas ya viven en IndexedDB).
const VERSION = 'cuaderno-v12';
const SHELL = [
  '/', '/index.html', '/app.css', '/manifest.webmanifest', '/icons/icon.svg',
  '/js/app.js', '/js/db.js', '/js/store.js', '/js/campus.js', '/js/ui.js', '/js/router.js', '/js/theme.js', '/js/demo.js',
  '/js/lib/ics.js', '/js/lib/token.js', '/js/views/today.js', '/js/views/calendar.js', '/js/views/notebook.js', '/js/views/settings.js',
  '/js/editor/editor.js', '/js/editor/ink.js', '/js/editor/pdf.js', '/js/editor/audio.js', '/js/editor/office.js', '/js/summary.js', '/js/sync.js',
  '/vendor/perfect-freehand/index.mjs', '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Red primero (para recibir actualizaciones), caché si no hay conexión.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
