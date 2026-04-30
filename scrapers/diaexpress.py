"""
Scraper de Día Express (mismo dominio que Día principal pero con sales channel
distinto o categoría premium / express).

Si Día Express no resulta diferenciable de Día (mismo catálogo), comentar
este scraper en run.py para no duplicar precios.
"""
from .vtex_base import VTEXScraper


class DiaExpressScraper(VTEXScraper):
    nombre = "Día Express"
    segmento = "commodity"
    base_url = "https://diaonline.supermercadosdia.com.ar"
    categoria_carne_id = "141"
    sales_channel = 2   # ⚠️ verificar; sc=2 suele apuntar a tiendas express
