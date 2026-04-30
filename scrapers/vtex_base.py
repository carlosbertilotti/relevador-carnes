"""
Base async para sitios construidos sobre VTEX.

VTEX expone una API pública de búsqueda de catálogo:
    GET https://<dominio>/api/catalog_system/pub/products/search
        ?fq=C:<categoria_id>
        &_from=<inicio>&_to=<fin>

Devuelve JSON con productos completos, sin necesidad de renderizar JS.
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


class VTEXScraper(ScraperBase):
    """
    Scraper genérico para sitios VTEX.

    Subclases DEBEN definir:
        nombre, base_url, categoria_carne_id, segmento

    Para descubrir el categoria_carne_id:
        python discover_vtex.py https://www.<sitio>.com.ar
    """
    categoria_carne_id: str = ""
    page_size: int = 50
    max_pages: int = 30
    sales_channel: Optional[int] = 1   # default: la mayoría de supers AR requieren sc=1
    paginar_en_paralelo: bool = True

    def _url_busqueda(self, desde: int, hasta: int) -> str:
        url = (
            f"{self.base_url}/api/catalog_system/pub/products/search"
            f"?fq=C:{self.categoria_carne_id}"
            f"&_from={desde}&_to={hasta}"
        )
        if self.sales_channel:
            url += f"&sc={self.sales_channel}"
        return url

    def _extraer_precio_kg(self, item: dict, nombre: str) -> Optional[float]:
        sellers = item.get("sellers", [])
        if not sellers:
            return None
        offer = sellers[0].get("commertialOffer", {})
        precio = offer.get("Price")
        if not precio or precio <= 0:
            return None
        unit_multiplier = item.get("unitMultiplier") or 1
        unit = (item.get("measurementUnit") or "kg").lower()

        if unit == "kg":
            return round(precio / unit_multiplier, 2)
        elif unit == "g":
            return round(precio * 1000 / unit_multiplier, 2)
        else:
            if "x kg" in nombre.lower() or "/kg" in nombre.lower():
                return round(precio, 2)
            log.debug(f"[{self.nombre}] sin unidad de peso: {nombre} (unit={unit})")
            return None

    def _disponible(self, item: dict) -> bool:
        sellers = item.get("sellers", [])
        if not sellers:
            return False
        offer = sellers[0].get("commertialOffer", {})
        return bool(offer.get("AvailableQuantity", 0)) or offer.get("IsAvailable", False)

    async def _fetch_page(self, page: int) -> list[dict]:
        desde = page * self.page_size
        hasta = desde + self.page_size - 1
        try:
            return await self.get_json(self._url_busqueda(desde, hasta))
        except Exception as e:
            if page == 0:
                raise
            log.debug(f"[{self.nombre}] fin de paginación en página {page}: {e}")
            return []

    async def relevar(self) -> list[PrecioRelevado]:
        if not self.categoria_carne_id:
            raise ScraperError(
                f"{self.nombre}: categoria_carne_id no definida. "
                f"Ejecutá: python discover_vtex.py {self.base_url}"
            )

        ahora = datetime.now()
        items_total: list[dict] = []

        if self.paginar_en_paralelo:
            # Pedimos primero la página 0 para confirmar que la API responde
            primer = await self._fetch_page(0)
            if not primer:
                raise ScraperError(
                    f"{self.nombre}: la API VTEX respondió 200 pero con 0 productos. "
                    f"Probables causas: (a) sales_channel incorrecto (probá sc=2 o sc=3), "
                    f"(b) categoria_carne_id es padre con subcategorías "
                    f"(buscar IDs hijos), (c) la categoría requiere geolocalización."
                )
            items_total.extend(primer)

            # Si la primera página llenó el page_size, traemos el resto en paralelo
            if len(primer) >= self.page_size:
                tareas = [self._fetch_page(p) for p in range(1, self.max_pages)]
                paginas = await asyncio.gather(*tareas, return_exceptions=True)
                for p in paginas:
                    if isinstance(p, Exception) or not p:
                        continue
                    items_total.extend(p)
                    if len(p) < self.page_size:
                        break
        else:
            for page in range(self.max_pages):
                items = await self._fetch_page(page)
                if not items:
                    break
                items_total.extend(items)
                if len(items) < self.page_size:
                    break

        resultados: list[PrecioRelevado] = []
        vistos: set[str] = set()

        for prod in items_total:
            nombre = prod.get("productName", "")
            if not nombre or nombre in vistos:
                continue
            vistos.add(nombre)

            corte = normalizar(nombre)
            if not corte:
                continue

            skus = prod.get("items", [])
            if not skus:
                continue

            sku = skus[0]
            precio_kg = self._extraer_precio_kg(sku, nombre)
            if precio_kg is None:
                continue

            resultados.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio_kg,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=f"{self.base_url}{prod.get('link', '')}",
                marca=prod.get("brand"),
                disponible=self._disponible(sku),
            ))

        return resultados
