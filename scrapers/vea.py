"""
Scraper de Vea (https://www.vea.com.ar)
Plataforma: VTEX (grupo Cencosud, mismo backend que Disco/Jumbo).
"""
from .vtex_base import VTEXScraper


class VeaScraper(VTEXScraper):
    nombre = "Vea"
    segmento = "commodity"
    base_url = "https://www.vea.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.vea.com.ar
    categoria_carne_id = "55"
