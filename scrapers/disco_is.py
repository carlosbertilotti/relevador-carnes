"""Disco vía VTEX intelligent-search."""
from .vtex_intelligent_base import VTEXIntelligentScraper


class DiscoIsScraper(VTEXIntelligentScraper):
    nombre = "Disco"
    segmento = "intermedio"
    base_url = "https://www.disco.com.ar"
