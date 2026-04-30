# Relevador de precios de carne 🥩

Empleado virtual que releva precios de cortes vacunos en las principales
cadenas argentinas, los normaliza, calcula tendencias, dispara alertas
cuando hay movimientos bruscos y los expone en un dashboard interactivo.

**Versión 2.0** — arquitectura async, paralela, con health check, alertas
activas y dashboard en Streamlit.

---

## Carnicerías relevadas

| Cadena                    | Plataforma     | Segmento     |
|---------------------------|----------------|--------------|
| Coto                      | VTEX           | commodity    |
| Carrefour                 | VTEX           | commodity    |
| Día                       | VTEX           | commodity    |
| Vea                       | VTEX           | commodity    |
| ChangoMás                 | VTEX           | commodity    |
| La Anónima                | propia (HTML)  | commodity    |
| Jumbo                     | VTEX           | intermedio   |
| Disco                     | VTEX           | intermedio   |
| Ganadera Las Heras        | WooCommerce    | intermedio   |
| RES Tradición en Carnes   | HTML           | premium      |
| Josimar                   | WooCommerce    | premium      |
| Maxiconsumo               | VTEX           | mayorista    |
| **IPCVA (referencia)**    | HTML público   | benchmark    |
| Lo de Stéffano            | (template)     | premium      |

> **Lo de Stéffano** está como template — completar `scrapers/lo_de_steffano.py`
> con la URL real y descomentar la línea correspondiente en `run.py`.

## Cortes trackeados

asado, vacío, matambre, bife angosto, bife ancho, lomo, tapa de asado,
cuadril, colita de cuadril, peceto, osobuco, picada común, picada especial.

---

## Setup

```bash
python -m venv .venv
source .venv/bin/activate              # Mac/Linux
# .venv\Scripts\Activate.ps1           # Windows PowerShell
pip install -r requirements.txt
cp .env.example .env                   # editar con credenciales
```

## Uso diario

```bash
python run.py                          # corre los 13 scrapers en paralelo
streamlit run dashboard.py             # dashboard interactivo en localhost:8501
```

`run.py` hace todo en una sola corrida (~1 minuto vs ~5 min en v1):

1. Releva 13 carnicerías + IPCVA en paralelo (con reintentos automáticos)
2. Valida health check de cada scraper (avisa si devolvió pocos cortes)
3. Guarda en SQLite (histórico)
4. Genera 13+ gráficos de tendencia
5. Genera reporte MD + Excel + PDF
6. Detecta variaciones >5% y manda **alerta separada** del reporte
7. Manda email con todo adjunto
8. Imprime link `wa.me` listo para click

### Comandos útiles

```bash
python run.py --solo coto -v             # solo Coto, con logs detallados
python run.py --no-notif                 # generar reportes sin mandar nada
python run.py --no-graficos              # más rápido, sin tendencias
python run.py --no-alertas               # no detectar variaciones
python run.py --no-reportes              # solo relevar y guardar en BD
python run.py --concurrencia 4           # más conservador con la red

streamlit run dashboard.py               # dashboard
python alertas.py                        # ver alertas que se mandarían
python reporte.py                        # regenerar reportes desde la BD
python graficos.py                       # regenerar solo los gráficos
python notificaciones.py                 # ver qué se mandaría por WhatsApp
python normalizador.py                   # validar normalizador (debe dar 23/23)
python discover_vtex.py <url>            # descubrir IDs de categoría VTEX
```

---

## Dashboard

```bash
streamlit run dashboard.py
```

Abre `http://localhost:8501` con 5 vistas:

- **Heatmap actual** — matriz cadena × corte con la última corrida
- **Tendencia** — selector de corte, una línea por cadena, variación del período
- **Ranking por corte** — top 3 cadenas más baratas para cada corte
- **Alertas** — variaciones >5% vs el relevamiento anterior
- **Salud scrapers** — qué scrapers están sanos / sospechosos / fallando

Sidebar: filtro por segmento (commodity/intermedio/premium/mayorista/benchmark)
y rango de días.

### Deploy del dashboard

**Streamlit Community Cloud** (gratis, recomendado):
1. Pushear el repo a GitHub público
2. Ir a https://share.streamlit.io → conectar el repo
3. Apuntar al archivo `dashboard.py`
4. Listo: tenés un link público que se actualiza solo cuando GitHub Actions
   commitea la DB nueva

Alternativas: Render, Railway, Fly.io, VPS propio.

---

## Automatización con GitHub Actions

`.github/workflows/relevamiento.yml` corre el relevamiento martes y viernes
9:00 ART (12:00 UTC), commitea la DB y los reportes al repo, y sube los
reportes como artifact descargable por 30 días.

### Setup (una sola vez)

1. Pushear el repo a GitHub
2. En **Settings → Secrets and variables → Actions**, agregar los secrets:
   - `WHATSAPP_NUMERO` (opcional)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
   - `EMAIL_FROM`, `EMAIL_TO`, `EMAIL_TO_CC` (opcional)
