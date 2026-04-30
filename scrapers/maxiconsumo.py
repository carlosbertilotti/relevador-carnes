"""
Scraper de Maxiconsumo (https://maxiconsumo.com)
Plataforma: VTEX (mayorista).
"""
from .vtex_base import VTEXScraper


class MaxiconsumoScraper(VTEXScraper):
    nombre = "Maxiconsumo"
    segmento = "mayorista"
    base_url = "https://maxiconsumo.com"
    # ⚠️ Verificar con: python discover_vtex.py https://maxiconsumo.com
    categoria_carne_id = "70"
