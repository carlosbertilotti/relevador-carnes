"""
Agente conversacional sobre precios de carne.

A diferencia de `analisis_ia.py` (que manda un resumen pre-cocinado),
acá Claude tiene tools para consultar la base SQLite por sí solo:
listar cortes, traer precios actuales, ver historial, comparar cadenas.

Uso:
    from agente_ia import responder_pregunta
    respuesta = responder_pregunta("¿cuál es el corte más barato hoy?", historial=[])
"""
from __future__ import annotations

import os
import json
import sqlite3
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from anthropic import Anthropic

from normalizador import SECCION, corte_pretty

load_dotenv(override=True)

# Premium = Trasero Noble (cortes nobles), según la categorización del usuario.
# Picaña (tapa_cuadril) se considera premium aunque esté en trasero_rueda por su precio.
PREMIUM = {
    "lomo", "entrana", "bife_ancho", "bife_angosto",
    "vacio", "matambre", "tapa_cuadril",
}

MODEL = "claude-opus-4-7"
DB_PATH = Path(__file__).parent / "data" / "precios.db"
MAX_TOOL_ITERATIONS = 8


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

SYSTEM_PROMPT = """Sos un asistente experto en precios de carne vacuna en Argentina. \
El usuario tiene una base SQLite con relevamientos diarios de supermercados \
(Carrefour, Día, Vea, La Anónima, ChangoMás, Toledo, etc.).

Categorización de cortes (4 secciones del despiece):
- **trasero_noble** (PREMIUM): lomo, entraña, bife ancho/ojo de bife, bife angosto/de chorizo, vacío, matambre.
- **trasero_rueda**: colita de cuadril, peceto, tapa de cuadril (picaña — también premium), cuadril, nalga, jamón cuadrado, pulpa de bocado, bola de lomo, tapa de nalga, bocado ancho, tortuguita, roast beef.
- **asado_costillar**: asado, tapa de asado, falda.
- **cuarto_delantero**: aguja, paleta, osobuco, brazuelo, cogote.

Tools disponibles:
- `listar_cortes`: ver qué cortes hay en la base
- `precios_actuales`: precios del último relevamiento (filtrable por corte)
- `comparar_cadenas`: comparar precio de un corte entre cadenas hoy
- `historial_corte`: serie histórica de un corte para detectar tendencias
- `precios_por_seccion`: todos los precios actuales de una sección (trasero_noble, trasero_rueda, asado_costillar, cuarto_delantero)
- `precios_premium`: precios actuales solo de cortes premium (trasero noble + picaña)
- `comparar_secciones`: promedio de precio por sección, útil para ver brechas premium vs commodity
- `ranking_cadenas_por_seccion`: cuál es la cadena más barata para cada sección

Reglas:
- Llamá las tools primero, después contestá. No inventes precios.
- Si el usuario pide "premium", usá `precios_premium` o filtrá por trasero_noble.
- Respondé en castellano rioplatense, breve y concreto, con números reales.
- Mostrá precios como $XX.XXX/kg (formato argentino con punto de miles).
- Si no hay datos para algo, decilo claro y seguí."""


# ─── Tools (acceso directo a la DB, sin pasar por storage.py para flexibilidad) ─

def _query(sql: str, params: tuple = ()) -> list[dict]:
    if not DB_PATH.exists():
        return []
    with sqlite3.connect(DB_PATH) as con:
        con.row_factory = sqlite3.Row
        cur = con.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def listar_cortes() -> dict:
    rows = _query(
        """
        SELECT corte_normalizado, segmento, COUNT(*) AS n_relevamientos
        FROM precios
        GROUP BY corte_normalizado, segmento
        ORDER BY n_relevamientos DESC
        """
    )
    return {"cortes": rows, "total": len(rows)}


def precios_actuales(corte: str | None = None) -> dict:
    sql = """
        SELECT carniceria, corte_normalizado, segmento, precio_kg, fecha
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
    """
    params: tuple = ()
    if corte:
        sql += " AND corte_normalizado = ?"
        params = (corte,)
    sql += " ORDER BY precio_kg"
    rows = _query(sql, params)
    return {"precios": rows, "n": len(rows)}


def comparar_cadenas(corte: str) -> dict:
    rows = _query(
        """
        SELECT carniceria, AVG(precio_kg) AS precio_kg
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
          AND corte_normalizado = ?
        GROUP BY carniceria
        ORDER BY precio_kg
        """,
        (corte,),
    )
    if not rows:
        return {"corte": corte, "comparacion": [], "mensaje": "No hay datos para ese corte"}
    precios = [r["precio_kg"] for r in rows]
    return {
        "corte": corte,
        "fecha": _query("SELECT MAX(fecha) AS f FROM precios")[0]["f"],
        "comparacion": rows,
        "min": min(precios),
        "max": max(precios),
        "diferencia_pct": round((max(precios) - min(precios)) / min(precios) * 100, 1),
    }


