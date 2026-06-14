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
SEPA_DATASET_URL = "https://datos.gob.ar/dataset/produccion-precios-claros---base-sepa"
# Catálogo CKAN ESTABLE (no se cae como el host de descarga). Lista los ZIP por día.
SEPA_CKAN_API = ("https://datos.gob.ar/api/3/action/package_show"
                 "?id=produccion-precios-claros---base-sepa")

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

    async def _resolver_zip_urls(self) -> list[str]:
        """
        Lista las URLs de los ZIP (uno por día de la semana) desde el catálogo
        ESTABLE datos.gob.ar (CKAN API). El host de descarga
        (datos.produccion.gob.ar) a veces se cae, pero el catálogo no.

        Devuelve las URLs ordenadas: el día de hoy primero, luego el resto,
        para que `relevar` pruebe en orden hasta que una baje.
        """
        if SEPA_FORCED_ZIP_URL:
            return [SEPA_FORCED_ZIP_URL]

        try:
            data = await self.get_json(SEPA_CKAN_API)
        except Exception as e:
            raise ScraperError(
                f"SEPA: no se pudo leer el catálogo datos.gob.ar: {e}"
            )

        recursos = data.get("result", {}).get("resources", [])
        zips = [r["url"] for r in recursos
                if (r.get("format", "").upper() == "ZIP" and r.get("url"))]
        if not zips:
            raise ScraperError(
                "SEPA: el catálogo no listó ningún ZIP. "
                "Probable cambio de estructura del dataset."
            )

        # Ordenar para probar el día de hoy primero (más fresco).
        # weekday(): 0=lunes ... 6=domingo (independiente del locale).
        import datetime as _dt
        dias = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
        hoy = dias[_dt.datetime.now().weekday()]
        zips.sort(key=lambda u: 0 if hoy in u.lower() else 1)
        log.info(f"[SEPA] {len(zips)} ZIPs en catálogo, probando '{hoy}' primero")
        return zips

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

    def _convertir_a_kg(self, precio: float, cantidad: float, unidad: str) -> float | None:
        """Convierte precio del paquete a precio por kilogramo."""
        if cantidad <= 0:
            return None
        u = unidad.lower().strip()
        if u in ("kg", "kgr", "kgs"):
            return precio / cantidad
        if u in ("g", "gr", "grs", "gramos"):
            return precio * 1000 / cantidad
        # Para otros (ltr, un, cmq) en general no aplica a carne — descartamos
        return None

    def _procesar_comercio_zip(self, sub_data: bytes, sub_name: str) -> list[PrecioRelevado]:
        """Procesa el ZIP interno de UN comercio. SEPA actual: productos.csv tiene
        descripcion + precio_lista en una sola tabla, por sucursal."""
        try:
            zf = zipfile.ZipFile(io.BytesIO(sub_data))
        except zipfile.BadZipFile:
            return []

        f_comercio = self._find_csv(zf, "comercio")
        f_productos = self._find_csv(zf, "productos", "producto")

        if not f_productos:
            return []

        # Detectar bandera (cadena) leyendo comercio.csv
        bandera = None
        if f_comercio:
            try:
                for row in self._open_csv(zf, f_comercio):
                    nombre = (row.get("comercio_bandera_nombre")
                              or row.get("comercio_razon_social")
                              or row.get("razon_social") or "")
                    bandera = _normalizar_bandera(nombre)
                    if bandera:
                        break
            except Exception:
                pass

        if not bandera:
            return []

        # productos.csv: filtrar por carne, agrupar por id_producto
        # (varias filas por producto, una por sucursal donde está)
        bucket: dict[str, dict] = {}

        try:
            for row in self._open_csv(zf, f_productos):
                descripcion = (row.get("productos_descripcion") or "").strip()
                if not descripcion:
                    continue
                corte = normalizar(descripcion)
                if not corte:
                    continue

                try:
                    precio = float(row.get("productos_precio_lista") or 0)
                except (ValueError, TypeError):
                    continue
                if precio <= 100:
                    continue

                try:
                    cantidad = float(row.get("productos_cantidad_presentacion") or 1)
                except (ValueError, TypeError):
                    cantidad = 1.0
                unidad = row.get("productos_unidad_medida_presentacion") or "kg"

                precio_kg = self._convertir_a_kg(precio, cantidad, unidad)
                if precio_kg is None or precio_kg < 1000 or precio_kg > 200000:
                    continue   # filtro de sanity para descartar ruido

                pid = (row.get("id_producto") or descripcion).strip()
                if pid not in bucket:
                    bucket[pid] = {
                        "nombre": descripcion,
                        "corte": corte,
                        "marca": (row.get("productos_marca") or "").strip() or None,
                        "precios": [],
                    }
                bucket[pid]["precios"].append(precio_kg)
        except Exception as e:
            log.debug(f"[SEPA] error productos en {sub_name}: {e}")
            return []

        if not bucket:
            return []

        ahora = datetime.now()
        resultados: list[PrecioRelevado] = []
        for data in bucket.values():
            if not data["precios"]:
                continue
            resultados.append(PrecioRelevado(
                carniceria=bandera,
                corte_original=data["nombre"],
                corte_normalizado=data["corte"],
                precio_kg=round(median(data["precios"]), 2),
                fecha=ahora,
                segmento=SEGMENTOS.get(bandera, "commodity"),
                url_fuente=SEPA_DATASET_URL,
                marca=data["marca"],
            ))
        log.debug(f"[SEPA] {bandera}: {len(resultados)} cortes en {sub_name}")
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
        urls = await self._resolver_zip_urls()
        ultimo_error = None
        # Probar los ZIP en orden (hoy primero) hasta que uno baje y procese.
        for url in urls:
            try:
                contenido = await self._descargar_zip(url)
                log.info(f"[SEPA] ZIP descargado ({len(contenido)/1e6:.1f} MB), procesando...")
                precios = self._procesar_zip(contenido)
                if precios:
                    return precios
            except Exception as e:
                ultimo_error = e
                log.warning(f"[SEPA] {url.split('/')[-1]} falló ({type(e).__name__}), "
                            f"probando siguiente día...")
                continue
        raise ScraperError(
            f"SEPA: ninguno de los {len(urls)} ZIP se pudo descargar/procesar. "
            f"El host datos.produccion.gob.ar puede estar caído. "
            f"Último error: {ultimo_error}"
        )
