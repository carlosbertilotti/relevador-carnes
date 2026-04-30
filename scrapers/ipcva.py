"""
Scraper "IPCVA": precio mayorista de referencia.

El Instituto de Promoción de la Carne Vacuna Argentina publica precios
sugeridos / mayoristas semanales. Usamos esto como benchmark para contrastar
los precios minoristas que relevamos en supers.

Hay dos fuentes posibles:
1. https://www.ipcva.com.ar/index.php?seccion=precios — HTML semanal
2. Mercado Agroganadero (Cañuelas) — datos diarios de hacienda en pie

Por ahora parseamos la página pública del IPCVA. Si cambia el HTML,
actualizar SELECTORES.
"""
import logging
import re
from datetime import datetime

from bs4 import BeautifulSoup

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


URL = "https://www.ipcva.com.ar/index.php?seccion=precios"


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


class IpcvaScraper(ScraperBase):
    """
    Benchmark mayorista del IPCVA.

    Devuelve un único precio por corte estándar (no hay "carnicería").
    Lo guardamos con carniceria='IPCVA (referencia)' y segmento='benchmark'
    para que el dashboard pueda usarlo como línea base.
    """
    nombre = "IPCVA (referencia)"
    segmento = "benchmark"
    base_url = "https://www.ipcva.com.ar"
    min_cortes_esperados = 3

    async def relevar(self) -> list[PrecioRelevado]:
        try:
            html = await self.get_html(URL)
        except Exception as e:
            raise ScraperError(f"IPCVA: no se pudo descargar la tabla: {e}")

        soup = BeautifulSoup(html, "lxml")
        tablas = soup.find_all("table")
        if not tablas:
            raise ScraperError("IPCVA: no se encontró tabla de precios")

        ahora = datetime.now()
        resultados: list[PrecioRelevado] = []
        vistos: set[str] = set()

        for tabla in tablas:
            filas = tabla.find_all("tr")
            for fila in filas:
                celdas = fila.find_all(["td", "th"])
                if len(celdas) < 2:
                    continue
                nombre = celdas[0].get_text(" ", strip=True)
                if not nombre or nombre in vistos:
                    continue
                vistos.add(nombre)
                corte = normalizar(nombre)
                if not corte:
                    continue
                # tomamos la última celda numérica como precio sugerido
                for celda in reversed(celdas[1:]):
                    precio = _parsear_precio(celda.get_text())
                    if precio and precio > 100:   # filtra ruido
                        resultados.append(PrecioRelevado(
                            carniceria=self.nombre,
                            corte_original=nombre,
                            corte_normalizado=corte,
                            precio_kg=precio,
                            fecha=ahora,
                            segmento=self.segmento,
                            url_fuente=URL,
                        ))
                        break

        if not resultados:
            raise ScraperError(
                "IPCVA: tabla parseada pero sin cortes reconocibles. "
                "Probable cambio de estructura HTML."
            )
        return resultados
