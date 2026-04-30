"""
Scraper de Disco (https://www.disco.com.ar)
Plataforma: VTEX (grupo Cencosud)
"""
from .vtex_base import VTEXScraper


class DiscoScraper(VTEXScraper):
    nombre = "Disco"
    segmento = "intermedio"
    base_url = "https://www.disco.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.disco.com.ar
    categoria_carne_id = "55"
