// Enrutado por hash: #/hoy, #/calendario, #/cuaderno/:id, #/nota/:id, #/campus, #/ajustes, #/buscar/:q
export function go(path) {
  const next = `#${path}`;
  if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}

export function current() {
  const raw = location.hash.replace(/^#\/?/, '') || 'hoy';
  const [name, ...rest] = raw.split('/').map(decodeURIComponent);
  return { name, params: rest };
}
