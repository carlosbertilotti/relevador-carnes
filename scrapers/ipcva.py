"""
Benchmark oficial: precios INDEC IPC-GBA por corte (mensual, en pesos/kg).

El sitio web de IPCVA migró a Next.js client-side y no es scrapeable sin
browser automation. Como reemplazo usamos la API pública de datos.gob.ar
que expone las series temporales del IPC-GBA de INDEC, donde figura el
precio mensual sugerido por kg de varios cortes.

API: https://apis.datos.gob.ar/series/api/series/?ids=<serie>&representation_mode=value&sort=desc&limit=1

Series confirmadas (todas en Pesos/kg, frecuencia mensual):
- 105.1_I2A_2016_M_14   → Asado
- 105.1_I2N_2016_M_14   → Nalga
- 105.1_I2P_2016_M_15   → Paleta
- 105.1_I2C_2016_M_16   → Cuadril
- 105.1_I2CPC_2016_M_27 → Carne picada común

Si INDEC publica más cortes en el futuro, agregarlos a SERIES.
"""
import logging
from datetime import datetime
from typing import Optional

from .base import ScraperBase, PrecioRelevado, ScraperError

log = logging.getLogger(__name__)


# corte_normalizado → id de serie en datos.gob.ar
SERIES = {
    "asado":        "105.1_I2A_2016_M_14",
    "nalga":        "105.1_I2N_2016_M_14",
    "paleta":       "105.1_I2P_2016_M_15",
    "cuadril":      "105.1_I2C_2016_M_16",
    "picada_comun": "105.1_I2CPC_2016_M_27",
}

API_BASE = "https://apis.datos.gob.ar/series/api/series/"


class IpcvaScraper(ScraperBase):
    """
    Benchmark oficial INDEC IPC-GBA — precios mensuales sugeridos por kg.

    Devuelve un precio por corte (no hay carnicería específica).
    carniceria='IPCVA (referencia)' (mantenido por compatibilidad).
    segmento='benchmark'.
    """
    nombre = "IPCVA (referencia)"
    segmento = "benchmark"
    base_url = "https://apis.datos.gob.ar"
    min_cortes_esperados = 3
    timeout = 20.0
    delay_range = (0.2, 0.4)

    async def _fetch_latest(self, serie_id: str) -> Optional[tuple[str, float]]:
        """Devuelve (fecha_iso, precio) del último dato disponible para la serie."""
        url = (
            f"{API_BASE}?ids={serie_id}"
            f"&representation_mode=value&sort=desc&limit=1"
        )
        try:
            data = await self.get_json(url)
        except Exception as e:
            log.warning(f"[IPCVA] serie {serie_id} falló: {e}")
            return None
        rows = data.get("data", [])
        if not rows:
            return None
        fecha, valor = rows[0][0], rows[0][1]
        if valor is None:
            return None
        return fecha, float(valor)

    async def relevar(self) -> list[PrecioRelevado]:
        resultados: list[PrecioRelevado] = []
        ahora = datetime.now()

        for corte_norm, serie_id in SERIES.items():
            r = await self._fetch_latest(serie_id)
            if r is None:
                continue
            fecha_str, precio = r
            resultados.append(PrecioRelevado(
                carniceria=self.nombre,
                corte_original=f"INDEC IPC-GBA · {corte_norm} ({fecha_str[:7]})",
                corte_normalizado=corte_norm,
                precio_kg=precio,
                fecha=ahora,
                segmento=self.segmento,
                url_fuente=f"https://datos.gob.ar/dataset?q={serie_id}",
            ))

        if not resultados:
            raise ScraperError("INDEC IPC-GBA: 0 series devolvieron datos")
        return resultados
