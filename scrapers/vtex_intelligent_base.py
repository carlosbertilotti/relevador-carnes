"""
Base para sitios VTEX usando el endpoint moderno *intelligent-search*.

La API vieja (/api/catalog_system/pub/products/search?fq=C:...) dejó de
devolver productos sin la cookie de segmentación. La API nueva de búsqueda
inteligente SÍ funciona sin cookies:

    GET https://<host>/api/io/_v/api/intelligent-search/product_search/
        ?query=<termino>&count=50&page=<n>&locale=es-AR

Devuelve products[] con la misma estructura de SKU que la API vieja
(items[].sellers[].commertialOffer.Price, measurementUnit, unitMultiplier),
así que reusamos la conversión a $/kg.

Estrategia: corremos varias búsquedas de cortes vacunos y deduplicamos.
El normalizador filtra lo que no es corte trackeado.
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


# Términos de búsqueda que cubren los cortes que trackeamos.
# Cuantos más, más cobertura (el normalizador filtra el ruido).
QUERIES_CARNE = [
    "carne vacuna", "asado", "lomo", "vacio", "matambre", "cuadril",
    "nalga", "peceto", "bife", "picada", "osobuco", "paleta", "roast beef",
    "entraña", "falda", "tapa", "bola de lomo", "aguja", "tortuguita",
]


class VTEXIntelligentScraper(ScraperBase):
    """
    Subclases definen: nombre, base_url, segmento.
    Opcional: locale (default es-AR), count (default 50).
    """
    locale: str = "es-AR"
    count: int = 50
    max_queries_concurrent: int = 3
    min_cortes_esperados = 4

    def _url(self, query: str, page: int = 1) -> str:
        q = query.replace(" ", "%20")
        return (
            f"{self.base_url}/api/io/_v/api/intelligent-search/product_search/"
            f"?query={q}&count={self.count}&page={page}&locale={self.locale}"
        )

    def _extraer_precio_kg(self, item: dict, nombre: str) -> Optional[float]:
        sellers = item.get("sellers", [])
        if not sellers:
            return None
        offer = sellers[0].get("commertialOffer", {})
        precio = offer.get("Price")
        if not precio or precio <= 0:
            return None
        mult = item.get("unitMultiplier") or 1
        unit = (item.get("measurementUnit") or "kg").lower()
        if unit in ("kg", "kgr"):
            return round(precio / mult, 2)
        if unit in ("g", "gr"):
            return round(precio * 1000 / mult, 2)
        # "un": si el nombre sugiere venta por kg
        low = nombre.lower()
        if "x kg" in low or "/kg" in low or "por kg" in low:
            return round(precio, 2)
        return None

    async def _buscar(self, query: str) -> list[dict]:
        try:
            data = await self.get_json(self._url(query))
        except Exception as e:
            log.debug(f"[{self.nombre}] query '{query}' falló: {e}")
            return []
        return data.get("products", []) if isinstance(data, dict) else []

    async def relevar(self) -> list[PrecioRelevado]:
        sem = asyncio.Semaphore(self.max_queries_concurrent)

        async def _run(q):
            async with sem:
                return await self._buscar(q)

        listas = await asyncio.gather(*[_run(q) for q in QUERIES_CARNE],
                                      return_exceptions=True)

        ahora = datetime.now()
        vistos: set[str] = set()
        out: list[PrecioRelevado] = []

        for lista in listas:
            if isinstance(lista, Exception) or not lista:
                continue
            for prod in lista:
                nombre = prod.get("productName", "")
                if not nombre or nombre in vistos:
                    continue
                vistos.add(nombre)
                corte = normalizar(nombre)
                if not corte:
                    continue
                items = prod.get("items", [])
                if not items:
                    continue
                precio_kg = self._extraer_precio_kg(items[0], nombre)
                if precio_kg is None or precio_kg < 1000 or precio_kg > 200000:
                    continue
                out.append(PrecioRelevado(
                    carniceria=self.nombre,
                    corte_original=nombre,
                    corte_normalizado=corte,
                    precio_kg=precio_kg,
                    fecha=ahora,
                    segmento=self.segmento,
                    url_fuente=f"{self.base_url}{prod.get('link', '')}",
                    marca=prod.get("brand"),
                ))

        if not out:
            raise ScraperError(
                f"{self.nombre}: intelligent-search no devolvió cortes "
                f"reconocibles ({len(vistos)} productos vistos)."
            )
        log.info(f"[{self.nombre}] {len(out)} cortes vía intelligent-search")
        return out
