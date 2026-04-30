"""
Base async para sitios WooCommerce.

WooCommerce expone una REST API pública:
    GET https://<dominio>/wp-json/wc/store/v1/products?category=<slug>&per_page=100
"""
import asyncio
import logging
import re
from datetime import datetime
from typing import Optional

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


def _parsear_precio_arg(texto: str) -> Optional[float]:
    if not texto:
        return None
    limpio = re.sub(r"[^\d,.]", "", texto)
    if not limpio:
        return None
    if "," in limpio and "." in limpio:
        limpio = limpio.replace(".", "").replace(",", ".")
    elif "," in limpio:
        limpio = limpio.replace(",", ".")
    try:
        return float(limpio)
    except ValueError:
        return None


# Detecta peso del paquete en el nombre del producto: "x 500g", "1kg", etc.
_PESO_PATTERNS = [
    (re.compile(r"\b(\d+(?:[.,]\d+)?)\s*kg\b", re.I), 1000),
    (re.compile(r"\b(\d+)\s*g(?:r(?:amos)?)?\b", re.I), 1),
]


def detectar_peso_g(nombre: str) -> Optional[int]:
    """Devuelve el peso en gramos si lo encuentra explícito en el nombre."""
    for pat, factor in _PESO_PATTERNS:
        m = pat.search(nombre)
        if m:
            try:
                val = float(m.group(1).replace(",", "."))
                return int(val * factor)
            except ValueError:
                continue
    return None


class WooCommerceScraper(ScraperBase):
    """
    Subclases deben definir: nombre, base_url, segmento, categoria_slug o categoria_id.
    """
    categoria_slug: Optional[str] = None
    categoria_id: Optional[int] = None
    per_page: int = 100
    max_pages: int = 5
    paginar_en_paralelo: bool = True

    def _url_api(self, page: int) -> str:
        params = [f"per_page={self.per_page}", f"page={page}"]
        if self.categoria_slug:
            params.append(f"category={self.categoria_slug}")
        elif self.categoria_id:
            params.append(f"category={self.categoria_id}")
        return f"{self.base_url}/wp-json/wc/store/v1/products?" + "&".join(params)

    def _extraer_precio(self, prod: dict) -> Optional[float]:
        prices = prod.get("prices", {})
        precio_str = prices.get("price")
        if not precio_str:
            return None
        try:
            currency_minor = int(prices.get("currency_minor_unit", 2))
            return round(int(precio_str) / (10 ** currency_minor), 2)
        except (ValueError, TypeError):
            return None

    async def _fetch_page(self, page: int) -> list[dict]:
        try:
            return await self.get_json(self._url_api(page))
        except Exception as e:
            if page == 1:
                raise ScraperError(
                    f"{self.nombre}: WC Store API falló: {e}. "
                    f"Verificá /wp-json/wc/store/v1/products."
                )
            return []

    async def relevar(self) -> list[PrecioRelevado]:
        ahora = datetime.now()
        items_total: list[dict] = []

        if self.paginar_en_paralelo:
            primera = await self._fetch_page(1)
            if not primera:
                return []
            items_total.extend(primera)
            if len(primera) >= self.per_page:
                tareas = [self._fetch_page(p) for p in range(2, self.max_pages + 1)]
                paginas = await asyncio.gather(*tareas, return_exceptions=True)
                for p in paginas:
                    if isinstance(p, Exception) or not p:
                        continue
                    items_total.extend(p)
                    if len(p) < self.per_page:
                        break
        else:
            for page in range(1, self.max_pages + 1):
                items = await self._fetch_page(page)
                if not items:
                    break
                items_total.extend(items)
                if len(items) < self.per_page:
                    break

        resultados: list[PrecioRelevado] = []
        vistos: set[str] = set()

        for prod in items_total:
            nombre = prod.get("name", "")
            if not nombre or nombre in vistos:
                continue
            vistos.add(nombre)

            corte = normalizar(nombre)
            if not corte:
                continue

            precio = self._extraer_precio(prod)
            if precio is None or precio <= 0:
                continue

            peso_g = detectar_peso_g(nombre)
            precio_kg = precio
            if peso_g and peso_g > 0:
                precio_kg = round(precio * 1000 / peso_g, 2)

            resultados.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio_kg,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=prod.get("permalink", self.base_url),
                peso_g=peso_g,
                disponible=prod.get("is_in_stock", True),
            ))

        return resultados
