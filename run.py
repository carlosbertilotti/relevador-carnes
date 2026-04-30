"""
Orquestador principal del relevamiento (async, paralelo).

Uso:
    python run.py                      # corre todo en paralelo
    python run.py --solo coto          # solo un scraper
    python run.py --no-reportes        # solo releva y guarda
    python run.py --no-notif           # genera reportes pero no notifica
    python run.py --no-graficos        # más rápido
    python run.py --no-alertas         # sin alertas activas
    python run.py --concurrencia 4     # cuántos scrapers en paralelo (default 6)
    python run.py -v                   # logging detallado
"""
import argparse
import asyncio
import logging
import sys
from datetime import datetime
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Cadenas masivas / commodity (VTEX)
from scrapers.coto import CotoScraper
from scrapers.carrefour import CarrefourScraper
from scrapers.jumbo import JumboScraper
from scrapers.disco import DiscoScraper
from scrapers.dia import DiaScraper
from scrapers.vea import VeaScraper
from scrapers.changomas import ChangoMasScraper
# from scrapers.diaexpress import DiaExpressScraper  # activar si querés diferenciar
from scrapers.maxiconsumo import MaxiconsumoScraper

# HTML / WooCommerce / custom
from scrapers.la_anonima import LaAnonimaScraper
from scrapers.res import ResScraper
from scrapers.ganadera_las_heras import GanaderaLasHerasScraper
from scrapers.josimar import JosimarScraper
# from scrapers.lo_de_steffano import LoDeSteffanoScraper  # activar con URL real

# SEPA — fuente oficial del gobierno (cubre ~50 cadenas en una corrida)
from scrapers.sepa import SepaScraper

# HTML scrapers (respaldo cuando la API VTEX devuelve 0)
from scrapers.carrefour_html import CarrefourHtmlScraper
from scrapers.jumbo_html import JumboHtmlScraper
from scrapers.dia_html import DiaHtmlScraper

# Benchmark
from scrapers.ipcva import IpcvaScraper

from storage import guardar, registrar_corrida
from reporte import generar_todos
from graficos import generar_graficos
from notificaciones import notificar_todo
from alertas import detectar_y_notificar_alertas


SCRAPERS = {
    # ─── Fuente principal: SEPA oficial (cubre ~50 cadenas) ───
    "sepa":         SepaScraper,

    # ─── HTML scrapers (cuando la API VTEX da 0) ───
    "carrefour_html": CarrefourHtmlScraper,
    "jumbo_html":     JumboHtmlScraper,
    "dia_html":       DiaHtmlScraper,

    # ─── HTML / WooCommerce / custom ───
    "la_anonima":   LaAnonimaScraper,
    "las_heras":    GanaderaLasHerasScraper,
    "res":          ResScraper,
    "josimar":      JosimarScraper,

    # ─── VTEX API (siguen disponibles, pueden devolver 0) ───
    "coto":         CotoScraper,
    "carrefour":    CarrefourScraper,
    "dia":          DiaScraper,
    "vea":          VeaScraper,
    "changomas":    ChangoMasScraper,
    "jumbo":        JumboScraper,
    "disco":        DiscoScraper,
    "maxiconsumo":  MaxiconsumoScraper,

    # ─── Benchmark ───
    "ipcva":        IpcvaScraper,
}

# Subset por defecto: solo los confiables (SEPA + HTML scrapers).
# Para correr TODOS, usar --solo o --todos.
SCRAPERS_DEFAULT = ["sepa", "la_anonima", "las_heras", "res", "josimar"]


