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

load_dotenv(override=True)

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
(Carrefour, Día, Vea, La Anónima, ChangoMás, Toledo, etc.). Cada precio tiene corte, \
segmento (commodity/premium), carnicería, fecha y precio por kg en pesos argentinos.

Usá las tools disponibles para responder preguntas con datos reales:
- `listar_cortes`: ver qué cortes hay en la base
- `precios_actuales`: precios del último relevamiento (filtrable por corte)
- `comparar_cadenas`: comparar el precio de un corte entre todas las cadenas hoy
- `historial_corte`: serie histórica de precios de un corte para detectar tendencias

Reglas:
- Llamá las tools primero, después contestá. No inventes precios.
- Respondé en castellano rioplatense, breve y concreto, con números reales.
- Si el usuario pregunta algo que no se puede contestar con los datos, decilo.
- Mostrá precios siempre como $XX.XXX/kg (formato argentino con punto de miles)."""


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
]

TOOL_FUNCS = {
    "listar_cortes": listar_cortes,
    "precios_actuales": precios_actuales,
    "comparar_cadenas": comparar_cadenas,
    "historial_corte": historial_corte,
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
