"""
Resumen completo de precios por WhatsApp (bot de cartera-app).

Manda la lista de precios del último relevamiento, agrupada por sección
de la media res, al WhatsApp de Carlos vía el endpoint del bot:
    POST https://cartera-app.vercel.app/api/whatsapp/send
    Authorization: Bearer <WHATSAPP_SEND_KEY>

La clave se lee de la env var WHATSAPP_SEND_KEY (en GitHub Actions viene
de Secrets; local, del .env o del .env.local de cartera-app como fallback).

Uso suelto:
    python wa_resumen.py          # arma y manda el resumen del último relevamiento
    python wa_resumen.py --dry    # solo imprime, no manda
"""
import logging
import os
import sqlite3
from collections import defaultdict
from pathlib import Path

import httpx

from normalizador import corte_pretty, SECCION
from storage import DB_PATH

log = logging.getLogger(__name__)

WA_ENDPOINT = "https://cartera-app.vercel.app/api/whatsapp/send"

SECCIONES_ORDEN = [
    ("trasero_noble", "🥩 TRASERO NOBLE"),
    ("trasero_rueda", "🍖 TRASERO RUEDA"),
    ("asado_costillar", "🔥 ASADO / COSTILLAR"),
    ("cuarto_delantero", "💪 CUARTO DELANTERO"),
    ("picadas", "🥓 PICADAS"),
]


def _wa_key() -> str | None:
    key = os.getenv("WHATSAPP_SEND_KEY")
    if key:
        return key
    # Fallback local: leer del .env.local de cartera-app
    env_local = Path.home() / "Downloads" / "cartera-app" / ".env.local"
    if env_local.exists():
        for line in env_local.read_text().splitlines():
            if line.startswith("WHATSAPP_SEND_KEY="):
                return line.split("=", 1)[1].strip()
    return None


def _fmt(v: float) -> str:
    return f"${v:,.0f}".replace(",", ".")


def construir_resumen() -> str:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT corte_normalizado, carniceria, AVG(precio_kg) p
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
          AND segmento != 'benchmark'
        GROUP BY corte_normalizado, carniceria
    """).fetchall()
    bench = {r["corte_normalizado"]: r["p"] for r in con.execute("""
        SELECT corte_normalizado, AVG(precio_kg) p FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios) AND segmento='benchmark'
        GROUP BY corte_normalizado
    """)}
    fecha = con.execute("SELECT MAX(fecha) FROM precios").fetchone()[0]
    con.close()

    if not rows:
        return ""

    por_corte: dict[str, dict[str, float]] = defaultdict(dict)
    for r in rows:
        por_corte[r["corte_normalizado"]][r["carniceria"]] = r["p"]

    n_cadenas = len({r["carniceria"] for r in rows})
    out = (f"🥩 *RELEVAMIENTO DE CARNES — {fecha}*\n"
           f"{len(rows)} precios · {n_cadenas} cadenas · {len(por_corte)} cortes\n")

    for sec_key, sec_titulo in SECCIONES_ORDEN:
        cortes_sec = sorted(c for c in por_corte if SECCION.get(c) == sec_key)
        if not cortes_sec:
            continue
        out += f"\n{sec_titulo}\n"
        for corte in cortes_sec:
            precios = por_corte[corte]
            barato = min(precios, key=precios.get)
            out += f"\n*{corte_pretty(corte)}*\n"
            for carn, p in sorted(precios.items(), key=lambda x: x[1]):
                marca = " 🏆" if carn == barato else ""
                out += f"  {carn}: {_fmt(p)}{marca}\n"
            if corte in bench:
                out += f"  _INDEC ref: {_fmt(bench[corte])}_\n"

    out += "\n_Dashboard: relevador-carnes.streamlit.app_"
    return out


def enviar_whatsapp(texto: str) -> bool:
    key = _wa_key()
    if not key:
        log.warning("📱 WhatsApp omitido: WHATSAPP_SEND_KEY no configurada")
        return False
    try:
        r = httpx.post(
            WA_ENDPOINT,
            headers={"Authorization": f"Bearer {key}"},
            json={"text": texto},
            timeout=30,
        )
        r.raise_for_status()
        log.info("📱 Resumen enviado al WhatsApp")
        return True
    except Exception as e:
        log.error(f"📱 Falló envío WhatsApp: {e}")
        return False


def enviar_resumen_whatsapp() -> bool:
    texto = construir_resumen()
    if not texto:
        log.warning("Sin datos para el resumen de WhatsApp")
        return False
    return enviar_whatsapp(texto)


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    texto = construir_resumen()
    if "--dry" in sys.argv:
        print(texto)
    else:
        ok = enviar_whatsapp(texto)
        print("✅ Enviado" if ok else "❌ Falló")
