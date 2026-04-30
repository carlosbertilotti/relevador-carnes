"""
Scraper async de RES Tradición en Carnes (https://www.res.com.ar)
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


CATEGORIAS = [
    "/categoria/carnes/cortes-vacunos",
]

SELECTORES = {
    "card":   "div.product, article.producto, li.product, .product-item",
    "nombre": "h2, h3, .product-title, .nombre, a.woocommerce-LoopProduct-link",
    "precio": ".price, .precio, .product-price, span.amount, .woocommerce-Price-amount",
    "link":   "a[href]",
}


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


class ResScraper(ScraperBase):
    nombre = "RES"
    segmento = "premium"
    base_url = "https://www.res.com.ar"
    max_pages = 8
    min_cortes_esperados = 3

    async def _fetch_pagina(self, cat: str, page: int) -> list[PrecioRelevado]:
        url = (f"{self.base_url}{cat}/page/{page}/" if page > 1
               else f"{self.base_url}{cat}")
        try:
            html = await self.get_html(url)
        except Exception as e:
            if page == 1:
                log.warning(f"[{self.nombre}] {cat} pág 1 falló: {e}")
            return []

        soup = BeautifulSoup(html, "lxml")
        cards = soup.select(SELECTORES["card"])
        if not cards:
            return []

        ahora = datetime.now()
        out: list[PrecioRelevado] = []
        for card in cards:
            nom_el = card.select_one(SELECTORES["nombre"])
            pre_el = card.select_one(SELECTORES["precio"])
            link_el = card.select_one(SELECTORES["link"])
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
        resultados: list[PrecioRelevado] = []
        vistos: set[str] = set()
        for cat in CATEGORIAS:
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
                f"{self.nombre}: sin resultados. Probable cambio de HTML — "
                f"actualizar SELECTORES o CATEGORIAS."
            )
        return resultados