def historial_corte(corte: str, dias: int = 30) -> dict:
    rows = _query(
        """
        SELECT fecha, AVG(precio_kg) AS precio_prom_kg, COUNT(*) AS n_cadenas
        FROM precios
        WHERE corte_normalizado = ?
          AND fecha >= date('now', ?)
        GROUP BY fecha
        ORDER BY fecha
        """,
        (corte, f"-{dias} days"),
    )
    if len(rows) < 2:
        return {"corte": corte, "historia": rows, "mensaje": "Datos insuficientes para tendencia"}
    p_ini, p_fin = rows[0]["precio_prom_kg"], rows[-1]["precio_prom_kg"]
    return {
        "corte": corte,
        "dias_solicitados": dias,
        "historia": rows,
        "precio_inicial": round(p_ini, 0),
        "precio_actual": round(p_fin, 0),
        "variacion_pct": round((p_fin - p_ini) / p_ini * 100, 1) if p_ini else 0,
    }


def precios_por_seccion(seccion: str) -> dict:
    cortes = [c for c, s in SECCION.items() if s == seccion]
    if not cortes:
        return {"seccion": seccion, "error": f"Sección desconocida. Válidas: {sorted(set(SECCION.values()))}"}
    placeholders = ",".join("?" * len(cortes))
    rows = _query(
        f"""
        SELECT carniceria, corte_normalizado, AVG(precio_kg) AS precio_kg
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
          AND corte_normalizado IN ({placeholders})
        GROUP BY carniceria, corte_normalizado
        ORDER BY corte_normalizado, precio_kg
        """,
        tuple(cortes),
    )
    return {"seccion": seccion, "cortes_buscados": cortes, "precios": rows, "n": len(rows)}


def precios_premium() -> dict:
    placeholders = ",".join("?" * len(PREMIUM))
    rows = _query(
        f"""
        SELECT carniceria, corte_normalizado, AVG(precio_kg) AS precio_kg
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
          AND corte_normalizado IN ({placeholders})
        GROUP BY carniceria, corte_normalizado
        ORDER BY corte_normalizado, precio_kg
        """,
        tuple(PREMIUM),
    )
    # Promedio por corte y la cadena más barata para cada uno
    by_corte: dict[str, dict] = {}
    for r in rows:
        c = r["corte_normalizado"]
        by_corte.setdefault(c, {"corte": c, "ofertas": []})["ofertas"].append(
            {"carniceria": r["carniceria"], "precio_kg": r["precio_kg"]}
        )
    resumen = []
    for c, info in by_corte.items():
        precios = [o["precio_kg"] for o in info["ofertas"]]
        info["precio_min"] = round(min(precios), 0)
        info["precio_max"] = round(max(precios), 0)
        info["precio_prom"] = round(sum(precios) / len(precios), 0)
        info["mas_barata"] = min(info["ofertas"], key=lambda x: x["precio_kg"])["carniceria"]
        resumen.append(info)
    return {"cortes_premium": sorted(PREMIUM), "resumen": resumen, "n_cortes_con_datos": len(resumen)}


def comparar_secciones() -> dict:
    rows = _query(
        """
        SELECT carniceria, corte_normalizado, AVG(precio_kg) AS precio_kg
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
        GROUP BY carniceria, corte_normalizado
        """
    )
    by_seccion: dict[str, list[float]] = {}
    for r in rows:
        sec = SECCION.get(r["corte_normalizado"], "otra")
        by_seccion.setdefault(sec, []).append(r["precio_kg"])
    resumen = [
        {
            "seccion": sec,
            "precio_prom_kg": round(sum(p) / len(p), 0),
            "precio_min_kg": round(min(p), 0),
            "precio_max_kg": round(max(p), 0),
            "n_observaciones": len(p),
        }
        for sec, p in by_seccion.items()
    ]
    resumen.sort(key=lambda x: -x["precio_prom_kg"])
    return {"comparacion_por_seccion": resumen}


def ranking_cadenas_por_seccion() -> dict:
    rows = _query(
        """
        SELECT carniceria, corte_normalizado, AVG(precio_kg) AS precio_kg
        FROM precios
        WHERE fecha = (SELECT MAX(fecha) FROM precios)
        GROUP BY carniceria, corte_normalizado
        """
    )
    # carniceria → seccion → [precios]
    matriz: dict[str, dict[str, list[float]]] = {}
    for r in rows:
        sec = SECCION.get(r["corte_normalizado"], "otra")
        matriz.setdefault(r["carniceria"], {}).setdefault(sec, []).append(r["precio_kg"])

    secciones = sorted({s for d in matriz.values() for s in d})
    ranking_por_seccion = {}
    for sec in secciones:
        promedios = []
        for carn, secs in matriz.items():
            if sec in secs:
                p = secs[sec]
                promedios.append({"carniceria": carn, "precio_prom_kg": round(sum(p) / len(p), 0)})
        promedios.sort(key=lambda x: x["precio_prom_kg"])
        ranking_por_seccion[sec] = promedios

    return {"ranking_por_seccion": ranking_por_seccion}


