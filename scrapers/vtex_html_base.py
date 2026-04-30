"""
Base alternativa para sitios VTEX cuando la API pública devuelve 0 productos.

VTEX renderiza los productos en el HTML de la página de categoría dentro de
un script `<script id="__NEXT_DATA__">` o `<template data-varname="__STATE__">`
o como JSON-LD en `<script type="application/ld+json">`.

Este scraper hace SSR-style fetch del HTML y extrae los productos.
Más robusto a cambios en el flujo de segmentación de VTEX.
"""
import json
import logging
import re
from datetime import datetime
from typing import Optional

from bs4 import BeautifulSoup

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


class VTEXHtmlScraper(ScraperBase):
    """
    Subclases definen:
        nombre, base_url, segmento
        category_path: str   # ej "/carnes-y-pescados/carne-vacuna"
    """
    category_path: str = ""
    min_cortes_esperados = 5

    async def relevar(self) -> list[PrecioRelevado]:
        if not self.category_path:
            raise ScraperError(f"{self.nombre}: category_path no definido")

        url = f"{self.base_url}{self.category_path}"
        try:
            html = await self.get_html(url)
        except Exception as e:
            raise ScraperError(f"{self.nombre}: no se pudo cargar {url}: {e}")

        soup = BeautifulSoup(html, "lxml")
        ahora = datetime.now()
        resultados: list[PrecioRelevado] = []
        vistos: set[str] = set()

        # Estrategia 1: JSON-LD (schema.org Product) — el más estable
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "{}")
            except (json.JSONDecodeError, TypeError):
                continue

            items = data.get("itemListElement") or (data if isinstance(data, list) else [data])
            for entry in (items if isinstance(items, list) else [items]):
                if isinstance(entry, dict) and "item" in entry:
                    entry = entry["item"]
                if not isinstance(entry, dict):
                    continue
                if entry.get("@type") not in ("Product", ["Product"]):
                    continue
                nombre = entry.get("name", "")
                if not nombre or nombre in vistos:
                    continue
                corte = normalizar(nombre)
                if not corte:
                    continue
                offer = entry.get("offers", {})
                if isinstance(offer, list):
                    offer = offer[0] if offer else {}
                precio = offer.get("price") or offer.get("lowPrice")
                if not precio:
                    continue
                try:
                    precio_kg = float(precio)
                except (ValueError, TypeError):
                    continue
                if precio_kg <= 0:
                    continue
                vistos.add(nombre)
                resultados.append(PrecioRelevado(
                    carniceria=self.nombre,
                    corte_original=nombre,
                    corte_normalizado=corte,
                    precio_kg=round(precio_kg, 2),
                    fecha=ahora,
                    segmento=self.segmento,
                    url_fuente=entry.get("url") or url,
                    marca=entry.get("brand", {}).get("name") if isinstance(entry.get("brand"), dict) else None,
                ))

        if resultados:
            log.info(f"[{self.nombre}] {len(resultados)} cortes desde JSON-LD")
            return resultados

        # Estrategia 2: __NEXT_DATA__ / __STATE__ embebido
        for script in soup.find_all("script"):
            txt = script.string or ""
            if "productName" in txt and "Price" in txt:
                # Buscar todos los bloques tipo {"productName":"...","items":[...]}
                for m in re.finditer(
                    r'"productName"\s*:\s*"([^"]+)".*?"Price"\s*:\s*([\d.]+)',
                    txt, re.DOTALL,
                ):
                    nombre = m.group(1).encode().decode('unicode_escape')
                    if nombre in vistos:
                        continue
                    corte = normalizar(nombre)
                    if not corte:
                        continue
                    try:
                        precio = float(m.group(2))
                    except ValueError:
                        continue
                    if precio <= 0:
                        continue
                    vistos.add(nombre)
                    resultados.append(PrecioRelevado(
                        carniceria=self.nombre,
                        corte_original=nombre,
                        corte_normalizado=corte,
                        precio_kg=round(precio, 2),
                        fecha=ahora,
                        segmento=self.segmento,
                        url_fuente=url,
                    ))

        if not resultados:
            raise ScraperError(
                f"{self.nombre}: no se pudieron extraer productos del HTML de {url}. "
                f"Probable cambio en la estructura de la página."
            )

        log.info(f"[{self.nombre}] {len(resultados)} cortes desde HTML embedded")
        return resultados
