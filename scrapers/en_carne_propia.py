"""
En Carne Propia (https://encarnepropia.com.ar) — carnicería virtual, Córdoba.

WooCommerce Store API abierta. El nombre del producto dice la unidad:
  - "VACIO X KG", "PALETA x kg"                → precio por kg
  - "LOMO VENTA x UNIDAD aprox (1.6KG)"       → precio de la pieza, peso en el nombre
  - "OFERTA Osobuco x 2kg", "(500grs)"         → idem
  - "Tortilla x unidad" (sin peso)             → se descarta
"""
import logging
import re
from datetime import datetime

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)

API = "https://encarnepropia.com.ar/wp-json/wc/store/v1/products?per_page=100&page={page}"

_PESO = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kgs?|grs?|gramos|g)\b", re.I)


def _peso_kg(nombre: str) -> float | None:
    """Peso explícito en el nombre, en kg. None si no hay número (ej. 'x kg')."""
    m = _PESO.search(nombre)
    if not m:
        return None
    val = float(m.group(1).replace(",", "."))
    if m.group(2).lower().startswith(("g", "gr")) and not m.group(2).lower().startswith("kg"):
        val /= 1000
    return val if 0.1 <= val <= 15 else None


class EnCarnePropiaScraper(ScraperBase):
    nombre = "En Carne Propia"
    segmento = "intermedio"
    base_url = "https://encarnepropia.com.ar"
    min_cortes_esperados = 10

    async def relevar(self) -> list[PrecioRelevado]:
        productos: list[dict] = []
        for page in range(1, 4):
            lote = await self.get_json(API.format(page=page))
            if not lote:
                break
            productos.extend(lote)
            if len(lote) < 100:
                break

        ahora = datetime.now()
        out: list[PrecioRelevado] = []
        for p in productos:
            nombre = (p.get("name") or "").strip()
            if not nombre or nombre.upper().startswith("COMBO"):
                continue
            corte = normalizar(nombre)
            if not corte:
                continue
            pr = p.get("prices", {})
            try:
                precio = int(pr["price"]) / 10 ** int(pr.get("currency_minor_unit", 2))
            except (KeyError, ValueError, TypeError):
                continue

            peso = _peso_kg(nombre)
            if peso:
                precio_kg = precio / peso
            elif re.search(r"\bx\s*kg\b", nombre, re.I):
                precio_kg = precio
            else:
                continue   # "x unidad" sin peso: no se puede pasar a $/kg

            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=round(precio_kg, 2),
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=p.get("permalink", self.base_url),
                peso_g=int(peso * 1000) if peso else None,
                disponible=bool(p.get("is_in_stock", True)),
            ))

        if not out:
            raise ScraperError("En Carne Propia: 0 cortes en la Store API")
        return out
