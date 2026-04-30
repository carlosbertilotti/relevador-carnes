"""
Persistencia en SQLite.

Tabla `precios`: una fila por (fecha, carniceria, corte_original).
Mantenemos histórico para calcular variaciones y tendencias.

Migraciones no destructivas: si la tabla ya existe sin columnas nuevas
(peso_g, con_hueso, marca, disponible), se agregan con ALTER TABLE.
"""
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timedelta
from typing import Iterable, Optional

from scrapers.base import PrecioRelevado

log = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent / "data" / "precios.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    carniceria TEXT NOT NULL,
    segmento TEXT NOT NULL,
    corte_original TEXT NOT NULL,
    corte_normalizado TEXT NOT NULL,
    precio_kg REAL NOT NULL,
    moneda TEXT NOT NULL DEFAULT 'ARS',
    url_fuente TEXT,
    peso_g INTEGER,
    con_hueso INTEGER,
    marca TEXT,
    disponible INTEGER DEFAULT 1,
    UNIQUE(fecha, carniceria, corte_original)
);

CREATE INDEX IF NOT EXISTS idx_precios_corte    ON precios(corte_normalizado);
CREATE INDEX IF NOT EXISTS idx_precios_fecha    ON precios(fecha);
CREATE INDEX IF NOT EXISTS idx_precios_carn     ON precios(carniceria);
CREATE INDEX IF NOT EXISTS idx_precios_segmento ON precios(segmento);

CREATE TABLE IF NOT EXISTS corridas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    carniceria TEXT NOT NULL,
    cortes_relevados INTEGER NOT NULL,
    duracion_s REAL NOT NULL,
    error TEXT,
    sospechoso INTEGER DEFAULT 0,
    UNIQUE(fecha, carniceria)
);
CREATE INDEX IF NOT EXISTS idx_corridas_fecha ON corridas(fecha);
"""

COLUMNAS_NUEVAS = [
    ("peso_g",     "INTEGER"),
    ("con_hueso",  "INTEGER"),
    ("marca",      "TEXT"),
    ("disponible", "INTEGER DEFAULT 1"),
]


def _migrar_columnas(con: sqlite3.Connection):
    """ALTER TABLE para agregar columnas que no existían en versiones viejas."""
    cur = con.execute("PRAGMA table_info(precios)")
    existentes = {row[1] for row in cur.fetchall()}
    for nombre, tipo in COLUMNAS_NUEVAS:
        if nombre not in existentes:
            log.info(f"Migración: agregando columna precios.{nombre}")
            con.execute(f"ALTER TABLE precios ADD COLUMN {nombre} {tipo}")


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as con:
        con.executescript(SCHEMA)
        _migrar_columnas(con)


def guardar(precios: Iterable[PrecioRelevado]):
    init_db()
    rows = [
        (
            p.fecha.strftime("%Y-%m-%d"),
            p.carniceria,
            p.segmento,
            p.corte_original,
            p.corte_normalizado,
            p.precio_kg,
            p.moneda,
            p.url_fuente,
            p.peso_g,
            int(p.con_hueso) if p.con_hueso is not None else None,
            p.marca,
            int(p.disponible),
        )
        for p in precios
    ]
    if not rows:
        log.warning("guardar(): no hay precios para guardar")
        return
    with sqlite3.connect(DB_PATH) as con:
        con.executemany(
            """
            INSERT OR REPLACE INTO precios
            (fecha, carniceria, segmento, corte_original, corte_normalizado,
             precio_kg, moneda, url_fuente, peso_g, con_hueso, marca, disponible)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    log.info(f"Guardados {len(rows)} precios en {DB_PATH}")


def registrar_corrida(fecha: datetime, nombre: str, cortes: int,
                      duracion: float, error: Optional[str], sospechoso: bool):
    """Registra el estado de un scraper en una corrida (para health monitoring)."""
    init_db()
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            """
            INSERT OR REPLACE INTO corridas
            (fecha, carniceria, cortes_relevados, duracion_s, error, sospechoso)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (fecha.strftime("%Y-%m-%d"), nombre, cortes, duracion, error,
             int(sospechoso)),
        )


# ─── Lectura ────────────────────────────────────────────────────────────────

def _conn():
    init_db()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def obtener_ultimo_relevamiento() -> list[dict]:
    with _conn() as con:
        cur = con.execute(
            """
            SELECT * FROM precios
            WHERE fecha = (SELECT MAX(fecha) FROM precios)
            ORDER BY corte_normalizado, carniceria
            """
        )
        return [dict(r) for r in cur.fetchall()]


def obtener_relevamiento_anterior() -> list[dict]:
    with _conn() as con:
        cur = con.execute(
            """
            SELECT * FROM precios
            WHERE fecha = (
                SELECT MAX(fecha) FROM precios
                WHERE fecha < (SELECT MAX(fecha) FROM precios)
            )
            """
        )
        return [dict(r) for r in cur.fetchall()]


def historial_corte(corte_normalizado: str) -> list[dict]:
    with _conn() as con:
        cur = con.execute(
            """
            SELECT fecha, carniceria, AVG(precio_kg) AS precio_kg
            FROM precios
            WHERE corte_normalizado = ?
            GROUP BY fecha, carniceria
            ORDER BY fecha
            """,
            (corte_normalizado,),
        )
        return [dict(r) for r in cur.fetchall()]


def historial_completo(dias: int = 90) -> list[dict]:
    """Toda la data de los últimos N días, agrupada por (fecha, carniceria, corte)."""
    fecha_min = (datetime.now() - timedelta(days=dias)).strftime("%Y-%m-%d")
    with _conn() as con:
        cur = con.execute(
            """
            SELECT fecha, carniceria, segmento, corte_normalizado,
                   AVG(precio_kg) AS precio_kg, COUNT(*) AS n
            FROM precios
            WHERE fecha >= ?
            GROUP BY fecha, carniceria, corte_normalizado
            ORDER BY fecha
            """,
            (fecha_min,),
        )
        return [dict(r) for r in cur.fetchall()]


def fechas_disponibles() -> list[str]:
    with _conn() as con:
        cur = con.execute("SELECT DISTINCT fecha FROM precios ORDER BY fecha DESC")
        return [r[0] for r in cur.fetchall()]


def estado_scrapers(ultimas_n_corridas: int = 10) -> list[dict]:
    """Para el dashboard: qué scrapers están sanos vs sospechosos."""
    with _conn() as con:
        cur = con.execute(
            """
            SELECT carniceria,
                   MAX(fecha) AS ultima_fecha,
                   AVG(cortes_relevados) AS promedio_cortes,
                   SUM(CASE WHEN sospechoso=1 THEN 1 ELSE 0 END) AS sospechosas,
                   SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS fallidas,
                   COUNT(*) AS total
            FROM (
                SELECT * FROM corridas ORDER BY fecha DESC LIMIT ?
            )
            GROUP BY carniceria
            """,
            (ultimas_n_corridas * 20,),  # holgura, ya que limita por filas no por carn
        )
        return [dict(r) for r in cur.fetchall()]
