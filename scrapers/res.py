"""
Scraper de RES Tradición en Carnes (https://www.res.com.ar).

V2: en vez de parsear HTML (que cambia), extraemos los productos del
dataLayer de Google Tag Manager que está embebido en el HTML como JSON.
Cada producto tiene name, id y price (en ARS, ya por kg).
Esto cubre los cortes premium que SEPA no tiene (entraña, picaña, nalga,
peceto, bola de lomo, tapa de nalga, etc.).
"""
import json
import logging
import re
from datetime import datetime

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


URL = "https://www.res.com.ar/carnes-vacunas.html"


class ResScraper(ScraperBase):
    nombre = "RES"
    segmento = "premium"
    base_url = "https://www.res.com.ar"
    min_cortes_esperados = 8

    async def relevar(self) -> list[PrecioRelevado]:
        try:
            html = await self.get_html(URL)
        except Exception as e:
            raise ScraperError(f"RES: no se pudo descargar {URL}: {e}")

        # El HTML tiene impressions del dataLayer GTM con todos los productos:
        #   "impressions":[{"name":"Asado","id":"2065","price":"19500.00",...},...]
        productos: list[dict] = []
        for m in re.finditer(r'"impressions"\s*:\s*(\[[^\]]+\])', html):
            try:
                arr = json.loads(m.group(1))
                productos.extend(arr)
            except json.JSONDecodeError:
                continue

        if not productos:
            raise ScraperError(
                "RES: no se encontró 'impressions' en el HTML. "
                "Probable cambio de plantilla — revisar regex."
            )

        # Deduplicar por name+id (puede aparecer en varios bloques)
        vistos: set[tuple[str, str]] = set()
        ahora = datetime.now()
        out: list[PrecioRelevado] = []

        for p in productos:
            nombre = (p.get("name") or "").strip()
            id_prod = str(p.get("id") or "")
            categoria = (p.get("category") or "").lower()
            if not nombre or "vacun" not in categoria:
                continue
            key = (nombre.lower(), id_prod)
            if key in vistos:
                continue
            vistos.add(key)

            corte = normalizar(nombre)
            if not corte:
                continue   # filtramos hamburguesas, milanesas, picada premium, etc.

            try:
                precio = float(p.get("price") or 0)
            except (ValueError, TypeError):
                continue
            if precio < 1000 or precio > 200000:
                continue   # sanity

            slug = re.sub(r"[^a-z0-9]+", "-", nombre.lower()).strip("-")
            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=f"{self.base_url}/{slug}.html",
            ))

        if not out:
            raise ScraperError(
                f"RES: encontré {len(productos)} productos en JSON pero "
                f"ninguno se normalizó. Revisar normalizador.py."
            )
        log.info(f"[RES] {len(out)} cortes premium relevados")
        return out
