"""
Notificaciones: WhatsApp (link wa.me) + Email (SMTP).

WhatsApp:
  - No mandamos el mensaje automáticamente. Generamos un link wa.me que,
    cuando lo hacés click, abre WhatsApp Web/App con el resumen ya escrito.
  - Si querés envío 100% automático, requiere Twilio o similar (paga).

Email:
  - SMTP estándar. Adjunta MD + Excel + PDF + gráficos PNG (los principales).
  - Para Gmail: usar una "app password", no tu contraseña normal.
"""
import logging
import smtplib
import urllib.parse
from pathlib import Path
from email.message import EmailMessage
from datetime import datetime
from collections import defaultdict
from statistics import mean

import config
from normalizador import corte_pretty
from storage import obtener_ultimo_relevamiento, obtener_relevamiento_anterior

log = logging.getLogger(__name__)


# ─── Resumen para mensajes ───────────────────────────────────────────────

def _agrupar(precios):
    bucket = defaultdict(lambda: defaultdict(list))
    for p in precios:
        bucket[p["corte_normalizado"]][p["carniceria"]].append(p["precio_kg"])
    return {c: {k: mean(v) for k, v in d.items()} for c, d in bucket.items()}


def construir_resumen() -> str:
    """
    Texto plano de ~10 líneas con lo esencial:
    fecha, # cadenas, top variaciones, promedios por corte estrella.
    Pensado para entrar en un mensaje de WhatsApp.
    """
    actual = obtener_ultimo_relevamiento()
    anterior = obtener_relevamiento_anterior()

    if not actual:
        return "Sin datos para reportar."

    cadenas = sorted({p["carniceria"] for p in actual})
    agrup_act = _agrupar(actual)
    agrup_ant = _agrupar(anterior) if anterior else {}

    # Variaciones significativas
    variaciones = []
    for corte, carns in agrup_act.items():
        for carn, p_act in carns.items():
            p_ant = agrup_ant.get(corte, {}).get(carn)
            if p_ant and p_ant > 0:
                pct = (p_act - p_ant) / p_ant * 100
                if abs(pct) >= 5:
                    variaciones.append((carn, corte, pct))
    variaciones.sort(key=lambda x: abs(x[2]), reverse=True)

    fecha = datetime.now().strftime("%d/%m/%Y")
    lineas = [
        f"🥩 *Relevamiento de carnes — {fecha}*",
        "",
        f"✅ {len(cadenas)} cadenas: {', '.join(cadenas)}",
        f"📊 {len(agrup_act)} cortes, {len(actual)} productos",
        "",
    ]

    # Top 3 cortes más relevados, con promedio
    cortes_top = sorted(agrup_act.keys(),
                        key=lambda c: -len(agrup_act[c]))[:5]
    lineas.append("*Promedios principales ($/kg):*")
    for c in cortes_top:
        precios = list(agrup_act[c].values())
        prom = mean(precios)
        mn, mx = min(precios), max(precios)
        lineas.append(
            f"• {corte_pretty(c)}: ${prom:,.0f} (rango ${mn:,.0f}–${mx:,.0f})".replace(",", ".")
        )

    # Variaciones destacadas
    if variaciones:
        lineas.append("")
        lineas.append("*Variaciones >5% vs anterior:*")
        for carn, corte, pct in variaciones[:5]:
            flecha = "🔺" if pct > 0 else "🔻"
            lineas.append(f"{flecha} {carn} — {corte_pretty(corte)}: {pct:+.1f}%")

    return "\n".join(lineas)


# ─── WhatsApp (link wa.me) ───────────────────────────────────────────────

def whatsapp_link(numero: str | None = None, texto: str | None = None) -> str:
    """
    Construye un link wa.me que abre WhatsApp con el mensaje pre-cargado.
    Cuando hagas click, solo tenés que tocar 'enviar'.
    """
    n = numero or config.WHATSAPP_NUMERO
    if not n:
        raise ValueError("WHATSAPP_NUMERO no configurado en .env")
    t = texto if texto is not None else construir_resumen()
    return f"https://wa.me/{n}?text={urllib.parse.quote(t)}"