3. En **Settings → Actions → General → Workflow permissions**, marcar
   "Read and write permissions" para que el bot pueda commitear

### Disparar manualmente

GitHub → pestaña **Actions** → "Relevamiento de precios" → **Run workflow**.

### Ver resultados

- DB actualizada → directamente en `data/precios.db` del repo
- Reportes → artifact en la corrida de Actions, o `reports/` del repo
- Dashboard → se redeploya solo en Streamlit Cloud al detectar el commit

---

## Configurar notificaciones

Editar `.env`:

### WhatsApp (link wa.me — gratis, 1 click)

```
WHATSAPP_NUMERO=5493515551234
```

Tu número en formato internacional sin "+" ni espacios.
Cuando termina la corrida, imprime un link `wa.me` con el resumen ya escrito.

### Email (SMTP — automático)

Para Gmail:
1. Habilitar verificación en 2 pasos
2. Generar app password en https://myaccount.google.com/apppasswords
3. Completar `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tuemail@gmail.com
SMTP_PASS=app password de 16 caracteres
EMAIL_FROM=tuemail@gmail.com
EMAIL_TO=tuemail@gmail.com
EMAIL_TO_CC=
```

El email del **reporte** lleva MD + Excel + PDF + 4 gráficos.
El email de **alertas** es separado y solo llega cuando hay variaciones >5%.

---

## Cuando algo deja de funcionar

### Health check automático

Cada scraper tiene `min_cortes_esperados`. Si devuelve menos, `run.py`
lo marca como **sospechoso** en consola, en el reporte y en el dashboard
(tab "Salud scrapers"). Eso casi siempre indica cambio de HTML.

### Un scraper VTEX devuelve 0 productos

```bash
python discover_vtex.py https://www.<sitio>.com.ar
```

Tomá el ID y actualizá `categoria_carne_id` en `scrapers/<sitio>.py`.

### La Anónima / RES devuelven 0

Cambiaron el HTML. Actualizar `SELECTORES` en el archivo del scraper.
El subagente puede hacerlo automáticamente — ver "Subagente de Claude Code".

### Las Heras / Josimar (WooCommerce) devuelve 0

Probable cambio del slug de la categoría. Visitar
`https://<dominio>/categoria-producto/` y actualizar `categoria_slug`.

### Email no se manda

- Verificar `.env` (¿app password correcta?)
- Probar: `python notificaciones.py`
- Verificar: `python -c "import config; print(config.email_configurado())"`

---

## Arquitectura

```
relevador-carnes/
├── .github/workflows/relevamiento.yml   # corrida programada en la nube
├── .streamlit/config.toml               # tema del dashboard
├── .claude/agents/relevador-precios.md  # subagente
├── scrapers/
│   ├── base.py                          # ScraperBase async + reintentos + health
│   ├── vtex_base.py                     # base API VTEX (paralelo)
│   ├── woocommerce_base.py              # base WC Store API
│   ├── coto / carrefour / jumbo / disco / dia / vea / changomas / maxiconsumo
│   ├── la_anonima / res                 # parsean HTML
│   ├── ganadera_las_heras / josimar     # WooCommerce
│   ├── ipcva.py                         # benchmark mayorista
│   └── lo_de_steffano.py                # template
├── data/precios.db                      # SQLite (commiteada por GitHub Actions)
├── reports/                             # md / xlsx / pdf / png
├── normalizador.py                      # nombres → cortes estándar
├── storage.py                           # SQLite + tabla corridas (health)
├── reporte.py                           # md + xlsx + pdf
├── graficos.py                          # tendencias matplotlib
├── notificaciones.py                    # wa.me + email del reporte
├── alertas.py                           # detección de variaciones >5%
├── dashboard.py                         # Streamlit
├── run.py                               # orquestador async
└── discover_vtex.py                     # helper IDs categorías
```

### Cambios v1 → v2

- Async + paralelo: `httpx.AsyncClient` con semáforo, scrapers corriendo
  juntos. ~5x más rápido.
- Reintentos exponenciales en errores transitorios (timeout, 5xx, conexión).
- Health check por scraper: si devuelve menos de N cortes, queda marcado
  como sospechoso.
- Schema BD ampliado: `peso_g`, `con_hueso`, `marca`, `disponible`. Tabla
  `corridas` para health histórico.
- 6 cadenas nuevas (Vea, ChangoMás, Maxiconsumo, Día Express, Josimar, IPCVA).
- Alertas activas separadas del reporte programado.
- Dashboard Streamlit con 5 vistas.
- GitHub Actions: corrida 2x/semana en la nube, commit automático de la DB.

---

## Subagente de Claude Code

El proyecto incluye `.claude/agents/relevador-precios.md`. Una vez que
instalaste Claude Code, desde la carpeta:

```bash
claude
```

Le hablás natural:

```
> Releva los precios de hoy
> El scraper de RES está fallando, fijate qué pasa
> Activá Lo de Stéffano, la URL es https://lodesteffano.com.ar
> Sumá los cortes entraña, aguja y nalga
> Mostrame el dashboard
```
