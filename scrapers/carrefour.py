"""
Scraper de Carrefour Argentina (https://www.carrefour.com.ar)
Plataforma: VTEX
"""
from .vtex_base import VTEXScraper


class CarrefourScraper(VTEXScraper):
    nombre = "Carrefour"
    segmento = "commodity"
    base_url = "https://www.carrefour.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.carrefour.com.ar
    categoria_carne_id = "322"
