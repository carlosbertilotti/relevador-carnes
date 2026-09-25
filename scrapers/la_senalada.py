"""
La Señalada Carnes (https://www.lasenaladacarnes.com) — carnicería online,
CABA / Zona Norte / Oeste. Novillito recriado a pasto y terminado a corral.

El sitio (constructor Site123) pinta los precios con JavaScript, pero los
datos ya vienen en el HTML:
  - cada tarjeta: <div class="product-data-obj" data-unique-id="ID"> con el
    título en <a aria-label="VACIO - $20500 (Desc. Efectivo)">
  - un mapa JSON (HTML-escapado) "ID":{"uniqueID":"ID","as":{"price":"22777",
    "onSale":"off","salePrice":...}}

Se vende por kg (el selector de cantidad pide peso en kg). El precio de
lista es "price"; el del título es con descuento por efectivo (~10% menos).
Tomamos el de lista para comparar parejo con el resto de las fuentes.
"""
import html as htmllib
import logging
import re
from datetime import datetime

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)

URL = "https://www.lasenaladacarnes.com/productos/carnes/carne-de-novillito"

_CARD = re.compile(
    r'data-unique-id="(\w+)".{0,1500}?aria-label="([^"]+)"', re.S)
_PRECIO = re.compile(
    r'"(\w+)":\{"uniqueID":"\1","as":\{[^{}]*?"price":"(\d+(?:\.\d+)?)"'
    r'[^{}]*?"onSale":"(\w+)"[^{}]*?"salePrice":"(\d*(?:\.\d+)?)"')


class LaSenaladaScraper(ScraperBase):
    nombre = "La Señalada"
    segmento = "intermedio"
    base_url = "https://www.lasenaladacarnes.com"
    min_cortes_esperados = 10

    async def relevar(self) -> list[PrecioRelevado]:
        raw = await self.get_html(URL)
        h = htmllib.unescape(raw)

        precios: dict[str, float] = {}
        for uid, price, on_sale, sale in _PRECIO.findall(h):
            p = float(sale) if on_sale == "on" and sale else float(price)
            precios[uid] = p

        ahora = datetime.now()
        vistos: set[str] = set()
        out: list[PrecioRelevado] = []
        for uid, titulo in _CARD.findall(h):
            if uid in vistos or uid not in precios:
                continue
            vistos.add(uid)
            nombre = titulo.split(" - $")[0].split("- $")[0].strip()
            corte = normalizar(nombre)
            if not corte:
                continue
            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precios[uid],
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=URL,
            ))

        if not out:
            raise ScraperError(
                f"La Señalada: {len(precios)} precios en el JSON pero 0 tarjetas "
                f"matchearon (¿cambió el HTML de Site123?)")
        return out
