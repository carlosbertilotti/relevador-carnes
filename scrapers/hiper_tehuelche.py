"""
Scraper de Hiper Tehuelche (https://www.hipertehuelche.com.ar)
Cadena patagónica. Plataforma: VTEX.
"""
from .vtex_base import VTEXScraper


class HiperTehuelcheScraper(VTEXScraper):
    nombre = "Hiper Tehuelche"
    segmento = "commodity"
    base_url = "https://www.hipertehuelche.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.hipertehuelche.com.ar
    categoria_carne_id = "322"
    sales_channel = 1
