"""Medidor + freno del gasto de la API de Anthropic para el relevador (16/11/2026).

Hay un tope de USD 20 por mes para todas las apps de Carlos. Cada llamada a Claude deja una fila en la tabla api_uso de
la base Midia y, antes de llamar, pregunta (función api_freno_permite) si esta app puede gastar ahora. Es la misma lógica
que cartera-app/compartido/apiUso/apiUso.mjs.

Uso:  client = medir_cliente("analisis_precios", Anthropic(api_key=...))   # el resto del código queda igual
Necesita MIDIA_SUPABASE_URL y MIDIA_SUPABASE_SERVICE_KEY en el entorno (o en st.secrets); sin ellas no hace nada.
Nunca rompe la llamada: sin claves, sin red o sin tabla sigue como si no estuviera. Solo números, nunca el texto.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

APP = "relevador-carnes"

# USD por millón de tokens (entrada, salida, escritura de caché 5 min, lectura de caché).
PRECIOS = {
    "claude-opus-5-5": (4, 20, 5, 0.20),
    "claude-sonnet-5-5": (2, 10, 2.5, 0.10),
    "claude-haiku-5-5": (0.10, 0.50, 0.125, 0.01),
    "claude-opus-4-8": (5, 25, 6.25, 0.50),
    "claude-opus-4-7": (5, 25, 6.25, 0.50),
    "claude-sonnet-4-6": (3, 15, 3.75, 0.30),
    "claude-haiku-4-5": (1, 5, 1.25, 0.10),
}


class FrenoApi(RuntimeError):
    """La función está apagada por el tope de la API de este mes."""


def _secreto(nombre: str) -> str:
    v = os.getenv(nombre)
    if v:
        return v.strip()
    try:
        import streamlit as st
        return str(st.secrets.get(nombre) or "").strip()
    except Exception:
        return ""


def _post(ruta: str, cuerpo: dict):
    url, clave = _secreto("MIDIA_SUPABASE_URL"), _secreto("MIDIA_SUPABASE_SERVICE_KEY")
    if not url or not clave:
        return None
    req = urllib.request.Request(
        f"{url}/rest/v1/{ruta}", data=json.dumps(cuerpo).encode(), method="POST",
        headers={"apikey": clave, "Authorization": f"Bearer {clave}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=4) as r:
        t = r.read().decode() or "null"
        return json.loads(t)


def _n(x) -> int:
    try:
        return max(0, int(x or 0))
    except Exception:
        return 0


def costo_usd(modelo: str, uso) -> float | None:
    import re
    p = PRECIOS.get(re.sub(r"-\d{8}$", "", str(modelo or "").strip().lower()))
    if not p:
        return None
    if uso is None:
        return 0.0
    g = lambda k: _n(getattr(uso, k, None))
    return round((g("input_tokens") * p[0] + g("output_tokens") * p[1] + g("cache_creation_input_tokens") * p[2] + g("cache_read_input_tokens") * p[3]) / 1e6, 6)


def anotar_uso(funcion: str, modelo: str, uso, ms: int | None, ok: bool = True) -> None:
    try:
        g = lambda k: _n(getattr(uso, k, None)) if uso is not None else 0
        _post("api_uso", {
            "app": APP, "funcion": str(funcion)[:60], "modelo": str(modelo or "?")[:60],
            "input_tokens": g("input_tokens"), "output_tokens": g("output_tokens"),
            "cache_read": g("cache_read_input_tokens"), "cache_write": g("cache_creation_input_tokens"),
            "busquedas": 0, "usd": costo_usd(modelo, uso), "ms": ms, "ok": ok, "lote": False,
        })
    except Exception:
        pass  # la fila se pierde; la llamada a Claude no se entera


def frenado(funcion: str) -> bool:
    """True = apagado por el tope del mes. Sin poder leer la base: False (sigue como siempre)."""
    try:
        j = _post("rpc/api_freno_permite", {"p_app": APP, "p_funcion": funcion})
        return bool(j) and j.get("permite") is False
    except Exception:
        return False


def medir_cliente(funcion: str, client):
    """Envuelve client.messages.create: pregunta al freno y anota el uso. Devuelve el mismo cliente."""
    try:
        original = client.messages.create
        if getattr(original, "_medido", False):
            return client

        def create(*args, **kwargs):
            if kwargs.get("stream"):
                return original(*args, **kwargs)
            if frenado(funcion):
                raise FrenoApi(f"{funcion}: apagada por el tope de la API de este mes")
            t0 = time.time()
            try:
                r = original(*args, **kwargs)
            except Exception:
                anotar_uso(funcion, kwargs.get("model", "?"), None, int((time.time() - t0) * 1000), False)
                raise
            anotar_uso(funcion, getattr(r, "model", None) or kwargs.get("model", "?"), getattr(r, "usage", None), int((time.time() - t0) * 1000), True)
            return r

        create._medido = True
        client.messages.create = create
    except Exception:
        pass
    return client
