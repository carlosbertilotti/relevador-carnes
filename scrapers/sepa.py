"""
Scraper de SEPA (Sistema Electrónico de Publicidad de Precios Argentinos).

SEPA es el sistema oficial del gobierno argentino donde TODOS los supermercados
están obligados por ley a publicar sus precios. Cubre:
  Coto, Carrefour, Disco, Jumbo, Vea, Día, ChangoMás, La Anónima, Walmart,
  Maxiconsumo, Yaguar, Diarco, Vital, Toledo, Único, Josimar, etc.

Una sola fuente, un solo scraper, ~50 cadenas.

Datos: datasets ZIP con CSVs publicados en datos.produccion.gob.ar.
Estructura típica:
  productos.csv      - id, nombre, marca, presentación, etc.
  comercio.csv       - id_comercio, nombre, cuit
  sucursales.csv     - id_sucursal, id_comercio, dirección, lat/lng
  precios.csv        - id_producto, id_sucursal, precio, fecha

Como un solo dataset trae múltiples cadenas, este scraper devuelve
PrecioRelevado con `carniceria` = nombre del comercio (no "SEPA").
"""
import csv
import io
import logging
import zipfile
from collections import defaultdict
from datetime import datetime
from statistics import median
from typing import Optional

from .base import ScraperBase, PrecioRelevado, ScraperError
from normalizador import normalizar

log = logging.getLogger(__name__)


# URL del último dataset SEPA. El gobierno publica los datasets en formato:
#   https://datos.produccion.gob.ar/dataset/sepa-precios/resource/<UUID>
# y dentro cada resource expone un ZIP.
#
# Como la URL del último ZIP cambia, parseamos la página del dataset para
# encontrarlo. Si SEPA cambia de URL/portal, actualizar SEPA_DATASET_URL.
SEPA_DATASET_URL = "https://datos.produccion.gob.ar/dataset/sepa-precios"

# Si querés forzar un ZIP específico (por ej. de un mirror o caché propio):
# SEPA_FORCED_ZIP_URL = "https://tu-mirror.com/sepa-2026-04.zip"
SEPA_FORCED_ZIP_URL: Optional[str] = None


# Mapping de cadenas (banderas) que nos interesan. SEPA usa banderaDescripcion
# o nombre del comercio. Si tu cadena de interés no aparece en la lista,
# agregala acá; los nombres tienen que coincidir con lo que SEPA reporta.
BANDERAS_INTERES = {
    "COTO":          "Coto",
    "CARREFOUR":     "Carrefour",
    "DIA":           "Día",
    "JUMBO":         "Jumbo",
    "DISCO":         "Disco",
    "VEA":           "Vea",
    "CHANGOMAS":     "ChangoMás",
    "MAS":           "ChangoMás",
    "MASONLINE":     "ChangoMás",
    "WALMART":       "Walmart",
    "ANONIMA":       "La Anónima",
    "LA ANONIMA":    "La Anónima",
    "MAXICONSUMO":   "Maxiconsumo",
    "VITAL":         "Vital",
    "DIARCO":        "Diarco",
    "YAGUAR":        "Yaguar",
    "JOSIMAR":       "Josimar",
    "TOLEDO":        "Toledo",
    "MAKRO":         "Makro",
}


def _normalizar_bandera(nombre_comercio: str) -> Optional[str]:
    if not nombre_comercio:
        return None
    s = nombre_comercio.upper()
    for key, label in BANDERAS_INTERES.items():
        if key in s:
            return label
    return None


# Segmento por cadena (mismo criterio que el resto de los scrapers)
SEGMENTOS = {
    "Coto": "commodity", "Carrefour": "commodity", "Día": "commodity",
    "Vea": "commodity", "ChangoMás": "commodity", "Walmart": "commodity",
    "La Anónima": "commodity",
    "Jumbo": "intermedio", "Disco": "intermedio",
    "Maxiconsumo": "mayorista", "Vital": "mayorista", "Diarco": "mayorista",
    "Yaguar": "mayorista", "Makro": "mayorista",
    "Josimar": "premium", "Toledo": "intermedio",
}


