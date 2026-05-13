"""
Scraper de Mercado Libre Argentina (https://api.mercadolibre.com).

A diferencia de los supermercados, ML agrega cientos de vendedores chicos:
carnicerías boutique, frigoríficos directos, productores. Aumenta MUCHO la muestra.

Estrategia:
- Para cada corte popular, hacer 1 búsqueda en la API pública de ML
- Filtrar resultados con precio razonable y "kg" en título
- Calcular MEDIANA de los primeros N (más robusto que promedio contra outliers)
- Devolver 1 fila por corte con la mediana como precio_kg

API pública (sin auth): https://api.mercadolibre.com/sites/MLA/search?q=...
"""
import statistics
import re
from datetime import datetime
from typing import Optional

from .base import ScraperBase, PrecioRelevado
from normalizador import normalizar


# Términos de búsqueda por corte normalizado.
# La key es el corte_normalizado, el value es la query a hacer en ML.
QUERIES = {
    "asado":            "asado tira por kg",
    "vacio":            "vacio carne por kg",
    "matambre":         "matambre vacuno por kg",
    "bife_angosto":     "bife angosto por kg",
    "bife_ancho":       "bife ancho por kg",
    "lomo":             "lomo vacuno por kg",
    "peceto":           "peceto por kg",
    "cuadril":          "cuadril por kg",
    "colita_cuadril":   "colita cuadril por kg",
    "tapa_cuadril":     "tapa cuadril por kg",
    "tapa_asado":       "tapa asado por kg",
    "osobuco":          "osobuco por kg",
    "picada_comun":     "carne picada comun por kg",
    "picada_especial":  "carne picada especial por kg",
    "entrana":          "entraña por kg",
    "nalga":            "nalga por kg",
    "roast_beef":       "roast beef por kg",
}

# Filtros razonables (en pesos argentinos por kg, mid-2026)
PRECIO_MIN = 2500   # menos que esto es promo/lote/ofertita rara
PRECIO_MAX = 80000  # más que esto es premium/wagyu/error


def _extraer_precio_kg(item: dict) -> Optional[float]:
    """
    Extrae precio por kg de un item de ML. Si el item es <1kg, escala.
    Si el título dice "5kg" usa eso, si no asume 1kg.
    """
    precio = item.get("price")
    if not precio or precio < 100:
        return None

    titulo = item.get("title", "").lower()
    # Buscar "1kg", "5 kg", "500g", "1/2 kg", etc en el título
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(kg|kilos?|kilogramos?)", titulo)
    if m:
        kg = float(m.group(1).replace(",", "."))
        if kg > 0:
            return precio / kg

    # Si es en gramos
    m = re.search(r"(\d+)\s*(g|gr|gramos?)\b", titulo)
    if m:
        g = int(m.group(1))
        if g >= 200:
            return precio * (1000.0 / g)

    # Si no especifica peso, asumimos 1kg
    return precio


class MercadoLibreScraper(ScraperBase):
    nombre = "Mercado Libre"
    segmento = "commodity"
    base_url = "https://api.mercadolibre.com"
    max_concurrent_requests = 3
    min_cortes_esperados = 5
    delay_range = (0.2, 0.5)

    async def relevar(self) -> list[PrecioRelevado]:
        precios: list[PrecioRelevado] = []
        fecha = datetime.now()

        for corte_norm, query in QUERIES.items():
            try:
                url = f"{self.base_url}/sites/MLA/search?q={query}&limit=20"
                data = await self.get_json(url)
                items = data.get("results", [])
                if not items:
                    continue

                valores = []
                for it in items:
                    p = _extraer_precio_kg(it)
                    if p is None:
                        continue
                    if not (PRECIO_MIN <= p <= PRECIO_MAX):
                        continue
                    valores.append(p)

                if len(valores) < 3:
                    continue  # poca data, no incluir

                # Mediana es más robusta que promedio contra outliers
                mediana = round(statistics.median(valores), 2)

                precios.append(PrecioRelevado(
                    carniceria=self.nombre,
                    corte_original=query,
                    corte_normalizado=corte_norm,
                    precio_kg=mediana,
                    fecha=fecha,
                    segmento=self.segmento,
                    url_fuente=f"https://listado.mercadolibre.com.ar/{query.replace(' ', '-')}",
                ))
            except Exception as e:
                # Loggear y seguir con el siguiente corte
                import logging
                logging.getLogger(__name__).warning(f"[ML] falló query '{query}': {e}")

        return precios
