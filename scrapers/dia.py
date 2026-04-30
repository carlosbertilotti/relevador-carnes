"""
Scraper de Día Argentina (https://diaonline.supermercadosdia.com.ar)
Plataforma: VTEX
"""
from .vtex_base import VTEXScraper


class DiaScraper(VTEXScraper):
    nombre = "Día"
    segmento = "commodity"  # Día apunta al segmento de mayor sensibilidad al precio
    base_url = "https://diaonline.supermercadosdia.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://diaonline.supermercadosdia.com.ar
    # En el sitio de Día, "Frescos > Carnes" suele estar bajo este ID.
    categoria_carne_id = "141"
