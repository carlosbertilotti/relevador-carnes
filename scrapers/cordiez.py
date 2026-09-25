"""Cordiez (supermercado cordobés) vía VTEX intelligent-search."""
from .vtex_intelligent_base import VTEXIntelligentScraper


class CordiezScraper(VTEXIntelligentScraper):
    nombre = "Cordiez"
    segmento = "commodity"
    base_url = "https://www.cordiez.com.ar"
