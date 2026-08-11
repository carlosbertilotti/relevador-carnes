"""
Precios propios de El Quebrachal Carnes (EQ Carnes).

No scrapea ningún sitio: lee la tabla `carnes_precios` de Supabase (Midia),
la misma que usa la app de stock de carnes. Así el comparativo diario
muestra dónde está parado EQ contra cada cadena.

Credenciales por env vars (en GitHub Actions ya están como secrets):
    SUPABASE_URL          → https://<ref>.supabase.co
    SUPABASE_SERVICE_KEY  → service role key (o anon si la tabla lo permite)

Fallback local: las lee del .env.local de cartera-app.
"""
import logging
import os
from datetime import datetime
from pathlib import Path

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


def _creds() -> tuple[str, str] | None:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if url and key:
        return url.rstrip("/"), key
    # Fallback local: cartera-app usa el mismo proyecto Midia
    env_local = Path.home() / "Downloads" / "cartera-app" / ".env.local"
    if env_local.exists():
        vals = {}
        for line in env_local.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip()
        url = (vals.get("MIDIA_SUPABASE_URL")
               or vals.get("SUPABASE_URL")
               or vals.get("NEXT_PUBLIC_SUPABASE_URL"))
        key = (vals.get("MIDIA_SUPABASE_SERVICE_KEY")
               or vals.get("SUPABASE_SERVICE_KEY")
               or vals.get("SUPABASE_SERVICE_ROLE_KEY")
               or vals.get("NEXT_PUBLIC_SUPABASE_ANON_KEY"))
        if url and key:
            return url.rstrip("/"), key
    return None


class EqCarnesScraper(ScraperBase):
    nombre = "EQ Carnes 🏠"
    segmento = "propio"
    base_url = ""   # se setea desde creds
    min_cortes_esperados = 10
    timeout = 20.0
    delay_range = (0.1, 0.2)

    async def relevar(self) -> list[PrecioRelevado]:
        creds = _creds()
        if not creds:
            raise ScraperError(
                "EQ Carnes: faltan SUPABASE_URL / SUPABASE_SERVICE_KEY "
                "(env vars o .env.local de cartera-app)"
            )
        url, key = creds
        endpoint = f"{url}/rest/v1/carnes_precios?select=corte,seccion,precio,precio_local,updated_at"

        try:
            # User-Agent no-browser: Supabase rechaza secret keys si el UA
            # parece un navegador ("Forbidden use of secret API key in browser")
            r = await self._request(endpoint, headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "User-Agent": "relevador-carnes/2.0 (server)",
            })
            rows = r.json()
        except Exception as e:
            raise ScraperError(f"EQ Carnes: Supabase falló: {e}")

        ahora = datetime.now()
        out: list[PrecioRelevado] = []
        sin_normalizar = []

        for row in rows:
            nombre = (row.get("corte") or "").strip()
            if not nombre:
                continue
            corte = normalizar(nombre)
            if not corte:
                sin_normalizar.append(nombre)
                continue
            try:
                precio = float(row.get("precio") or 0)
            except (ValueError, TypeError):
                continue
            if precio < 1000 or precio > 200000:
                continue
            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente="supabase://carnes_precios",
            ))

        if sin_normalizar:
            log.debug(f"[EQ] cortes propios sin equivalente en el comparativo: "
                      f"{', '.join(sin_normalizar)}")
        if not out:
            raise ScraperError("EQ Carnes: la tabla carnes_precios no devolvió cortes")
        log.info(f"[EQ Carnes] {len(out)} cortes propios cargados "
                 f"({len(sin_normalizar)} sin equivalente)")
        return out
