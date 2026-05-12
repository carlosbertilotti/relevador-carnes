"""
Scraper de Atomo Conviene (https://atomoconviene.com)
Cadena cordobesa de descuento. Plataforma: VTEX.
"""
from .vtex_base import VTEXScraper


class AtomoScraper(VTEXScraper):
    nombre = "Atomo Conviene"
    segmento = "commodity"
    base_url = "https://atomoconviene.com"
    # ⚠️ Verificar con: python discover_vtex.py https://atomoconviene.com
    categoria_carne_id = "63"
    sales_channel = 1
