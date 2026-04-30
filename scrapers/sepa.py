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

    def _procesar_zip(self, contenido: bytes) -> list[PrecioRelevado]:
        try:
            zf = zipfile.ZipFile(io.BytesIO(contenido))
        except zipfile.BadZipFile as e:
            raise ScraperError(f"SEPA: ZIP corrupto: {e}")

        log.info(f"[SEPA] archivos en el ZIP: {zf.namelist()[:10]}...")

        # SEPA típicamente expone CSVs llamados productos.csv, precios.csv,
        # sucursales.csv, comercio.csv (puede variar la mayúsculas o tener prefijo)
        def _abrir(name_pat: str):
            for n in zf.namelist():
                if name_pat in n.lower() and n.endswith(".csv"):
                    log.debug(f"[SEPA] usando archivo {n}")
                    return io.TextIOWrapper(zf.open(n), encoding="utf-8", errors="replace")
            return None

        f_productos = _abrir("producto")
        f_precios = _abrir("precio")
        f_comercio = _abrir("comercio")
        f_sucursales = _abrir("sucursal")

        if not (f_productos and f_precios):
            raise ScraperError(
                f"SEPA: ZIP no tiene los CSVs esperados "
                f"(productos.csv, precios.csv). Encontrados: {zf.namelist()}"
            )

        # Mapa id_comercio → bandera normalizada
        bandera_por_comercio: dict[str, str] = {}
        if f_comercio:
            reader = csv.DictReader(f_comercio, delimiter="|")
            # Si | no funciona, probar coma
            for row in reader:
                if not row:
                    continue
                if len(row) <= 1:
                    f_comercio.seek(0)
                    reader = csv.DictReader(f_comercio, delimiter=",")
                    break
            f_comercio.seek(0)
            reader = csv.DictReader(f_comercio, delimiter="|" if "|" in f_comercio.readline() else ",")
            f_comercio.seek(0)
            reader = csv.DictReader(f_comercio)  # auto-detect
            for row in reader:
                cid = row.get("id_comercio") or row.get("comercio_id") or ""
                cnom = row.get("comercio_razon_social") or row.get("razon_social") or row.get("comercio_nombre") or ""
                bandera = _normalizar_bandera(cnom)
                if cid and bandera:
                    bandera_por_comercio[cid] = bandera

        # Mapa id_sucursal → id_comercio
        comercio_por_sucursal: dict[str, str] = {}
        if f_sucursales:
            reader = csv.DictReader(f_sucursales)
            for row in reader:
                sid = row.get("id_sucursal") or row.get("sucursal_id") or ""
                cid = row.get("id_comercio") or row.get("comercio_id") or ""
                if sid and cid:
                    comercio_por_sucursal[sid] = cid

        # Mapa id_producto → (nombre, corte_normalizado)
        productos_carne: dict[str, tuple[str, str]] = {}
        reader = csv.DictReader(f_productos)
        for row in reader:
            pid = row.get("id_producto") or row.get("producto_id") or ""
            nombre = (row.get("productos_descripcion")
                      or row.get("producto_nombre")
                      or row.get("nombre")
                      or "")
            if not pid or not nombre:
                continue
            corte = normalizar(nombre)
            if corte:
                productos_carne[pid] = (nombre, corte)

        log.info(f"[SEPA] {len(productos_carne)} productos de carne encontrados")
        log.info(f"[SEPA] {len(bandera_por_comercio)} comercios de interés mapeados")

        # Acumulamos precios por (bandera, producto) → mediana de sucursales
        # (la mediana descarta outliers de promos puntuales)
        bucket: dict[tuple[str, str], list[float]] = defaultdict(list)

        reader = csv.DictReader(f_precios)
        ahora = datetime.now()
        n_filas = 0
        for row in reader:
            n_filas += 1
            pid = row.get("id_producto") or row.get("producto_id") or ""
            if pid not in productos_carne:
                continue
            sid = row.get("id_sucursal") or row.get("sucursal_id") or ""
            cid = comercio_por_sucursal.get(sid) or row.get("id_comercio") or ""
            bandera = bandera_por_comercio.get(cid)
            if not bandera:
                continue
            try:
                precio = float(row.get("productos_precio_lista") or
                               row.get("precio_lista") or
                               row.get("precio") or 0)
            except (ValueError, TypeError):
                continue
            if precio <= 100:    # filtra ruido
                continue
            bucket[(bandera, pid)].append(precio)

        log.info(f"[SEPA] {n_filas} filas de precios procesadas, "
                 f"{len(bucket)} combinaciones bandera×producto")

        resultados: list[PrecioRelevado] = []
        for (bandera, pid), precios in bucket.items():
            nombre, corte = productos_carne[pid]
            precio_kg = round(median(precios), 2)
            resultados.append(PrecioRelevado(
                carniceria=bandera,
                corte_original=nombre,
                corte_normalizado=corte,
                precio_kg=precio_kg,
                fecha=ahora,
                segmento=SEGMENTOS.get(bandera, "commodity"),
                url_fuente=SEPA_DATASET_URL,
            ))
        return resultados

    async def relevar(self) -> list[PrecioRelevado]:
        zip_url = await self._resolver_zip_url()
        contenido = await self._descargar_zip(zip_url)
        log.info(f"[SEPA] ZIP descargado ({len(contenido) / 1e6:.1f} MB), procesando...")
        return self._procesar_zip(contenido)
