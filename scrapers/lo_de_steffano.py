"""
Template de scraper para "Lo de Stéffano" (PENDIENTE de URL real).

Cuando consigas la URL:
  - WooCommerce → herencia WooCommerceScraper + categoria_slug
  - VTEX        → herencia VTEXScraper + categoria_carne_id
  - Tiendanube  → ver patrón en docs.tiendanube.com/api
  - HTML custom → copiar approach de scrapers/res.py
"""
import logging
from .base import ScraperBase, PrecioRelevado

log = logging.getLogger(__name__)


class LoDeSteffanoScraper(ScraperBase):
    nombre = "Lo de Stéffano"
    segmento = "premium"
    base_url = "https://www.lodesteffano.com.ar"
    min_cortes_esperados = 0   # template, no alarmar

    async def relevar(self) -> list[PrecioRelevado]:
        log.warning(
            f"[{self.nombre}] no implementado — completar URL real "
            f"y plataforma. Ver scrapers/lo_de_steffano.py"
        )
        return []
