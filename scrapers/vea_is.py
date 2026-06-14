"""Vea vía VTEX intelligent-search (la API vieja devolvía 0)."""
from .vtex_intelligent_base import VTEXIntelligentScraper


class VeaIsScraper(VTEXIntelligentScraper):
    nombre = "Vea"
    segmento = "commodity"
    base_url = "https://www.vea.com.ar"
