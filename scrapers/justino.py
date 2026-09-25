"""
Justino Carni (https://justino.com.ar) — carnicería premium, CABA.

WooCommerce. OJO: la Store API devuelve el precio ESTIMADO DE LA PIEZA
(ej. Colita $40.150 = $36.500/kg × 1,1 kg), no el precio por kg. El $/kg
real solo aparece en la página de cada producto ("$ 36.500,00 /kg").

Estrategia: la Store API da el catálogo (nombre + permalink); para cada
producto que normaliza a un corte trackeado leemos su página y tomamos el
precio del bloque "p.price" que termina en "/kg". Si la página no muestra
"/kg" (algunos se venden solo por pieza) el producto se descarta.
"""
import asyncio
import logging
import re
from datetime import datetime

from bs4 import BeautifulSoup

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)

API = "https://justino.com.ar/wp-json/wc/store/v1/products?per_page=100&page={page}"


def _precio_kg(html: str) -> float | None:
    soup = BeautifulSoup(html, "lxml")
    for p in soup.select(".summary p.price, p.price"):
        t = p.get_text(" ", strip=True)
        if "/kg" not in t.lower():
            continue
        # Si hay descuento, <ins> es el precio vigente
        ins = p.select_one("ins")
        t = (ins.get_text(" ", strip=True) if ins else t)
        m = re.search(r"([\d\.]+),(\d{2})", t)
        if m:
            return float(f"{m.group(1).replace('.', '')}.{m.group(2)}")
    return None


class JustinoScraper(ScraperBase):
    nombre = "Justino"
    segmento = "premium"
    base_url = "https://justino.com.ar"
    min_cortes_esperados = 8

    async def relevar(self) -> list[PrecioRelevado]:
        productos: list[dict] = []
        for page in range(1, 4):
            lote = await self.get_json(API.format(page=page))
            if not lote:
                break
            productos.extend(lote)
            if len(lote) < 100:
                break

        candidatos = []
        for p in productos:
            corte = normalizar(p.get("name", ""))
            if corte and p.get("permalink"):
                candidatos.append((p, corte))

        async def _uno(p, corte):
            try:
                html = await self.get_html(p["permalink"])
            except Exception as e:
                log.debug(f"[Justino] {p['name']}: {e}")
                return None
            precio = _precio_kg(html)
            if not precio:
                return None
            return PrecioRelevado(
                carniceria=self.nombre,
                corte_original=p["name"],
                corte_normalizado=corte,
                precio_kg=precio,
                fecha=datetime.now(),
                segmento=self.segmento,
                url_fuente=p["permalink"],
                disponible=bool(p.get("is_in_stock", True)),
            )

        res = await asyncio.gather(*[_uno(p, c) for p, c in candidatos])
        out = [r for r in res if r]
        if not out:
            raise ScraperError(
                f"Justino: {len(candidatos)} cortes en catálogo pero ninguna "
                f"página mostró precio /kg"
            )
        return out
