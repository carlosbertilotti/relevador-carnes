import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, launchUrl } from '../web/js/lib/token.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const b64 = (s) => Buffer.from(s).toString('base64');

test('acepta la clave de seguridad tal cual', () => {
  assert.equal(extractToken(`  ${TOKEN.toUpperCase()} `), TOKEN);
});

test('decodifica la dirección moodlemobile://token=', () => {
  const raw = b64(`d41d8cd98f00b204e9800998ecf8427e:::${TOKEN}:::privado123`);
  assert.equal(extractToken(`moodlemobile://token=${raw}`), TOKEN);
  assert.equal(extractToken(raw), TOKEN);
  assert.equal(extractToken(`"moodlemobile://token=${encodeURIComponent(raw)}"`), TOKEN);
  assert.equal(extractToken(b64(`firma:::${TOKEN}`)), TOKEN);
});

test('acepta base64 sin relleno o url-safe', () => {
  const raw = b64(`firma:::${TOKEN}:::x`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(extractToken(`utdt://token=${raw}`), TOKEN);
});

test('rechaza lo que no es una clave', () => {
  assert.throws(() => extractToken(''), /Pegá/);
  assert.throws(() => extractToken('hola mundo'), /No reconozco/);
  assert.throws(() => extractToken(b64('sin separador')), /No reconozco/);
});

test('arma la dirección de inicio de sesión del campus', () => {
  const u = new URL(launchUrl('https://campusvirtual.utdt.edu'));
  assert.equal(u.pathname, '/admin/tool/mobile/launch.php');
  assert.equal(u.searchParams.get('service'), 'moodle_mobile_app');
  assert.equal(u.searchParams.get('urlscheme'), 'moodlemobile');
  assert.equal(u.searchParams.get('confirmed'), '1');
});
