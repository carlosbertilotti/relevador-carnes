"""
Beef Club (https://beefclub.com.ar) — carnicería premium, CABA/GBA.

Vende por pieza: cada tarjeta trae el peso en .product-cat
("Línea Prime • 1.065 kg", "600 Gr", "1.200", "0,9") y el precio de la
pieza en .product-price. $/kg = precio / peso.

Formatos de peso vistos: "1.065 kg", "1 kg", "600 Gr", "1.200" (sin unidad
= kg con punto decimal), "0,9". Un número > 20 sin unidad se toma como gramos.
"""
import logging
import re
from datetime import datetime

from bs4 import BeautifulSoup

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)

URL = "https://beefclub.com.ar/"


def _peso_kg(texto: str) -> float | None:
    parte = texto.split("•")[-1].strip().lower()
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(kg|gr|g)?", parte)
    if not m:
        return None
    val = float(m.group(1).replace(",", "."))
    unidad = m.group(2)
    if unidad in ("gr", "g") or (unidad is None and val > 20):
        val /= 1000
    return val if 0.1 <= val <= 15 else None


def _precio(texto: str) -> float | None:
    digitos = re.sub(r"[^\d]", "", texto)
    return float(digitos) if digitos else None


class BeefClubScraper(ScraperBase):
    nombre = "Beef Club"
    segmento = "premium"
    base_url = "https://beefclub.com.ar"
    min_cortes_esperados = 6

    async def relevar(self) -> list[PrecioRelevado]:
        html = await self.get_html(URL)
        soup = BeautifulSoup(html, "lxml")
        ahora = datetime.now()
        vistos: set[str] = set()
        out: list[PrecioRelevado] = []

        for card in soup.select(".product-info"):
            cat = card.select_one(".product-cat")
            name = card.select_one(".product-name")
            price = card.select_one(".product-price")
            if not (cat and name and price):
                continue
            nombre = name.get_text(strip=True)
            if nombre in vistos:
                continue
            vistos.add(nombre)
            corte = normalizar(nombre)
            if not corte:
                continue
            peso = _peso_kg(cat.get_text(strip=True))
            precio = _precio(price.get_text(strip=True))
            if not peso or not precio:
                continue
            link = name.select_one("a")
            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=round(precio / peso, 2),
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=link["href"] if link else URL,
                peso_g=int(peso * 1000),
            ))

        if not out:
            raise ScraperError("Beef Club: 0 cortes (¿cambió el HTML de .product-info?)")
        return out
