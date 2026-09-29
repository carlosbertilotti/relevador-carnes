import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// API de Claude simulada: responde en streaming (SSE) como la real y guarda el pedido.
let fake;
let lastRequest;
let reply = { text: '## Ideas clave\n- La elasticidad mide $\\varepsilon = \\frac{\\Delta Q/Q}{\\Delta P/P}$', stop: 'end_turn' };

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

let server;
let base;
before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: lastRequest.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    sse(res, [
      ['message_start', { type: 'message_start', message: msg }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop, stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { createServer } = await import('../server/server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fake.close(); });

const post = (body) => fetch(`${base}/api/resumen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('resume una clase con texto e imágenes de hojas a mano', async () => {
  const res = await post({ mode: 'nota', materia: 'Microeconomía I', nota: { titulo: 'Elasticidades', fecha: '2026-09-28', texto: 'Elasticidad precio', imagenes: [{ data: 'aGVsbG8=', etiqueta: 'hoja escrita a mano' }] } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.match(out.markdown, /Ideas clave/);
  const b = lastRequest.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.fallbacks, 'default');
  assert.equal(b.stream, true);
  assert.deepEqual(b.output_config, { effort: 'medium' });
  assert.match(lastRequest.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const img = b.messages[0].content.find((c) => c.type === 'image');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.match(b.messages[0].content.at(-1).text, /Microeconomía I[\s\S]*Elasticidades/);
});

test('combina los resúmenes de las clases en uno de la materia', async () => {
  const res = await post({ mode: 'materia', materia: 'Micro', notas: [{ titulo: 'C1', fecha: '2026-09-01', resumen: 'r1' }, { titulo: 'C2', fecha: '2026-09-08', resumen: 'r2' }] });
  assert.equal(res.status, 200);
  assert.match(lastRequest.body.messages[0].content[0].text, /### C1[\s\S]*### C2[\s\S]*Hoja de fórmulas/);
});

test('valida el pedido y avisa si Claude se niega', async () => {
  assert.equal((await post({ mode: 'otro' })).status, 400);
  assert.equal((await post({ mode: 'materia', notas: [] })).status, 400);
  reply = { text: '', stop: 'refusal' };
  const res = await post({ mode: 'nota', materia: 'X', nota: { titulo: 't', texto: 'x' } });
  assert.equal(res.status, 422);
});
