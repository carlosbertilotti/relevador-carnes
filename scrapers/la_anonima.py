"""
Scraper async de La Anónima Online (https://www.laanonimaonline.com)

La Anónima NO usa VTEX, tiene su propia plataforma. Parsea HTML.
"""
import asyncio
import logging
import re
from datetime import datetime
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


SELECTORES = {
    "producto_card":   "article.producto, div.producto, div[class*='producto']",
    "producto_nombre": "h2, h3, .nombre, [class*='nombre']",
    "producto_precio": ".precio, [class*='precio'], .price",
    "producto_link":   "a[href]",
}

CATEGORIAS_CARNE = [
    "/categoria/2-1/carnes",
]


def _parsear_precio(texto: str):
    if not texto:
        return None
    limpio = re.sub(r"[^\d,.]", "", texto)
    if not limpio:
        return None
    if "," in limpio and "." in limpio:
        limpio = limpio.replace(".", "").replace(",", ".")
    elif "," in limpio:
        limpio = limpio.replace(",", ".")
    try:
        return float(limpio)
    except ValueError:
        return None


class LaAnonimaScraper(ScraperBase):
    nombre = "La Anónima"
    segmento = "commodity"
    base_url = "https://www.laanonimaonline.com"
    max_pages = 10
    min_cortes_esperados = 5

    async def _fetch_pagina(self, cat_path: str, page: int) -> list[PrecioRelevado]:
        sep = "&" if "?" in cat_path else "?"
        url = f"{self.base_url}{cat_path}{sep}page={page}"
        try:
            html = await self.get_html(url)
        except Exception as e:
            if page == 1:
                log.warning(f"[{self.nombre}] {cat_path} pág 1 falló: {e}")
            return []

        soup = BeautifulSoup(html, "lxml")
        cards = soup.select(SELECTORES["producto_card"])
        if not cards:
            return []

        ahora = datetime.now()
        out: list[PrecioRelevado] = []
        for card in cards:
            nom_el = card.select_one(SELECTORES["producto_nombre"])
            pre_el = card.select_one(SELECTORES["producto_precio"])
            link_el = card.select_one(SELECTORES["producto_link"])
            if not nom_el or not pre_el:
                continue
            nombre = nom_el.get_text(" ", strip=True)
            corte = normalizar(nombre)
            if not corte:
                continue
            precio = _parsear_precio(pre_el.get_text())
            if precio is None or precio <= 0:
                continue
            href = link_el.get("href") if link_el else ""
            out.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=urljoin(self.base_url, href) if href else url,
            ))
        return out

    async def relevar(self) -> list[PrecioRelevado]:
        # Descubrir cuántas páginas hay con la primera, luego paralelizar
        resultados: list[PrecioRelevado] = []
        vistos: set[str] = set()

        for cat in CATEGORIAS_CARNE:
            tareas = [self._fetch_pagina(cat, p) for p in range(1, self.max_pages + 1)]
            paginas = await asyncio.gather(*tareas, return_exceptions=True)
            for p in paginas:
                if isinstance(p, Exception):
                    continue
                for r in p:
                    if r.corte_original in vistos:
                        continue
                    vistos.add(r.corte_original)
                    resultados.append(r)

        if not resultados:
            raise ScraperError(
                "La Anónima no devolvió resultados. "
                "Probable cambio de HTML — actualizar SELECTORES en scrapers/la_anonima.py"
            )
        return resultados
