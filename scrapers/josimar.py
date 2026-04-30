"""
Scraper de Josimar (https://josimar.com.ar)
Carnicería online premium de Buenos Aires. Plataforma WooCommerce.
"""
from .woocommerce_base import WooCommerceScraper


class JosimarScraper(WooCommerceScraper):
    nombre = "Josimar"
    segmento = "premium"
    base_url = "https://josimar.com.ar"
    # ⚠️ Verificar slug en https://josimar.com.ar/categoria-producto/
    categoria_slug = "carnes"
