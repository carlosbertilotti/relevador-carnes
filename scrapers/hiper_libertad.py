"""
Scraper de Hiper Libertad (https://www.hiperlibertad.com.ar)
Cadena de Carrefour para Córdoba/Mendoza/Norte. Plataforma: VTEX.
"""
from .vtex_base import VTEXScraper


class HiperLibertadScraper(VTEXScraper):
    nombre = "Hiper Libertad"
    segmento = "commodity"
    base_url = "https://www.hiperlibertad.com.ar"
    # ⚠️ Verificar con: python discover_vtex.py https://www.hiperlibertad.com.ar
    # Categoría "Carnicería / Carne Vacuna" — fallback al ID típico de VTEX-supers (322).
    # Categoría "Carnes" (genérica). La 588 (Carne vacuna) está vacía;
    # la 587 incluye vacuno + cerdo + pollo pero el normalizador filtra después.
    categoria_carne_id = "587"
    sales_channel = 1
