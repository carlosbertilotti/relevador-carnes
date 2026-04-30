"""
Sistema de alertas activas.

Distinto del reporte programado: acá solo notificamos cuando hay variaciones
significativas (>= umbral_pct) entre el último relevamiento y el anterior.
Si no pasa nada interesante, no manda nada.

Casos de uso típicos:
- "el asado bajó 8% en Coto" → oportunidad de compra
- "el lomo subió 12% en RES" → ajustar expectativas

Las alertas van por email (si está configurado) y se imprimen en consola
con un link wa.me listo para reenviar.
"""
import logging
import smtplib
import urllib.parse
from collections import defaultdict
from datetime import datetime
from email.message import EmailMessage
from statistics import mean

import httpx

import config
from normalizador import corte_pretty
from storage import obtener_ultimo_relevamiento, obtener_relevamiento_anterior

log = logging.getLogger(__name__)


def _agrupar(precios):
    bucket = defaultdict(lambda: defaultdict(list))
    for p in precios:
        bucket[p["corte_normalizado"]][p["carniceria"]].append(p["precio_kg"])
    return {c: {k: mean(v) for k, v in d.items()} for c, d in bucket.items()}


def detectar_alertas(umbral_pct: float = 5.0) -> list[dict]:
    """
    Devuelve lista de alertas: [{carniceria, corte, precio_act, precio_ant, pct, tipo}].
    tipo es "suba" o "baja".
    """
    actual = obtener_ultimo_relevamiento()
    anterior = obtener_relevamiento_anterior()
    if not actual or not anterior:
        return []

    act = _agrupar(actual)
    ant = _agrupar(anterior)

    alertas = []
    for corte, carns in act.items():
        for carn, p_act in carns.items():
            p_ant = ant.get(corte, {}).get(carn)
            if not p_ant or p_ant <= 0:
                continue
            pct = (p_act - p_ant) / p_ant * 100
            if abs(pct) >= umbral_pct:
                alertas.append({
                    "carniceria": carn,
                    "corte": corte,
                    "precio_act": round(p_act, 2),
                    "precio_ant": round(p_ant, 2),
                    "pct": round(pct, 1),
                    "tipo": "suba" if pct > 0 else "baja",
                })
    alertas.sort(key=lambda a: abs(a["pct"]), reverse=True)
    return alertas


def formatear_alertas(alertas: list[dict], top: int = 15) -> str:
    if not alertas:
        return ""
    fecha = datetime.now().strftime("%d/%m/%Y")
    lineas = [f"🚨 *Alertas de precios — {fecha}*", ""]

    subas = [a for a in alertas if a["tipo"] == "suba"][:top]
    bajas = [a for a in alertas if a["tipo"] == "baja"][:top]

    if bajas:
        lineas.append("*🔻 Oportunidades (bajas):*")
        for a in bajas:
            lineas.append(
                f"• {a['carniceria']} — {corte_pretty(a['corte'])}: "
                f"${a['precio_act']:,.0f} ({a['pct']:+.1f}%)".replace(",", ".")
            )
        lineas.append("")

    if subas:
        lineas.append("*🔺 Subas:*")
        for a in subas:
            lineas.append(
                f"• {a['carniceria']} — {corte_pretty(a['corte'])}: "
                f"${a['precio_act']:,.0f} ({a['pct']:+.1f}%)".replace(",", ".")
            )

    return "\n".join(lineas)


def enviar_alerta_email(texto: str) -> bool:
    if not config.email_configurado():
        return False
    msg = EmailMessage()
    msg["Subject"] = f"🚨 Alertas de precios de carne — {datetime.now():%d/%m/%Y}"
    msg["From"] = config.EMAIL_FROM
    msg["To"] = config.EMAIL_TO
    if config.EMAIL_TO_CC:
        msg["Cc"] = config.EMAIL_TO_CC
    msg.set_content(texto + "\n\n--\nGenerado por relevador-carnes")
    try:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30) as s:
            s.starttls()
            s.login(config.SMTP_USER, config.SMTP_PASS)
            s.send_message(msg)
        log.info(f"📧 Alerta enviada a {config.EMAIL_TO}")
        return True
    except Exception as e:
        log.error(f"📧 Falló envío de alerta: {e}")
        return False


def enviar_telegram(texto: str) -> bool:
    """Envía mensaje al chat configurado vía Bot API. Soporta Markdown."""
    if not config.telegram_configurado():
        return False
    url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        r = httpx.post(url, data={
            "chat_id": config.TELEGRAM_CHAT_ID,
            "text": texto,
            "parse_mode": "Markdown",
            "disable_web_page_preview": "true",
        }, timeout=15)
        r.raise_for_status()
        log.info(f"📱 Telegram enviado a chat {config.TELEGRAM_CHAT_ID}")
        return True
    except Exception as e:
        log.error(f"📱 Falló Telegram: {e}")
        return False


def whatsapp_link_alerta(texto: str) -> str | None:
    if not config.whatsapp_configurado():
        return None
    return f"https://wa.me/{config.WHATSAPP_NUMERO}?text={urllib.parse.quote(texto)}"


def detectar_y_notificar_alertas(umbral_pct: float = 5.0) -> dict:
    alertas = detectar_alertas(umbral_pct)
    if not alertas:
        log.info("Sin alertas (todo dentro del umbral).")
        return {"cantidad": 0, "email_enviado": False, "wa_link": None}

    log.info(f"🚨 {len(alertas)} alertas detectadas (>= {umbral_pct}% de variación)")
    texto = formatear_alertas(alertas)
    email_ok = enviar_alerta_email(texto)
    telegram_ok = enviar_telegram(texto)
    wa_link = whatsapp_link_alerta(texto)
    if wa_link:
        log.info(f"   wa.me listo: {wa_link[:80]}...")
    return {
        "cantidad": len(alertas),
        "email_enviado": email_ok,
        "telegram_enviado": telegram_ok,
        "wa_link": wa_link,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    alertas = detectar_alertas(5.0)
    if alertas:
        print(formatear_alertas(alertas))
    else:
        print("Sin alertas (todo dentro del umbral 5%).")
