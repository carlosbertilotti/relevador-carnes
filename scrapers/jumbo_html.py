"""Jumbo vía HTML scraping."""
from .vtex_html_base import VTEXHtmlScraper


class JumboHtmlScraper(VTEXHtmlScraper):
    nombre = "Jumbo"
    segmento = "intermedio"
    base_url = "https://www.jumbo.com.ar"
    category_path = "/carnes/carne-vacuna"
