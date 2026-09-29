# Cuaderno

App para tomar notas de clase en el iPad con el Apple Pencil, sincronizada con el
**Campus Virtual Di Tella** (Moodle, `campusvirtual.utdt.edu`) y con tu calendario.

- **Una materia = un cuaderno.** Al conectar el campus se crea un cuaderno por cada
  materia en la que estás inscripto, y se baja todo su material (PDFs, presentaciones, etc.).
- **Una clase = una nota.** "Mi día" muestra las clases de hoy; un toque abre (o crea)
  la nota de esa clase con la fecha puesta.
- **Texto + lápiz en la misma nota.** Texto con formato como en Notas de Apple (título,
  encabezado, listas, checklist, tablas) y hojas para escribir a mano o anotar sobre
  las diapositivas del campus.
- **Calendario semanal** con tus clases, entregas y parciales del campus, y cualquier
  calendario iCal (Google, Outlook, el export del propio campus).
- **Materias cursando / pasadas / próximas**, como en "Mis cursos" del campus. El material de las pasadas se baja recién cuando lo abrís.
- **Abrir el material en Cuaderno**: PDFs y PowerPoint quedan como hojas para escribir encima; Word como texto editable. Lo que cambiás se guarda en la nota (el archivo del campus no se toca).
- **Resumen con IA por materia** (Claude): uno por clase y uno general con hoja de fórmulas en LaTeX. Se actualiza solo cuando cambian tus notas, incluyendo lo escrito a mano.
- Funciona **sin conexión**: todo vive en el dispositivo (IndexedDB).

## Lo que tomamos de cada app

| De… | Qué |
|---|---|
| **Notas de Apple** | Formato de texto (Título/Encabezado/Subencabezado/Cuerpo/Mono), checklist con círculos, tablas, notas fijadas, lista agrupada por mes, búsqueda. Con el lápiz sobre el texto funciona **Scribble** (se convierte en texto). |
| **GoodNotes** | Plantillas de hoja (rayada, cuadriculada, puntos, lisa), **lazo** para seleccionar/mover/recolorear/duplicar trazos, **mantener el lápiz quieto para hacer una línea recta**, "sólo lápiz" (el dedo desplaza, la palma no raya), anotar PDFs. |
| **Notability** | **Grabar la clase sincronizada con lo que escribís**: al reproducir, lo que todavía no se había escrito aparece tenue y tocando un trazo saltás a ese momento del audio. Hojas que crecen solas al escribir abajo. Velocidad 1×/1,5×/2×. |
| **Saber** (open source) | Resaltador que no se oscurece al superponerse, **modo oscuro que invierte las hojas** (tinta clara sobre fondo oscuro). |
| **Xournal++ / Rnote** | Trazos con presión y suavizado, goma de trazos enteros, exportar a PDF. |
| **Método Cornell** | Plantilla "Cornell": columna de preguntas, notas y resumen. |

## Cómo funciona la conexión con el campus

El campus de Di Tella es un Moodle, y la app oficial "Campus Virtual Di Tella" usa su
API de Web Services. Cuaderno usa esa misma API (`core_enrol_get_users_courses`,
`core_course_get_contents`, `core_calendar_get_calendar_events` y descarga de archivos
con token).

Como el navegador no puede hablar directo con el campus (CORS), hay un servidor
chiquito (`server/`) que hace de puente. **No guarda nada**: el token vive en tu
dispositivo y viaja en cada pedido. Tu contraseña no se guarda nunca.

Dos formas de conectarte:

1. **Usuario y contraseña** del campus.
2. **Si entrás con Google/Microsoft** (no tenés contraseña del campus): pegá tu
   *clave de seguridad* — en el campus, tu perfil → Preferencias → Claves de seguridad
   → "Moodle mobile web service". Si no te aparece, pedísela a la mesa de ayuda de Sistemas.

> Nota: el acceso por Web Services depende de que la universidad lo tenga habilitado
> (lo está, porque la app oficial lo usa), pero no lo pude probar contra el campus real
> desde acá. Está probado contra un Moodle simulado con las mismas respuestas
> (`test/mock-moodle.js`).

## Ponerla en marcha

Requiere Node 20+.

```bash
cd cuaderno
npm install
npm start            # http://localhost:5173
```

- Para ver la app con datos de ejemplo: `http://localhost:5173/?demo`
- Para probar la sincronización sin tu cuenta: `node test/mock-moodle.js` y en
  "Campus y calendarios" conectá a `http://localhost:5174` con usuario `alumno` / clave `clave`.

### Usarla en el iPad

El micrófono, el modo sin conexión y "Agregar a pantalla de inicio" necesitan **https**.
La app está preparada para **Vercel** (`vercel.json`, funciones en `api/`): proyecto con
directorio raíz `cuaderno`; cada push a `main` se publica solo.

También corre en cualquier hosting de Node con `npm install && npm start`.

Variables de entorno:

| Variable | Para qué |
|---|---|
| `APP_PASSWORD` | **Recomendado si la publicás.** La app la pide la primera vez que se conecta al servidor. |
| `MOODLE_ALLOWED_HOSTS` | Campus permitidos, ej. `campusvirtual.utdt.edu` (evita que el servidor sirva de proxy a otros sitios). |
| `ANTHROPIC_API_KEY` | Activa los resúmenes con IA (pestaña Resumen de cada materia). Opcional `CUADERNO_MODEL` (default `claude-opus-5-5`). |
| `MOODLE_URL` | Campus por defecto (default `https://campusvirtual.utdt.edu`). |
| `PORT` | Puerto del servidor local (default 5173). |

Después, en el iPad: Safari → abrir la URL → Compartir → **Agregar a pantalla de inicio**.

## Tests

```bash
npm test                 # servidor, API de Moodle, parser iCal
node test/e2e.mjs        # punta a punta en Chromium (requiere playwright)
```

## Estructura

```
server/server.js     servidor: sirve la app + puente al campus y a calendarios iCal
server/moodle.js     cliente de la API de Web Services de Moodle
api/                 funciones de Vercel (usan el mismo manejador que server.js)
web/js/app.js        navegación y barra lateral
web/js/store.js      modelo de datos (materias, notas, agenda)
web/js/campus.js     sincronización con el campus y descarga de material
web/js/editor/       editor de notas: texto, tinta (ink.js), PDFs, audio
web/js/views/        Mi día, calendario, materia, campus y ajustes
web/js/lib/ics.js    parser iCal con eventos recurrentes
test/                tests + Moodle simulado
```

## Pendientes / ideas

- Sincronizar las notas entre dispositivos (hoy viven en cada dispositivo; hay copia de
  seguridad exportable en Ajustes).
- Reconocimiento de escritura a mano dentro de las hojas para poder buscarla.
- Subir entregas al campus desde la app.