TOOLS = [
    {
        "name": "listar_cortes",
        "description": "Lista todos los cortes únicos en la base con su segmento y cantidad de relevamientos.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "precios_actuales",
        "description": "Devuelve los precios del último relevamiento. Si pasás un corte, filtra solo ese.",
        "input_schema": {
            "type": "object",
            "properties": {
                "corte": {
                    "type": "string",
                    "description": "Nombre normalizado del corte (ej: 'asado', 'cuadril'). Opcional.",
                }
            },
            "required": [],
        },
    },
    {
        "name": "comparar_cadenas",
        "description": "Compara el precio de un corte específico entre todas las cadenas en el último relevamiento.",
        "input_schema": {
            "type": "object",
            "properties": {
                "corte": {"type": "string", "description": "Nombre normalizado del corte"},
            },
            "required": ["corte"],
        },
    },
    {
        "name": "historial_corte",
        "description": "Serie histórica de precios promedio diarios para un corte, para detectar tendencias.",
        "input_schema": {
            "type": "object",
            "properties": {
                "corte": {"type": "string", "description": "Nombre normalizado del corte"},
                "dias": {"type": "integer", "description": "Días hacia atrás. Default 30.", "default": 30},
            },
            "required": ["corte"],
        },
    },
    {
        "name": "precios_por_seccion",
        "description": "Trae los precios actuales de todos los cortes de una sección del despiece.",
        "input_schema": {
            "type": "object",
            "properties": {
                "seccion": {
                    "type": "string",
                    "description": "Nombre de la sección",
                    "enum": ["trasero_noble", "trasero_rueda", "asado_costillar", "cuarto_delantero", "picadas"],
                },
            },
            "required": ["seccion"],
        },
    },
    {
        "name": "precios_premium",
        "description": "Trae los precios actuales solo de cortes premium (trasero noble + picaña): lomo, entraña, bife ancho, bife angosto, vacío, matambre, tapa de cuadril. Devuelve por corte la cadena más barata, el rango de precios y el promedio.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "comparar_secciones",
        "description": "Devuelve el precio promedio actual por sección del despiece para ver la brecha premium vs commodity.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ranking_cadenas_por_seccion",
        "description": "Ranking de cadenas por sección: para cada sección, ordena las cadenas de la más barata a la más cara según promedio.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]

TOOL_FUNCS = {
    "listar_cortes": listar_cortes,
    "precios_actuales": precios_actuales,
    "comparar_cadenas": comparar_cadenas,
    "historial_corte": historial_corte,
    "precios_por_seccion": precios_por_seccion,
    "precios_premium": precios_premium,
    "comparar_secciones": comparar_secciones,
    "ranking_cadenas_por_seccion": ranking_cadenas_por_seccion,
}


# ─── Agent loop ────────────────────────────────────────────────────────────

def responder_pregunta(pregunta: str, historial: list[dict] | None = None) -> str:
    """Loop agéntico: Claude decide qué tools llamar, las ejecuta, y arma la respuesta."""
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("Falta ANTHROPIC_API_KEY en .env o st.secrets")

    client = Anthropic(api_key=api_key)

    # Convertir el historial del chat al formato API (filtrando el último user msg
    # que ya viene como `pregunta` y mensajes vacíos).
    messages: list[dict[str, Any]] = []
    if historial:
        for m in historial[:-1]:  # excluyo el último que es la pregunta actual
            if m.get("content"):
                messages.append({"role": m["role"], "content": m["content"]})

    messages.append({"role": "user", "content": pregunta})

    for _ in range(MAX_TOOL_ITERATIONS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason == "end_turn":
            return "\n".join(b.text for b in response.content if b.type == "text").strip()

        if response.stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": response.content})
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    fn = TOOL_FUNCS.get(block.name)
                    try:
                        result = fn(**block.input) if fn else {"error": f"Tool desconocida: {block.name}"}
                    except Exception as e:
                        result = {"error": str(e)}
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, ensure_ascii=False, default=str),
                    })
            messages.append({"role": "user", "content": tool_results})
            continue

        # Cualquier otro stop_reason (max_tokens, etc) → devolver lo que haya
        return "\n".join(b.text for b in response.content if b.type == "text").strip() or \
               f"(El modelo se detuvo: {response.stop_reason})"

    return "(Demasiadas iteraciones de tools — abortando)"


if __name__ == "__main__":
    print(responder_pregunta("¿cuál es el corte más barato hoy y dónde conviene comprarlo?"))