# ─── Email (SMTP) ────────────────────────────────────────────────────────

def enviar_email(paths_reportes: dict[str, Path],
                 paths_graficos: dict[str, Path] | None = None,
                 asunto: str | None = None) -> bool:
    """
    Manda email con resumen en el cuerpo + adjuntos:
      - reporte .md
      - reporte .xlsx
      - reporte .pdf
      - gráficos PNG (los primeros 4 más relevantes)
    """
    if not config.email_configurado():
        log.warning("Email no enviado: SMTP no configurado en .env")
        return False

    paths_graficos = paths_graficos or {}

    msg = EmailMessage()
    fecha = datetime.now().strftime("%d/%m/%Y")
    msg["Subject"] = asunto or f"Relevamiento de carnes — {fecha}"
    msg["From"] = config.EMAIL_FROM
    msg["To"] = config.EMAIL_TO
    if config.EMAIL_TO_CC:
        msg["Cc"] = config.EMAIL_TO_CC

    cuerpo_txt = construir_resumen() + "\n\n" + (
        "Adjunto:\n"
        f"• Reporte detallado en Markdown ({paths_reportes['md'].name})\n"
        f"• Tabla comparativa en Excel ({paths_reportes['xlsx'].name})\n"
        f"• Reporte para imprimir en PDF ({paths_reportes['pdf'].name})\n"
    )
    if paths_graficos:
        cuerpo_txt += f"• {len(paths_graficos)} gráficos de tendencia (PNG)\n"

    cuerpo_txt += "\n--\nGenerado automáticamente por relevador-carnes."
    msg.set_content(cuerpo_txt)

    # Adjuntar reportes
    mime_map = {
        ".md":   ("text", "markdown"),
        ".xlsx": ("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ".pdf":  ("application", "pdf"),
        ".png":  ("image", "png"),
    }

    for path in [paths_reportes.get("md"), paths_reportes.get("xlsx"),
                 paths_reportes.get("pdf")]:
        if path and path.exists():
            mtype = mime_map.get(path.suffix, ("application", "octet-stream"))
            with open(path, "rb") as f:
                msg.add_attachment(f.read(), maintype=mtype[0], subtype=mtype[1],
                                   filename=path.name)

    # Adjuntar hasta 4 gráficos (no saturar el mail)
    for i, (corte, path) in enumerate(list(paths_graficos.items())[:4]):
        if path.exists():
            with open(path, "rb") as f:
                msg.add_attachment(f.read(), maintype="image", subtype="png",
                                   filename=path.name)

    # Enviar
    try:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30) as s:
            s.starttls()
            s.login(config.SMTP_USER, config.SMTP_PASS)
            s.send_message(msg)
        log.info(f"📧 Email enviado a {config.EMAIL_TO}")
        return True
    except Exception as e:
        log.error(f"📧 Falló envío de email: {e}")
        return False


# ─── Función todo-en-uno ─────────────────────────────────────────────────

def notificar_todo(paths_reportes: dict[str, Path],
                   paths_graficos: dict[str, Path] | None = None) -> dict:
    """Notifica por email y devuelve link de WhatsApp para que el usuario haga click."""
    resultado = {"email_enviado": False, "wa_link": None}

    if config.email_configurado():
        resultado["email_enviado"] = enviar_email(paths_reportes, paths_graficos)
    else:
        log.info("📧 Email omitido: configurar SMTP_* en .env para activar")

    if config.whatsapp_configurado():
        try:
            resultado["wa_link"] = whatsapp_link()
            log.info(f"📱 Link WhatsApp listo (hacé click para enviar):")
            log.info(f"   {resultado['wa_link']}")
        except Exception as e:
            log.error(f"📱 Falló armado de link WA: {e}")
    else:
        log.info("📱 WhatsApp omitido: configurar WHATSAPP_NUMERO en .env para activar")

    return resultado


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print("=" * 60)
    print("RESUMEN QUE SE ENVIARÍA POR WHATSAPP/EMAIL:")
    print("=" * 60)
    print(construir_resumen())
    print("=" * 60)
    if config.whatsapp_configurado():
        print("\nLink WhatsApp:")
        print(whatsapp_link())
