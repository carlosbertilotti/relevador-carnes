"""
Análisis de precios con Claude (Anthropic API).

Lee el histórico desde SQLite, arma un resumen estadístico compacto
(promedios por corte/segmento, variaciones semanales, dispersión entre
carnicerías) y se lo manda a Claude para que devuelva un análisis en
lenguaje natural con tendencias y recomendaciones de compra.

Uso:
    from analisis_ia import analizar_precios
    print(analizar_precios(dias=30))
"""
from __future__ import annotations

import os
import json
import statistics
from collections import defaultdict
from datetime import datetime

from dotenv import load_dotenv
from anthropic import Anthropic

import storage

load_dotenv(override=True)

MODEL = "claude-opus-4-7"


def _get_api_key() -> str | None:
    """Lee la key de .env (local) o st.secrets (Streamlit Cloud)."""
    key = os.getenv("ANTHROPIC_API_KEY")
    if key:
        return key
    try:
        import streamlit as st
        return st.secrets.get("ANTHROPIC_API_KEY")
    except Exception:
        return None

SYSTEM_PROMPT = """Sos un analista de precios de carne vacuna en Argentina. Te paso un resumen \
estadístico de relevamientos diarios en supermercados (Carrefour, Día, Vea, La Anónima, \
ChangoMás, Toledo). Cada corte tiene un segmento: 'commodity' (cortes populares) o 'premium'.

Tu tarea: devolver un análisis breve, accionable, en castellano rioplatense, con esta estructura:

1. **Panorama general** (2-3 líneas): qué pasó con el precio promedio en el período.
2. **Cortes que más subieron / bajaron** (top 3 de cada uno, con %).
3. **Diferencia entre carnicerías**: dónde conviene comprar cada corte clave.
4. **Premium vs commodity**: cómo se movió la brecha.
5. **Recomendación**: qué cortes conviene comprar ahora y cuáles esperar.

Sé concreto: usá números reales del resumen, no generalidades. Si los datos son insuficientes \
para alguna sección, decilo en una línea y seguí. No inventes precios ni cortes que no estén \
en el resumen."""


def _resumen_estadistico(dias: int = 30) -> dict:
    """Construye un resumen compacto del histórico para mandarle a Claude."""
    historico = storage.historial_completo(dias=dias)
    if not historico:
        return {"error": "Sin datos en el período"}

    fechas = sorted({r["fecha"] for r in historico})
    fecha_ini, fecha_fin = fechas[0], fechas[-1]

    # Agrupar por corte
    por_corte: dict[str, list[dict]] = defaultdict(list)
    for r in historico:
        por_corte[r["corte_normalizado"]].append(r)

    cortes_resumen = []
    for corte, rows in por_corte.items():
        precios_fin = [r["precio_kg"] for r in rows if r["fecha"] == fecha_fin]
        precios_ini = [r["precio_kg"] for r in rows if r["fecha"] == fecha_ini]
        if not precios_fin or not precios_ini:
            continue
        prom_fin = statistics.mean(precios_fin)
        prom_ini = statistics.mean(precios_ini)
        var_pct = (prom_fin - prom_ini) / prom_ini * 100 if prom_ini else 0

        # Por carnicería en la última fecha
        por_carn = {r["carniceria"]: r["precio_kg"] for r in rows if r["fecha"] == fecha_fin}
        segmento = next((r["segmento"] for r in rows if r["segmento"]), "desconocido")

        cortes_resumen.append({
            "corte": corte,
            "segmento": segmento,
            "precio_prom_actual": round(prom_fin, 0),
            "precio_prom_inicial": round(prom_ini, 0),
            "variacion_pct": round(var_pct, 1),
            "min_carniceria": min(por_carn.items(), key=lambda x: x[1]) if por_carn else None,
            "max_carniceria": max(por_carn.items(), key=lambda x: x[1]) if por_carn else None,
            "dispersion_pct": round(
                (max(por_carn.values()) - min(por_carn.values())) / statistics.mean(por_carn.values()) * 100, 1
            ) if len(por_carn) > 1 else 0,
        })

    # Promedios por segmento
    seg_resumen = defaultdict(lambda: {"precios": [], "var": []})
    for c in cortes_resumen:
        seg_resumen[c["segmento"]]["precios"].append(c["precio_prom_actual"])
        seg_resumen[c["segmento"]]["var"].append(c["variacion_pct"])
    segmentos = {
        seg: {
            "precio_prom": round(statistics.mean(d["precios"]), 0),
            "variacion_prom_pct": round(statistics.mean(d["var"]), 1),
            "n_cortes": len(d["precios"]),
        }
        for seg, d in seg_resumen.items()
    }

    return {
        "periodo": {"desde": fecha_ini, "hasta": fecha_fin, "dias": len(fechas)},
        "carnicerias": sorted({r["carniceria"] for r in historico}),
        "cortes": sorted(cortes_resumen, key=lambda x: -abs(x["variacion_pct"])),
        "por_segmento": segmentos,
    }


def analizar_precios(dias: int = 30) -> str:
    """Genera un análisis en lenguaje natural de los precios de los últimos `dias`."""
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("Falta ANTHROPIC_API_KEY en .env o st.secrets")

    resumen = _resumen_estadistico(dias=dias)
    if "error" in resumen:
        return f"No hay datos suficientes: {resumen['error']}"

    client = Anthropic(api_key=api_key)

    response = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        thinking={"type": "adaptive"},
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": (
                    f"Analizá estos datos de precios (últimos {dias} días):\n\n"
                    f"```json\n{json.dumps(resumen, ensure_ascii=False, indent=2)}\n```"
                ),
            }
        ],
    )

    # Devuelvo solo el texto (los bloques de thinking quedan en response pero no se muestran)
    return "\n".join(b.text for b in response.content if b.type == "text")


if __name__ == "__main__":
    print(analizar_precios(dias=30))
