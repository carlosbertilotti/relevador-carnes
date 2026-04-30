"""
Configuración de notificaciones.

Para no commitear datos sensibles, este archivo lee variables de entorno.
Copiar .env.example a .env y completar.

Cargar el .env automáticamente:
    pip install python-dotenv     # opcional
    # luego en config.py:
    from dotenv import load_dotenv; load_dotenv()
"""
import os

# ─── WhatsApp (link wa.me) ────────────────────────────────────────────────
# Tu número en formato internacional sin "+" ni espacios. Ej: 5493515551234
# (54 = código país AR, 9 = celular, 3515551234 = número)
WHATSAPP_NUMERO = os.getenv("WHATSAPP_NUMERO", "")

# ─── Email (SMTP) ─────────────────────────────────────────────────────────
# Para Gmail: necesitás una "app password" (no tu contraseña normal).
# Generar en: https://myaccount.google.com/apppasswords
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT") or "587")
SMTP_USER = os.getenv("SMTP_USER", "")          # tu email
SMTP_PASS = os.getenv("SMTP_PASS", "")          # app password de Gmail
EMAIL_FROM = os.getenv("EMAIL_FROM", SMTP_USER)
EMAIL_TO = os.getenv("EMAIL_TO", "")            # destinatario (puede ser vos mismo)
EMAIL_TO_CC = os.getenv("EMAIL_TO_CC", "")      # opcional, copiar a otros

# ─── Telegram (push al celular) ───────────────────────────────────────────
# 1. Crear bot con @BotFather en Telegram → te da TELEGRAM_BOT_TOKEN
# 2. Mandarle un mensaje al bot para activarlo
# 3. Visitar https://api.telegram.org/bot<TOKEN>/getUpdates → tomar tu chat.id
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")


# ─── Helpers ──────────────────────────────────────────────────────────────

def whatsapp_configurado() -> bool:
    return bool(WHATSAPP_NUMERO)

def email_configurado() -> bool:
    return all([SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_TO])

def telegram_configurado() -> bool:
    return bool(TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
