"""
Scraper de Coto Digital (https://www.cotodigital.com.ar)

Coto migró a VTEX en 2024. Si el sitio cambia de dominio o reorganiza categorías,
ejecutar `python discover_vtex.py https://www.cotodigital.com.ar` para encontrar
el nuevo categoria_carne_id.
"""
from .vtex_base import VTEXScraper


class CotoScraper(VTEXScraper):
    nombre = "Coto"
    segmento = "commodity"
    base_url = "https://www.cotodigital.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.cotodigital.com.ar
    # En el árbol de categorías de Coto, "Carnes / Carne Vacuna" suele ser este ID.
    categoria_carne_id = "63"
