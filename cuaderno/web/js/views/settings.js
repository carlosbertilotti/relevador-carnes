// "Campus y calendarios" + "Ajustes".
import * as db from '../db.js';
import * as store from '../store.js';
import * as campus from '../campus.js';
import { parseICS } from '../lib/ics.js';
import { extractToken, launchUrl } from '../lib/token.js';
import { h, icon, toast, confirmDialog, downloadBlob } from '../ui.js';
import { go } from '../router.js';
import { applyTheme } from '../theme.js';

export async function renderCampus(root) {
  const acc = await campus.account();
  const cals = (await db.getSetting('icsCalendars', [])) || [];
  const status = h('p.muted.sync-status');

  let accountCard;
  if (acc) {
    accountCard = h('section.card',
      h('h2.section-title', icon('campus'), acc.site?.name || 'Campus Virtual'),
      h('p', `Conectado como `, h('strong', acc.site?.user || '—'), ` · ${acc.url}`),
      acc.error ? h('p.error-text', acc.error) : null,
      h('p.muted', `Última sincronización: ${acc.lastSync ? `${new Date(acc.lastSync).toLocaleString('es-AR')} (${store.fmtRelative(acc.lastSync)})` : 'nunca'}`),
      status,
      h('div.row',
        h('button.btn.primary', { type: 'button', onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            const r = await campus.sync({ onProgress: (m) => { status.textContent = m; } });
            toast(`Listo: ${r.courses} materias, ${r.newFiles} archivo(s) nuevo(s), ${r.events} evento(s)`);
            renderCampus(root);
          } catch (err) {
            status.textContent = '';
            toast(err.message, { error: true });
            b.disabled = false;
          }
        } }, icon('sync'), 'Sincronizar ahora'),
        h('button.btn', { type: 'button', onclick: async () => { if (await confirmDialog('Desconectar', 'Tus notas y el material descargado quedan en el dispositivo.', { ok: 'Desconectar' })) { await campus.logout(); renderCampus(root); } } }, 'Desconectar')));
  } else {
    accountCard = loginCard(() => renderCampus(root));
  }

  // ---- Calendarios iCal ----
  const calList = h('ul.cal-subs', cals.map((c, i) => h('li',
    h('span.dot', { style: { background: c.color || '#8a8f98' } }),
    h('div.grow',
      h('div', c.name),
      h('small', c.error ? `Error: ${c.error}` : `${(c.events || []).length} eventos · ${c.kind === 'clase' ? 'horario de clases' : 'eventos'} · ${c.syncedAt ? `actualizado ${store.fmtRelative(c.syncedAt)}` : 'sin actualizar'}`)),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Quitar', onclick: async () => { cals.splice(i, 1); await db.setSetting('icsCalendars', cals); renderCampus(root); } }, icon('trash')))));
  const nameIn = h('input.input', { placeholder: 'Nombre (ej. Horarios Di Tella)' });
  const urlIn = h('input.input.grow', { placeholder: 'https://calendar.google.com/…/basic.ics  ó  webcal://…' });
  const kindIn = h('select.input', h('option', { value: 'auto' }, 'Detectar materias'), h('option', { value: 'clase' }, 'Todo son clases'), h('option', { value: 'evento' }, 'Eventos'));
  const fileIn = h('input', { type: 'file', accept: '.ics,text/calendar', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const events = parseICS(await f.text());
    cals.push({ id: db.uid('cal_'), name: f.name.replace(/\.ics$/i, ''), url: null, kind: kindIn.value === 'auto' ? null : kindIn.value, color: store.COLORS[cals.length % store.COLORS.length], events, syncedAt: Date.now() });
    await db.setSetting('icsCalendars', cals);
    toast(`${events.length} eventos importados`);
    renderCampus(root);
  } });

  const calCard = h('section.card',
    h('h2.section-title', icon('calendar'), 'Calendarios suscriptos'),
    h('p.muted', 'Sumá tu horario de cursada, Google Calendar u Outlook con su enlace iCal secreto. Los eventos que coincidan con el nombre de una materia se toman como clases y abren su nota.'),
    cals.length ? calList : null,
    h('div.row.wrap', nameIn, urlIn, kindIn,
      h('button.btn.primary', { type: 'button', onclick: async () => {
        const url = urlIn.value.trim();
        if (!url) { toast('Pegá la URL del calendario', { error: true }); return; }
        cals.push({ id: db.uid('cal_'), name: nameIn.value.trim() || 'Calendario', url, kind: kindIn.value === 'auto' ? null : kindIn.value, color: store.COLORS[cals.length % store.COLORS.length] });
        await db.setSetting('icsCalendars', cals);
        const errors = await store.refreshIcs(campus.api);
        if (errors.length) toast(errors.join('\n'), { error: true }); else toast('Calendario agregado');
        renderCampus(root);
      } }, 'Suscribir'),
      h('label.btn', 'Importar .ics', fileIn)),
    cals.some((c) => c.url) ? h('button.btn.small', { type: 'button', onclick: async () => {
      const errors = await store.refreshIcs(campus.api);
      toast(errors.length ? errors.join('\n') : 'Calendarios actualizados', { error: !!errors.length });
      renderCampus(root);
    } }, icon('sync'), 'Actualizar calendarios') : null,
    h('details.help',
      h('summary', '¿Dónde consigo el enlace iCal?'),
      h('ul',
        h('li', h('strong', 'Campus (Moodle): '), 'Calendario → Exportar calendario → "Todos los eventos" + "Eventos recientes y próximos" → Obtener URL del calendario.'),
        h('li', h('strong', 'Google Calendar: '), 'Configuración → tu calendario → "Dirección secreta en formato iCal".'),
        h('li', h('strong', 'Outlook: '), 'Configuración → Calendario → Calendarios compartidos → Publicar un calendario → enlace ICS.'))));

  root.replaceChildren(h('div.page.settings',
    h('header.page-head', h('div', h('p.eyebrow', 'Sincronización'), h('h1', 'Campus y calendarios'))),
    accountCard,
    calCard));
}

function loginCard(onDone) {
  const url = h('input.input', { value: campus.DEFAULT_URL });
  const user = h('input.input', { placeholder: 'Usuario del campus', autocomplete: 'username', autocapitalize: 'off' });
  const pass = h('input.input', { type: 'password', placeholder: 'Contraseña', autocomplete: 'current-password' });
  const token = h('textarea.input.token-input', { rows: 2, placeholder: 'Pegá acá la clave o la dirección moodlemobile://token=…', autocapitalize: 'off', autocorrect: 'off', spellcheck: false });
  const tokenState = h('p.token-state');
  token.addEventListener('input', () => {
    if (!token.value.trim()) { tokenState.textContent = ''; tokenState.className = 'token-state'; return; }
    try {
      extractToken(token.value);
      tokenState.textContent = '✓ Clave reconocida. Tocá Conectar.';
      tokenState.className = 'token-state ok';
    } catch (err) {
      tokenState.textContent = err.message;
      tokenState.className = 'token-state bad';
    }
  });
  const campusBase = () => { try { return new URL(campus.fixCampusUrl(url.value)).origin; } catch { return campus.DEFAULT_URL; } };
  let mode = 'password';
  const panel = h('div');
  const seg = h('div.segmented');
  const draw = () => {
    seg.replaceChildren(
      h(`button${mode === 'password' ? '.active' : ''}`, { type: 'button', onclick: () => { mode = 'password'; draw(); } }, 'Usuario y contraseña'),
      h(`button${mode === 'token' ? '.active' : ''}`, { type: 'button', onclick: () => { mode = 'token'; draw(); } }, 'Entro con Google / Microsoft'));
    panel.replaceChildren(...(mode === 'password'
      ? [h('label.field', h('span', 'Usuario'), user), h('label.field', h('span', 'Contraseña'), pass)]
      : [h('p.muted', 'Si entrás al campus con Google o Microsoft no tenés contraseña del campus: Cuaderno necesita tu clave de acceso. Conseguila de una de estas dos formas (con la sesión del campus abierta en este navegador):'),
        otherBrowser() ? h('div.browser-warn',
          h('p', h('strong', 'Estás usando otro navegador, no Safari. '), 'Si el inicio de sesión con Microsoft no te funciona acá, abrí Cuaderno en Safari y conectá el campus desde ahí.'),
          h('button.btn.small', { type: 'button', onclick: () => copyLink(location.origin + '/#/campus', 'Dirección de Cuaderno copiada: pegala en Safari') }, 'Copiar dirección de Cuaderno')) : null,
        h('ol.token-steps',
          h('li',
            h('strong', 'Claves de seguridad. '),
            'Abrí la página y copiá la clave de la fila "Moodle mobile web service".',
            safariLink(`${campusBase()}/user/managetoken.php`, 'Abrir Claves de seguridad')),
          h('li',
            h('strong', 'Si esa página no existe: '),
            'en la computadora, abrí las herramientas de desarrollador (F12) en la pestaña Red/Network y después tocá el botón. El navegador va a intentar abrir la app oficial y va a fallar: en Network aparece una dirección que empieza con ',
            h('code', 'moodlemobile://token='), '. Copiala entera y pegala acá; Cuaderno saca la clave sola.',
            safariLink(launchUrl(campusBase()), 'Iniciar sesión como la app oficial'))),
        h('label.field', h('span', 'Clave o dirección'), token),
        tokenState,
        h('p.muted.small-note', 'Esa clave da acceso a tu cuenta del campus: no la compartas. Queda guardada sólo en este dispositivo.')]));
  };
  draw();
  const status = h('p.muted');
  return h('section.card.login',
    h('h2.section-title', icon('campus'), 'Conectar el Campus Virtual Di Tella'),
    h('p.muted', 'Cuaderno usa la misma conexión que la app oficial del campus. Tu contraseña no se guarda: sólo el token de acceso, en este dispositivo.'),
    seg,
    h('label.field', h('span', 'Dirección del campus'), url),
    panel,
    status,
    h('button.btn.primary', { type: 'button', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      status.textContent = 'Conectando…';
      try {
        await campus.login(mode === 'password'
          ? { url: url.value, username: user.value.trim(), password: pass.value }
          : { url: url.value, token: extractToken(token.value) });
        status.textContent = 'Conectado. Bajando tus materias…';
        const r = await campus.sync({ onProgress: (m) => { status.textContent = m; } });
        toast(`¡Listo! ${r.courses} materias sincronizadas`);
        onDone();
      } catch (err) {
        status.textContent = '';
        toast(err.message, { error: true, ms: 6000 });
        b.disabled = false;
      }
    } }, 'Conectar'));
}

