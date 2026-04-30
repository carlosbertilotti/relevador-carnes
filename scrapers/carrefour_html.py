"""Carrefour vía HTML scraping (respaldo cuando la API VTEX devuelve 0)."""
from .vtex_html_base import VTEXHtmlScraper


class CarrefourHtmlScraper(VTEXHtmlScraper):
    nombre = "Carrefour"
    segmento = "commodity"
    base_url = "https://www.carrefour.com.ar"
    category_path = "/carnes-y-pescados/carne-vacuna"
