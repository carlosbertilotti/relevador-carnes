"""Día vía HTML scraping."""
from .vtex_html_base import VTEXHtmlScraper


class DiaHtmlScraper(VTEXHtmlScraper):
    nombre = "Día"
    segmento = "commodity"
    base_url = "https://diaonline.supermercadosdia.com.ar"
    category_path = "/frescos/carniceria/carnes-de-vaca"
