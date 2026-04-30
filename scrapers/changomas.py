"""
Scraper de ChangoMás (https://www.masonline.com.ar)
Plataforma: VTEX (ex-Walmart Argentina).
"""
from .vtex_base import VTEXScraper


class ChangoMasScraper(VTEXScraper):
    nombre = "ChangoMás"
    segmento = "commodity"
    base_url = "https://www.masonline.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.masonline.com.ar
    categoria_carne_id = "400136"
