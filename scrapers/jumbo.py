"""
Scraper de Jumbo (https://www.jumbo.com.ar)
Plataforma: VTEX (grupo Cencosud, mismo backend que Disco y Vea)
"""
from .vtex_base import VTEXScraper


class JumboScraper(VTEXScraper):
    nombre = "Jumbo"
    segmento = "intermedio"  # Jumbo se posiciona arriba de Coto/Carrefour pero abajo de premium
    base_url = "https://www.jumbo.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.jumbo.com.ar
    categoria_carne_id = "55"
