// Build para Vercel: copia pdf.js y perfect-freehand a web/vendor (localmente
// los sirve server.js directo desde node_modules).
import { cpSync, mkdirSync } from 'node:fs';

const copies = {
  'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs': 'web/vendor/pdfjs/pdf.min.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs': 'web/vendor/pdfjs/pdf.worker.min.mjs',
  'node_modules/perfect-freehand/dist/esm/index.mjs': 'web/vendor/perfect-freehand/index.mjs',
};
for (const [from, to] of Object.entries(copies)) {
  mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true });
  cpSync(from, to);
}
console.log('vendor listo');