export async function renderSettings(root) {
  const s = {
    theme: await db.getSetting('theme', 'system'),
    invertInk: await db.getSetting('invertInk', true),
    defaultMode: await db.getSetting('defaultMode', 'mixed'),
    defaultPaper: await db.getSetting('defaultPaper', 'lined'),
    autoSync: await db.getSetting('autoSync', true),
    autoDownload: await db.getSetting('autoDownload', true),
    appKey: await db.getSetting('appKey', ''),
  };
  const set = async (k, v) => { s[k] = v; await db.setSetting(k, v); if (k === 'theme' || k === 'invertInk') applyTheme(); };
  const select = (k, options) => h('select.input', { onchange: (e) => set(k, e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: s[k] === v }, l)));
  const toggle = (k, label, hint) => h('label.toggle', h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => set(k, e.target.checked) }), h('div', h('div', label), hint ? h('small', hint) : null));

  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) usage = `Usando ${store.fmtSize(est.usage)} de ${store.fmtSize(est.quota)} disponibles.`;
  } catch { /* sin datos */ }

  root.replaceChildren(h('div.page.settings',
    h('header.page-head', h('div', h('p.eyebrow', 'Cuaderno'), h('h1', 'Ajustes'))),
    h('section.card',
      h('h2.section-title', 'Notas'),
      h('label.field', h('span', 'Formato de las notas nuevas'), select('defaultMode', [['mixed', 'Texto arriba + hoja para el lápiz'], ['text', 'Sólo texto (como Notas de Apple)'], ['ink', 'Sólo a mano (como GoodNotes)']])),
      h('label.field', h('span', 'Hoja por defecto'), select('defaultPaper', [['lined', 'Rayada'], ['grid', 'Cuadriculada'], ['dots', 'Puntos'], ['blank', 'Lisa'], ['cornell', 'Cornell (preguntas + notas + resumen)']]))),
    h('section.card',
      h('h2.section-title', 'Apariencia'),
      h('label.field', h('span', 'Tema'), select('theme', [['system', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']])),
      toggle('invertInk', 'Invertir las hojas en modo oscuro', 'Tinta clara sobre fondo oscuro, como en Saber. Cansa menos la vista de noche.')),
    h('section.card',
      h('h2.section-title', 'Campus'),
      toggle('autoSync', 'Sincronizar solo al abrir la app', 'Como máximo una vez por hora.'),
      toggle('autoDownload', 'Descargar el material automáticamente', 'Así lo tenés sin conexión en clase.'),
      h('label.field', h('span', 'Clave del servidor de Cuaderno (opcional)'), h('input.input', { type: 'password', value: s.appKey, placeholder: 'Sólo si configuraste APP_PASSWORD en el servidor', onchange: (e) => set('appKey', e.target.value) }))),
    h('section.card',
      h('h2.section-title', 'Tus datos'),
      h('p.muted', `Todo se guarda en este dispositivo. ${usage}`),
      h('div.row.wrap',
        h('button.btn', { type: 'button', onclick: async () => {
          toast('Preparando la copia…');
          downloadBlob(await db.exportAll(), `cuaderno-${store.ymd()}.json`);
        } }, icon('download'), 'Exportar copia de seguridad'),
        h('label.btn', 'Restaurar copia', h('input', { type: 'file', hidden: true, accept: 'application/json', onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try { await db.importAll(f); toast('Copia restaurada'); go('/hoy'); } catch (err) { toast(err.message, { error: true }); }
        } })),
        navigator.storage?.persist ? h('button.btn', { type: 'button', onclick: async () => {
          const ok = await navigator.storage.persist();
          toast(ok ? 'El navegador no va a borrar tus notas' : 'El navegador no lo permitió. Instalá la app en la pantalla de inicio.');
        } }, 'Evitar que el navegador borre datos') : null)),
    h('section.card',
      h('h2.section-title', 'Consejos para el iPad'),
      h('ul.tips',
        h('li', 'Instalala: en Safari, Compartir → "Agregar a pantalla de inicio". Se abre a pantalla completa y funciona sin conexión.'),
        h('li', 'Con el Apple Pencil escribí directo sobre el texto: Scribble lo convierte en texto. En las hojas queda a mano.'),
        h('li', 'Al apoyar el lápiz por primera vez se activa "sólo lápiz": el dedo desplaza y la palma no raya.'),
        h('li', 'Mantené el lápiz quieto al terminar un trazo para convertirlo en línea recta.'),
        h('li', 'Grabá la clase con el micrófono: después tocá cualquier trazo para escuchar qué se decía en ese momento.')))));
}

// Los enlaces se abren en el navegador actual; una página no puede elegir otro.
// En iPad/iPhone sí se puede mandar a Safari con el esquema x-safari-https://.
const UA = navigator.userAgent;
const isIOS = () => /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function otherBrowser() {
  return /CriOS|FxiOS|EdgiOS|OPiOS|Chrome\/|Chromium|Firefox\/|Edg\//.test(UA);
}

async function copyLink(href, msg = 'Enlace copiado: pegalo en Safari') {
  try {
    await navigator.clipboard.writeText(href);
    toast(msg);
  } catch {
    window.prompt('Copiá este enlace y pegalo en Safari:', href);
  }
}

function safariLink(href, label) {
  const target = isIOS() && otherBrowser() ? href.replace(/^https:/, 'x-safari-https:') : href;
  return h('div.row.link-row',
    h('a.btn.small', { href: target, target: '_blank', rel: 'noopener' }, icon('campus'), label),
    h('button.btn.small.ghost', { type: 'button', onclick: () => copyLink(href) }, 'Copiar enlace'));
}
