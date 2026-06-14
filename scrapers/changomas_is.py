"""ChangoMás vía VTEX intelligent-search."""
from .vtex_intelligent_base import VTEXIntelligentScraper


class ChangoMasIsScraper(VTEXIntelligentScraper):
    nombre = "ChangoMás"
    segmento = "commodity"
    base_url = "https://www.masonline.com.ar"
