"""
Carnicería El Origen (https://carniceriaelorigen.com) — premium, San Isidro.

La categoría /cortes-vacunos lista cada corte con precio explícito "$ X /kg".
Cuando hay descuento muestra dos precios: el de lista (tachado, clase
line-through) y el vigente. Tomamos el vigente.
"""
import logging
import re
from datetime import datetime

from bs4 import BeautifulSoup

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)

URL = "https://carniceriaelorigen.com/cortes-vacunos"


def _precio(texto: str) -> float | None:
    m = re.search(r"([\d\.]+)(?:,(\d{1,2}))?", texto)
    if not m:
        return None
    entero = m.group(1).replace(".", "")
    return float(f"{entero}.{m.group(2) or 0}")


class ElOrigenScraper(ScraperBase):
    nombre = "El Origen"
    segmento = "premium"
    base_url = "https://carniceriaelorigen.com"
    min_cortes_esperados = 10

    async def relevar(self) -> list[PrecioRelevado]:
        html = await self.get_html(URL)
        soup = BeautifulSoup(html, "lxml")
        ahora = datetime.now()
        out: list[PrecioRelevado] = []

        for a in soup.select('a[href^="/cortes-vacunos/"]'):
            h3 = a.select_one("h3")
            precios = [p for p in a.select("p") if "/kg" in p.get_text()]
            if not h3 or not precios:
                continue
            nombre = h3.get_text(strip=True)
            corte = normalizar(nombre)
            if not corte:
                continue
            vigentes = [p for p in precios if "line-through" not in (p.get("class") or [])]
            precio = _precio((vigentes or precios)[-1].get_text(strip=True))
            if not precio:
                continue
            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=f"{self.base_url}{a['href']}",
            ))

        if not out:
            raise ScraperError("El Origen: 0 cortes en /cortes-vacunos (¿cambió el HTML?)")
        return out
