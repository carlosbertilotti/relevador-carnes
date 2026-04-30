# Deploy del dashboard a Streamlit Cloud (gratis)

Después de seguir estos pasos vas a tener una URL pública tipo
`https://relevador-carnes.streamlit.app` que se actualiza sola cuando
GitHub Actions corre el relevamiento.

## Paso 1 — Subir el repo a GitHub (5 min)

Si todavía no tenés el proyecto en GitHub:

```bash
cd /Users/carlosbertilotti/Downloads/relevador-carnes

# Inicializar git si no está
git init
git add .
git commit -m "Relevador de carnes v2"

# Crear repo en GitHub.com (botón "New repository") y conectar:
git remote add origin https://github.com/TU_USUARIO/relevador-carnes.git
git branch -M main
git push -u origin main
```

> **IMPORTANTE**: el `.gitignore` ya excluye `.env` (donde van tus passwords).
> Si lo creaste, verificá que NO se commiteó.

## Paso 2 — Configurar GitHub Secrets (2 min)

En tu repo en GitHub: **Settings → Secrets and variables → Actions → New repository secret**

Agregá uno por uno (los que uses):

| Nombre | Valor |
|---|---|
| `SMTP_HOST` | smtp.gmail.com |
| `SMTP_PORT` | 587 |
| `SMTP_USER` | tuemail@gmail.com |
| `SMTP_PASS` | (app password de Gmail) |
| `EMAIL_FROM` | tuemail@gmail.com |
| `EMAIL_TO` | tuemail@gmail.com |
| `TELEGRAM_BOT_TOKEN` | (token del @BotFather) |
| `TELEGRAM_CHAT_ID` | (tu chat id de Telegram) |
| `WHATSAPP_NUMERO` | 5493515551234 |

## Paso 3 — Habilitar GitHub Actions (30 seg)

En **Settings → Actions → General → Workflow permissions**: marcá **"Read and write permissions"** y guardá.

Esto le da permiso al bot de Actions para commitear la DB actualizada.

## Paso 4 — Deploy a Streamlit Cloud (3 min)

1. Andá a https://share.streamlit.io
2. **Sign in with GitHub** (con tu cuenta)
3. Click **"Create app"**
4. Completá:
   - **Repository**: tu `usuario/relevador-carnes`
   - **Branch**: `main`
   - **Main file path**: `dashboard.py`
   - **App URL** (opcional): `relevador-carnes` → te queda `relevador-carnes.streamlit.app`
5. **Advanced settings** → **Secrets**: pegá las mismas variables que en GitHub Secrets, en formato TOML:

```toml
TELEGRAM_BOT_TOKEN = "..."
TELEGRAM_CHAT_ID = "..."
SMTP_USER = "..."
SMTP_PASS = "..."
EMAIL_TO = "..."
```

6. Click **"Deploy!"** → espera 2 minutos → te abre la URL pública

## ✅ Listo, tenés:

- URL pública del dashboard accesible desde cualquier celular/compu
- GitHub Actions corriendo el relevamiento martes y viernes 9 AM
- DB commiteada al repo automáticamente
- Streamlit Cloud detecta el commit y refresca el dashboard solo
- Alertas por Telegram al celular en cada corrida con variación >5%

## Tips

- **Disparar manualmente**: en GitHub → Actions → "Relevamiento de precios" → Run workflow
- **Ver logs**: en GitHub Actions, click sobre la corrida
- **Cambiar horario del cron**: editar `.github/workflows/relevamiento.yml`
- **El botón "Relevar ahora" del dashboard NO funciona en la versión cloud**
  (Streamlit Cloud no permite scraping pesado). Usá GitHub Actions o tu compu local.

## Configurar Telegram (push al celular)

1. En Telegram, buscá **@BotFather** → `/newbot` → seguir instrucciones → te da un **TOKEN**
2. Buscá tu bot por el username que pusiste → mandale `/start`
3. En el navegador, andá a: `https://api.telegram.org/bot<TU_TOKEN>/getUpdates`
4. En la respuesta JSON, buscá `"chat":{"id": NUMERO` → ese **NUMERO** es tu chat_id
5. Pegá ambos en `.env` (local) y en GitHub Secrets / Streamlit Secrets (cloud):

```
TELEGRAM_BOT_TOKEN=1234567890:AAFXX...
TELEGRAM_CHAT_ID=987654321
```

6. Probá: `python alertas.py` (te debería mandar un test al Telegram si hay alertas)
