// Build para Vercel: copia las librerías del navegador a web/vendor (localmente
// las sirve server.js directo desde node_modules, con las mismas rutas).
import { cpSync, mkdirSync } from 'node:fs';

const copies = {
  'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs': 'web/vendor/pdfjs/pdf.min.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs': 'web/vendor/pdfjs/pdf.worker.min.mjs',
  'node_modules/perfect-freehand/dist/esm/index.mjs': 'web/vendor/perfect-freehand/index.mjs',
  'node_modules/mammoth/mammoth.browser.min.js': 'web/vendor/mammoth/mammoth.browser.min.js',
  'node_modules/jszip/dist/jszip.min.js': 'web/vendor/jszip/jszip.min.js',
  'node_modules/dompurify/dist/purify.es.mjs': 'web/vendor/dompurify/purify.es.mjs',
  'node_modules/marked/lib/marked.esm.js': 'web/vendor/marked/marked.esm.js',
  'node_modules/katex/dist/katex.mjs': 'web/vendor/katex/katex.mjs',
  'node_modules/katex/dist/katex.min.css': 'web/vendor/katex/katex.min.css',
  'node_modules/katex/dist/fonts': 'web/vendor/katex/fonts',
};
for (const [from, to] of Object.entries(copies)) {
  mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true });
  cpSync(from, to, { recursive: true });
}
console.log('vendor listo');
