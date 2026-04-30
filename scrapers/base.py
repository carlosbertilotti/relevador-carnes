"""
Clase base para todos los scrapers (async).

Cada scraper concreto hereda de ScraperBase (o VTEXScraper / WooCommerceScraper)
e implementa relevar() devolviendo una lista de PrecioRelevado.

Diseño:
- httpx.AsyncClient compartido por scraper, con semáforo para limitar concurrencia
- Reintentos exponenciales en errores transitorios (timeout, 5xx, conexión)
- Health check: cada scraper define `min_cortes_esperados`; si devuelve menos,
  se marca como "sospechoso" en el ResultadoScrape (probable cambio de HTML).
"""
import asyncio
import logging
import random
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional

import httpx

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 RelevadorPreciosCarnes/2.0"
)


@dataclass
class PrecioRelevado:
    """Un precio individual relevado de una carnicería para un corte."""
    carniceria: str
    corte_original: str
    corte_normalizado: str
    precio_kg: float
    fecha: datetime
    segmento: str = "commodity"     # "commodity" | "premium" | "intermedio" | "mayorista" | "benchmark"
    moneda: str = "ARS"
    url_fuente: str = ""
    peso_g: Optional[int] = None    # peso del paquete en gramos, si se conoce
    con_hueso: Optional[bool] = None
    marca: Optional[str] = None
    disponible: bool = True


@dataclass
class ResultadoScrape:
    """Resultado completo de un scraper, incluye datos + diagnóstico."""
    nombre: str
    precios: list[PrecioRelevado] = field(default_factory=list)
    error: Optional[str] = None
    duracion_s: float = 0.0
    sospechoso: bool = False        # True si devolvió menos de min_cortes_esperados

    @property
    def ok(self) -> bool:
        return self.error is None and len(self.precios) > 0


class ScraperError(Exception):
    """Error específico de scraping (no recuperable después de reintentos)."""


class ScraperBase:
    """Base genérica async con cliente HTTP, reintentos y helpers."""
    nombre: str = ""
    segmento: str = "commodity"
    base_url: str = ""
    delay_range: tuple[float, float] = (0.3, 0.8)   # entre requests del MISMO scraper
    timeout: float = 30.0
    max_retries: int = 3
    backoff_base: float = 1.5
    max_concurrent_requests: int = 4                  # por scraper
    min_cortes_esperados: int = 3                     # health check

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._sem: Optional[asyncio.Semaphore] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/html, */*",
                "Accept-Language": "es-AR,es;q=0.9",
            },
            timeout=self.timeout,
            follow_redirects=True,
            http2=True,
        )
        self._sem = asyncio.Semaphore(self.max_concurrent_requests)
        return self

    async def __aexit__(self, *_):
        if self._client:
            await self._client.aclose()

    async def _delay(self):
        await asyncio.sleep(random.uniform(*self.delay_range))

    async def _request(self, url: str, **kwargs) -> httpx.Response:
        """GET con reintentos exponenciales para errores transitorios."""
        assert self._client and self._sem
        last_exc: Optional[Exception] = None
        for intento in range(1, self.max_retries + 1):
            async with self._sem:
                await self._delay()
                try:
                    log.debug(f"[{self.nombre}] GET {url} (intento {intento})")
                    r = await self._client.get(url, **kwargs)
                    if r.status_code >= 500:
                        raise httpx.HTTPStatusError(
                            f"server {r.status_code}", request=r.request, response=r
                        )
                    r.raise_for_status()
                    return r
                except (httpx.TimeoutException, httpx.NetworkError,
                        httpx.HTTPStatusError, httpx.RemoteProtocolError) as e:
                    last_exc = e
                    if intento < self.max_retries:
                        wait = self.backoff_base ** intento + random.uniform(0, 0.5)
                        log.debug(f"[{self.nombre}] retry {intento} en {wait:.1f}s ({e})")
                        await asyncio.sleep(wait)
                    else:
                        raise
        raise ScraperError(f"{self.nombre}: {last_exc}")

    async def get_json(self, url: str, **kwargs):
        r = await self._request(url, **kwargs)
        return r.json()

    async def get_html(self, url: str, **kwargs) -> str:
        r = await self._request(url, **kwargs)
        return r.text

    async def relevar(self) -> list[PrecioRelevado]:
        raise NotImplementedError

    async def correr(self) -> ResultadoScrape:
        """
        Wrapper que captura errores y mide tiempo. Es lo que usa run.py.
        Nunca lanza excepción — todo va al ResultadoScrape.
        """
        t0 = asyncio.get_event_loop().time()
        res = ResultadoScrape(nombre=self.nombre)
        try:
            res.precios = await self.relevar()
        except Exception as e:
            res.error = f"{type(e).__name__}: {e}"
            log.error(f"[{self.nombre}] falló: {res.error}")
        res.duracion_s = round(asyncio.get_event_loop().time() - t0, 1)
        if res.ok and len(res.precios) < self.min_cortes_esperados:
            res.sospechoso = True
            log.warning(
                f"[{self.nombre}] sospechoso: solo {len(res.precios)} cortes "
                f"(esperaba >={self.min_cortes_esperados}). ¿Cambió el HTML?"
            )
        return res
