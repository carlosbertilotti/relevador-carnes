// Extrae el token del campus de lo que la persona pegue. Acepta:
//  - la clave de seguridad tal cual (32 caracteres hexadecimales)
//  - la dirección que devuelve el inicio de sesión de la app oficial:
//      moodlemobile://token=BASE64   (o sólo el BASE64)
//    donde BASE64 decodifica a "firma:::token" o "firma:::token:::tokenprivado"
const HEX32 = /^[0-9a-f]{32}$/i;

export function extractToken(input) {
  let s = String(input || '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!s) throw new Error('Pegá la clave o la dirección que empieza con moodlemobile://');
  if (HEX32.test(s)) return s.toLowerCase();

  // Quitar esquema ("moodlemobile://", "https://", etc.) y el prefijo "token=".
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const m = /token=([^&#\s]+)/i.exec(s);
  if (m) s = m[1];
  try { s = decodeURIComponent(s); } catch { /* ya estaba decodificado */ }
  if (HEX32.test(s)) return s.toLowerCase();

  const decoded = decodeBase64(s);
  const parts = decoded ? decoded.split(':::') : [];
  const token = parts.find((p, i) => i > 0 && HEX32.test(p.trim())) || (parts.length === 1 && HEX32.test(parts[0].trim()) ? parts[0] : null);
  if (token) return token.trim().toLowerCase();
  throw new Error('No reconozco esa clave. Pegá la clave de seguridad (32 letras y números) o la dirección completa que empieza con moodlemobile://token=');
}

function decodeBase64(s) {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean)) return null;
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    return typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('latin1');
  } catch {
    return null;
  }
}

// Página del campus que devuelve el token (la misma que usa la app oficial al entrar con Google/Microsoft).
export function launchUrl(base) {
  const u = new URL('/admin/tool/mobile/launch.php', base);
  u.searchParams.set('service', 'moodle_mobile_app');
  u.searchParams.set('passport', String(Math.floor(Math.random() * 1e6)));
  u.searchParams.set('urlscheme', 'moodlemobile');
  // confirmed=1: en vez de redirigir, el campus muestra una página con el enlace
  // "…lanzar la app" que contiene la clave; se copia con un toque largo (sin F12).
  u.searchParams.set('confirmed', '1');
  return u.toString();
}