def configurar_logging(verboso: bool):
    nivel = logging.DEBUG if verboso else logging.INFO
    logging.basicConfig(
        level=nivel,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("matplotlib").setLevel(logging.WARNING)


async def correr_scraper(ScraperCls, sem: asyncio.Semaphore, log: logging.Logger):
    """Corre un scraper bajo el semáforo global de concurrencia."""
    async with sem:
        log.info(f"▶  {ScraperCls.nombre} ...")
        async with ScraperCls() as scraper:
            res = await scraper.correr()
        if res.ok:
            marca = "⚠️  sospechoso" if res.sospechoso else "✓"
            log.info(f"{marca} {res.nombre}: {len(res.precios)} cortes en {res.duracion_s}s")
        else:
            log.error(f"✗ {res.nombre}: {res.error}")
        return res


async def main_async(args):
    log = logging.getLogger("run")
    log.info("=" * 60)
    log.info(f"Inicio relevamiento — {datetime.now():%Y-%m-%d %H:%M:%S}")
    log.info("=" * 60)

    if args.solo:
        a_correr = [SCRAPERS[args.solo]]
    elif args.todos:
        a_correr = list(SCRAPERS.values())
    else:
        a_correr = [SCRAPERS[k] for k in SCRAPERS_DEFAULT]

    sem = asyncio.Semaphore(args.concurrencia)
    tareas = [correr_scraper(cls, sem, log) for cls in a_correr]
    resultados = await asyncio.gather(*tareas)

    todos_precios = []
    fallidos = []
    sospechosos = []
    ahora = datetime.now()

    for res in resultados:
        registrar_corrida(ahora, res.nombre, len(res.precios),
                          res.duracion_s, res.error, res.sospechoso)
        if res.ok:
            todos_precios.extend(res.precios)
            if res.sospechoso:
                sospechosos.append((res.nombre, len(res.precios)))
        else:
            fallidos.append((res.nombre, res.error))

    if not todos_precios:
        log.error("⚠️  Ningún scraper devolvió datos. Revisá la configuración.")
        sys.exit(1)

    log.info(f"📦 Guardando {len(todos_precios)} precios en BD...")
    guardar(todos_precios)

    if args.no_reportes:
        log.info("✅ Listo (sin reportes).")
        return

    paths_graficos = {}
    if not args.no_graficos:
        log.info("📈 Generando gráficos de tendencia...")
        graficos_dir = (Path(__file__).parent / "reports"
                        / f"graficos_{datetime.now():%Y-%m-%d_%H%M}")
        paths_graficos = generar_graficos(graficos_dir)
        log.info(f"   {len(paths_graficos)} gráficos generados")

    log.info("📄 Generando reportes md / xlsx / pdf...")
    paths = generar_todos(fallidos, paths_graficos=paths_graficos,
                          sospechosos=sospechosos)
    log.info(f"   md:   {paths['md']}")
    log.info(f"   xlsx: {paths['xlsx']}")
    log.info(f"   pdf:  {paths['pdf']}")

    if not args.no_alertas:
        log.info("🚨 Detectando alertas (variaciones >5%)...")
        detectar_y_notificar_alertas(umbral_pct=5.0)

    if not args.no_notif:
        log.info("─" * 60)
        notificar_todo(paths, paths_graficos)

    if fallidos:
        log.warning(f"⚠️  {len(fallidos)} scraper(s) fallaron:")
        for nombre, err in fallidos:
            log.warning(f"     - {nombre}: {err}")
    if sospechosos:
        log.warning(f"⚠️  {len(sospechosos)} scraper(s) sospechosos (pocos cortes):")
        for nombre, n in sospechosos:
            log.warning(f"     - {nombre}: solo {n} cortes")

    log.info("✅ Listo.")


def main():
    parser = argparse.ArgumentParser(description="Relevador de precios de carne")
    parser.add_argument("--solo", choices=list(SCRAPERS.keys()),
                        help="Correr un solo scraper")
    parser.add_argument("--todos", action="store_true",
                        help=f"Correr TODOS los scrapers (default: solo {SCRAPERS_DEFAULT})")
    parser.add_argument("--no-reportes", action="store_true")
    parser.add_argument("--no-notif", action="store_true")
    parser.add_argument("--no-graficos", action="store_true")
    parser.add_argument("--no-alertas", action="store_true")
    parser.add_argument("--concurrencia", type=int, default=6,
                        help="Cantidad de scrapers en paralelo (default 6)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    configurar_logging(args.verbose)
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
