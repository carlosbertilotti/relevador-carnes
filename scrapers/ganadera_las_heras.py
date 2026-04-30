"""
Scraper de Ganadera Las Heras (https://ganaderalasheras.com.ar)

Frigorífico/distribuidor de San Martín, BA. Tiene tienda online basada
en WooCommerce. Lo aprovechamos como "Carnes Las Heras" en los reportes.
"""
from .woocommerce_base import WooCommerceScraper


class GanaderaLasHerasScraper(WooCommerceScraper):
    nombre = "Las Heras"
    segmento = "intermedio"  # mayorista, no estrictamente premium
    base_url = "https://ganaderalasheras.com.ar"
    # ⚠️ Verificar el slug visitando https://ganaderalasheras.com.ar/categoria-producto/
    # Si el slug es distinto (ej: "carnes-vacunas", "vacuno"), cambiarlo acá:
    categoria_slug = "carnes-vacunas"
    # Alternativa si el slug no funciona: dejar None y usar categoria_id
    # categoria_id = 15
