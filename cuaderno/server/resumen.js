// Resúmenes de estudio con IA (Claude). Dos pasos:
//  - "nota": resume una clase a partir de lo tipeado, el texto de las
//    diapositivas/PDF y las hojas escritas a mano (se mandan como imágenes).
//  - "materia": junta los resúmenes de todas las clases en un resumen general
//    de la materia, con hoja de fórmulas.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CUADERNO_MODEL || 'claude-opus-5-5';
const MAX_IMAGES = 12;
const MAX_IMAGE_B64 = 1_500_000;
const MAX_TEXT = 60_000;

let client;
const fail = (status, message) => Object.assign(new Error(message), { status });

const SYSTEM = `Sos un asistente de estudio para un alumno universitario de la Universidad Torcuato Di Tella (Argentina). Trabajás con sus apuntes de clase: texto tipeado, texto de diapositivas o PDFs del campus y fotos de hojas escritas a mano con Apple Pencil.

Escribí siempre en español rioplatense, claro y directo, en Markdown.

Fórmulas: escribilas siempre en LaTeX, en línea con $...$ y destacadas con $$...$$ en su propio renglón. Después de cada fórmula destacada explicá qué significa cada variable y cuándo se usa. No uses el signo $ para montos de dinero (escribí "ARS 100" o "USD 100").

Sé fiel a los apuntes: no inventes contenido que no esté. Si agregás una aclaración propia que ayuda a entender, marcala con "💡". Si algo escrito a mano no se entiende, poné "(ilegible)" en vez de adivinar.`;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw fail(503, 'Los resúmenes con IA no están configurados: falta ANTHROPIC_API_KEY en el servidor.');
  }
  client ||= new Anthropic();
  return client;
}

const clip = (s, n = MAX_TEXT) => String(s || '').slice(0, n);

function notePrompt({ materia, nota }) {
  const content = [];
  const imgs = (nota.imagenes || []).slice(0, MAX_IMAGES);
  imgs.forEach((img, i) => {
    if (!img?.data || img.data.length > MAX_IMAGE_B64) return;
    content.push({ type: 'text', text: `Hoja ${i + 1}${img.etiqueta ? ` (${clip(img.etiqueta, 200)})` : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data } });
  });
  content.push({
    type: 'text',
    text: `Materia: ${clip(materia, 200)}
Clase: ${clip(nota.titulo, 300)} (${clip(nota.fecha, 40)})

Texto de los apuntes y del material:
"""
${clip(nota.texto) || '(sin texto tipeado)'}
"""

${imgs.length ? `Arriba están las ${imgs.length} hoja(s) escritas a mano o anotadas de esta clase. Leé también lo manuscrito y las fórmulas.` : ''}

Hacé el resumen de estudio de ESTA clase con estas secciones (omití las que queden vacías):
## Ideas clave
## Definiciones
## Fórmulas
## Ejemplos y ejercicios
## Dudas y para repasar
Sé conciso: lo esencial para estudiar para el parcial.`,
  });
  return content;
}

function subjectPrompt({ materia, notas }) {
  const clases = (notas || []).slice(0, 200).map((n) => `### ${clip(n.titulo, 300)} (${clip(n.fecha, 40)})\n${clip(n.resumen, 12_000)}`).join('\n\n');
  return [{
    type: 'text',
    text: `Materia: ${clip(materia, 200)}

Estos son los resúmenes de cada clase, en orden:

${clip(clases, 400_000)}

Armá el resumen general de la materia para estudiar, con estas secciones (omití las vacías):
## Mapa de temas
(lista corta de los grandes temas y cómo se conectan)
## Temas
(organizado por tema, no por fecha; integrá lo de todas las clases)
## Hoja de fórmulas
(todas las fórmulas agrupadas por tema, en $$...$$, con el significado de cada variable)
## Definiciones clave
## Para repasar
(dudas, ejercicios y temas flojos)
## Clase por clase
(una o dos líneas por clase, con su fecha)`,
  }];
}

export async function resumir(body) {
  const mode = body.mode;
  let content;
  if (mode === 'nota') {
    if (!body.nota) throw fail(400, 'Falta la nota');
    content = notePrompt(body);
  } else if (mode === 'materia') {
    if (!Array.isArray(body.notas) || !body.notas.length) throw fail(400, 'No hay resúmenes de clases para combinar');
    content = subjectPrompt(body);
  } else {
    throw fail(400, 'Modo de resumen desconocido');
  }

  const anthropic = getClient();
  let msg;
  try {
    // Streaming evita cortes por tiempo en respuestas largas; finalMessage() junta todo.
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
    msg = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw fail(503, 'La clave de la API de Claude (ANTHROPIC_API_KEY) no es válida.');
    if (err instanceof Anthropic.RateLimitError) throw fail(429, 'Demasiados resúmenes seguidos: probá de nuevo en un minuto.');
    if (err instanceof Anthropic.BadRequestError) throw fail(400, `Claude rechazó el pedido: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw fail(502, `Error de la API de Claude (${err.status ?? 'sin estado'}): ${err.message}`);
    throw err;
  }

  if (msg.stop_reason === 'refusal') throw fail(422, 'Claude no pudo resumir este contenido.');
  const markdown = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!markdown) throw fail(502, 'El resumen vino vacío.');
  return { markdown, model: msg.model, truncated: msg.stop_reason === 'max_tokens' };
}
