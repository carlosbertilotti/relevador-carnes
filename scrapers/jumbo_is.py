"""Jumbo vía VTEX intelligent-search (más cortes que el scraper HTML)."""
from .vtex_intelligent_base import VTEXIntelligentScraper


class JumboIsScraper(VTEXIntelligentScraper):
    nombre = "Jumbo"
    segmento = "intermedio"
    base_url = "https://www.jumbo.com.ar"
