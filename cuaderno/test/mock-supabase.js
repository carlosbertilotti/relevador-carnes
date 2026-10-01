// Imitación mínima de las funciones de sincronización de Cuaderno en Supabase
// (supabase/cuaderno_sync.sql), en memoria, para probar la sincronización entre
// "dispositivos" (navegadores separados) sin conexión a internet.
import http from 'node:http';

export function createMockSupabase({ key = 'clave-test' } = {}) {
  const docs = new Map(); // `${store}|${id}` -> row
  const blobs = new Map(); // `${id}|${part}` -> { total, mime, data }
  let seq = 0;
  let live = null;
  const fns = {
    cuaderno_live_set({ st }) {
      live = { ...st, t0: Date.now() };
      return { now: Date.now() };
    },
    cuaderno_live_get() {
      return { now: Date.now(), state: live };
    },
    cuaderno_push({ docs: list }) {
      for (const d of list) {
        const k = `${d.store}|${d.id}`;
        const cur = docs.get(k);
        seq++;
        if (!cur || cur.mod < d.mod) docs.set(k, { store: d.store, id: d.id, data: d.data ?? null, mod: d.mod, deleted: !!d.deleted, seq });
      }
      return Math.max(0, ...[...docs.values()].map((r) => r.seq));
    },
    cuaderno_pull({ since, lim = 200 }) {
      return [...docs.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).slice(0, lim);
    },
    cuaderno_blob_put({ p_id, p_part, p_total, p_mime, p_data }) {
      blobs.set(`${p_id}|${p_part}`, { total: p_total, mime: p_mime, data: p_data });
      return null;
    },
    cuaderno_blob_have({ ids }) {
      return ids.filter((id) => {
        const first = blobs.get(`${id}|0`);
        return first && Array.from({ length: first.total }, (_, i) => blobs.has(`${id}|${i}`)).every(Boolean);
      });
    },
    cuaderno_blob_get({ p_id, p_part }) {
      const b = blobs.get(`${p_id}|${p_part}`);
      return b ? [{ o_total: b.total, o_mime: b.mime, o_data: b.data }] : [];
    },
  };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const fn = fns[req.url.replace('/rest/v1/rpc/', '')];
    let body = '';
    for await (const c of req) body += c;
    const args = JSON.parse(body || '{}');
    if (!fn) { res.writeHead(404, cors); return res.end('{}'); }
    if (args.k !== key) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: '28000', message: 'Clave de Cuaderno incorrecta' }));
    }
    const out = fn(args);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return {
    server,
    docs,
    blobs,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
  };
}