class SepaScraper(ScraperBase):
    """
    Descarga el último dataset SEPA y devuelve precios de cortes vacunos
    para todas las banderas en BANDERAS_INTERES.
    """
    nombre = "SEPA (oficial)"
    segmento = "benchmark"   # se sobrescribe por bandera
    base_url = SEPA_DATASET_URL
    timeout = 120.0
    min_cortes_esperados = 50    # SEPA tiene mucha data
    delay_range = (0.5, 1.0)

    async def _resolver_zip_url(self) -> str:
        """Encuentra la URL del ZIP más reciente parseando la página del dataset."""
        if SEPA_FORCED_ZIP_URL:
            return SEPA_FORCED_ZIP_URL

        try:
            html = await self.get_html(SEPA_DATASET_URL)
        except Exception as e:
            raise ScraperError(
                f"SEPA: no se pudo cargar {SEPA_DATASET_URL}: {e}. "
                f"¿El portal sigue activo? Probar https://datos.gob.ar"
            )

        import re
        # Buscar primer link a un .zip
        m = re.search(r'href=["\']([^"\']+\.zip)["\']', html, re.I)
        if not m:
            raise ScraperError(
                "SEPA: no se encontró link a .zip en la página del dataset. "
                "Probable cambio de portal — actualizar SEPA_DATASET_URL "
                "o usar SEPA_FORCED_ZIP_URL en scrapers/sepa.py"
            )
        url = m.group(1)
        if url.startswith("/"):
            url = "https://datos.produccion.gob.ar" + url
        log.info(f"[SEPA] dataset ZIP: {url}")
        return url

    async def _descargar_zip(self, url: str) -> bytes:
        log.info(f"[SEPA] descargando {url} (puede tardar 1-2 min)...")
        r = await self._request(url)
        return r.content

    def _open_csv(self, zf: zipfile.ZipFile, name: str):
        """Abre un CSV del zip auto-detectando delimitador (| o ,)."""
        with zf.open(name) as fp:
            raw = fp.read().decode("utf-8", errors="replace")
        first = raw.split("\n", 1)[0] if raw else ""
        delimiter = "|" if "|" in first else ","
        return csv.DictReader(io.StringIO(raw), delimiter=delimiter)

    def _find_csv(self, zf: zipfile.ZipFile, *keywords: str) -> str | None:
        for n in zf.namelist():
            low = n.lower()
            if low.endswith((".csv", ".txt")) and any(k in low for k in keywords):
                return n
        return None

    def _procesar_comercio_zip(self, sub_data: bytes, sub_name: str) -> list[PrecioRelevado]:
        """Procesa el ZIP interno de UN comercio."""
        try:
            zf = zipfile.ZipFile(io.BytesIO(sub_data))
        except zipfile.BadZipFile:
            return []

        f_comercio = self._find_csv(zf, "comercio")
        f_productos = self._find_csv(zf, "productos", "producto")
        f_precios = self._find_csv(zf, "precios", "precio")

        if not (f_productos and f_precios):
            return []

        # Detectar bandera del comercio
        bandera = None
        if f_comercio:
            try:
                for row in self._open_csv(zf, f_comercio):
                    nombre = (row.get("comercio_razon_social")
                              or row.get("razon_social")
                              or row.get("comercio_bandera_nombre")
                              or row.get("comercio_nombre") or "")
                    bandera = _normalizar_bandera(nombre)
                    if bandera:
                        break
            except Exception:
                pass

        if not bandera:
            return []

        # Productos de carne en este comercio
        productos_carne: dict[str, tuple[str, str]] = {}
        try:
            for row in self._open_csv(zf, f_productos):
                pid = (row.get("id_producto") or row.get("producto_id") or "").strip()
                nombre = (row.get("productos_descripcion")
                          or row.get("producto_nombre")
                          or row.get("descripcion") or "").strip()
                if not pid or not nombre:
                    continue
                corte = normalizar(nombre)
                if corte:
                    productos_carne[pid] = (nombre, corte)
        except Exception:
            return []

        if not productos_carne:
            return []

        # Precios → mediana por producto
        bucket: dict[str, list[float]] = defaultdict(list)
        try:
            for row in self._open_csv(zf, f_precios):
                pid = (row.get("id_producto") or row.get("producto_id") or "").strip()
                if pid not in productos_carne:
                    continue
                try:
                    precio = float(row.get("productos_precio_lista")
                                   or row.get("precio_lista")
                                   or row.get("precio") or 0)
                except (ValueError, TypeError):
                    continue
                if precio > 100:
                    bucket[pid].append(precio)
        except Exception:
            pass

        ahora = datetime.now()
        resultados: list[PrecioRelevado] = []
        for pid, precios in bucket.items():
            if not precios:
                continue
            nombre, corte = productos_carne[pid]
            resultados.append(PrecioRelevado(
                carniceria=bandera,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=round(median(precios), 2),
                fecha=ahora,
                segmento=SEGMENTOS.get(bandera, "commodity"),
                url_fuente=SEPA_DATASET_URL,
            ))
        return resultados

    def _procesar_zip(self, contenido: bytes) -> list[PrecioRelevado]:
        try:
            zf_madre = zipfile.ZipFile(io.BytesIO(contenido))
        except zipfile.BadZipFile as e:
            raise ScraperError(f"SEPA: ZIP corrupto: {e}")

        # SEPA actual: ZIP de ZIPs, uno por comercio (cadena)
        sub_zips = [n for n in zf_madre.namelist() if n.endswith(".zip")]
        log.info(f"[SEPA] ZIP madre con {len(sub_zips)} sub-ZIPs (uno por comercio)")

        if not sub_zips:
            raise ScraperError(
                f"SEPA: ZIP no tiene sub-ZIPs ni CSVs reconocibles. "
                f"Encontrados: {zf_madre.namelist()[:5]}"
            )

        todos: list[PrecioRelevado] = []
        procesados, con_carne = 0, 0
        for sub_name in sub_zips:
            try:
                sub_data = zf_madre.read(sub_name)
                precios = self._procesar_comercio_zip(sub_data, sub_name)
                procesados += 1
                if precios:
                    con_carne += 1
                    todos.extend(precios)
            except Exception as e:
                log.warning(f"[SEPA] error procesando {sub_name}: {e}")
                continue

        log.info(f"[SEPA] Procesados {procesados} comercios, {con_carne} con cortes "
                 f"de interés. Total: {len(todos)} precios.")
        if not todos:
            raise ScraperError(
                "SEPA: ningún sub-ZIP devolvió cortes vacunos reconocibles. "
                "Probable cambio en estructura de columnas."
            )
        return todos

    async def relevar(self) -> list[PrecioRelevado]:
        zip_url = await self._resolver_zip_url()
        contenido = await self._descargar_zip(zip_url)
        log.info(f"[SEPA] ZIP descargado ({len(contenido) / 1e6:.1f} MB), procesando...")
        return self._procesar_zip(contenido)
