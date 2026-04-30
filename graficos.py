"""
Genera gráficos de tendencia por corte en el tiempo.

Para cada corte trackeado, una línea por carnicería mostrando cómo
evolucionó el precio $/kg en los últimos N días.

Los PNG se guardan en reports/graficos_<fecha>/ y se embeben en el PDF.
"""
import logging
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict
import sqlite3

import matplotlib

matplotlib.use("Agg")  # backend sin GUI, importante para correr en cron/server
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

from normalizador import corte_pretty
from storage import DB_PATH

log = logging.getLogger(__name__)

# Paleta consistente por carnicería
COLORES = {
    "Coto":       "#E30613",
    "Carrefour":  "#0D5EAF",
    "Jumbo":      "#00A859",
    "Disco":      "#E30613",
    "Día":        "#FFCB05",
    "Día Express":"#FFA500",
    "Vea":        "#7CB342",
    "ChangoMás":  "#FF6F00",
    "La Anónima": "#003DA5",
    "RES":        "#8B0000",
    "Josimar":    "#A0522D",
    "Las Heras":  "#7B3F00",
    "Maxiconsumo":"#1B5E20",
    "Lo de Stéffano": "#4B0082",
    "IPCVA (referencia)": "#000000",
}
COLOR_DEFAULT = "#666666"


def _datos_historicos(dias_atras: int = 90) -> dict[str, dict[str, list[tuple[datetime, float]]]]:
    """
    Devuelve {corte: {carniceria: [(fecha, precio), ...]}}
    de los últimos `dias_atras` días.
    """
    fecha_min = (datetime.now() - timedelta(days=dias_atras)).strftime("%Y-%m-%d")

    if not DB_PATH.exists():
        return {}

    with sqlite3.connect(DB_PATH) as con:
        con.row_factory = sqlite3.Row
        cur = con.execute(
            """
            SELECT fecha, carniceria, corte_normalizado, AVG(precio_kg) AS p
            FROM precios
            WHERE fecha >= ?
            GROUP BY fecha, carniceria, corte_normalizado
            ORDER BY fecha
            """,
            (fecha_min,),
        )
        rows = list(cur.fetchall())

    datos: dict[str, dict[str, list[tuple[datetime, float]]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        try:
            d = datetime.strptime(r["fecha"], "%Y-%m-%d")
        except ValueError:
            continue
        datos[r["corte_normalizado"]][r["carniceria"]].append((d, r["p"]))
    return datos


def _grafico_corte(corte: str, series: dict[str, list[tuple[datetime, float]]],
                   output_path: Path) -> bool:
    """Genera un PNG de tendencia para un corte. Devuelve False si no había datos suficientes."""
    # Solo tiene sentido graficar si hay al menos 2 puntos en alguna serie
    if not any(len(s) >= 2 for s in series.values()):
        return False

    fig, ax = plt.subplots(figsize=(9, 4.5), dpi=120)

    # Ordenar carnicerías para tener leyenda consistente
    for carn in sorted(series.keys()):
        puntos = sorted(series[carn])
        if len(puntos) < 1:
            continue
        fechas = [p[0] for p in puntos]
        precios = [p[1] for p in puntos]
        color = COLORES.get(carn, COLOR_DEFAULT)
        ax.plot(fechas, precios, marker="o", linewidth=2, markersize=5,
                label=carn, color=color)

    ax.set_title(f"Tendencia de precio — {corte_pretty(corte)}",
                 fontsize=13, fontweight="bold", pad=12)
    ax.set_ylabel("$/kg", fontsize=10)
    ax.set_xlabel("")
    ax.grid(True, alpha=0.3, linestyle="--")
    ax.legend(loc="upper left", fontsize=8, framealpha=0.9)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # Formato de eje X: fechas legibles
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m"))
    fig.autofmt_xdate(rotation=30, ha="right")

    # Formato de eje Y: $ con separador de miles
    ax.yaxis.set_major_formatter(
        plt.FuncFormatter(lambda x, _: f"${x:,.0f}".replace(",", "."))
    )

    fig.tight_layout()
    fig.savefig(output_path, bbox_inches="tight")
    plt.close(fig)
    return True


def generar_graficos(output_dir: Path, dias_atras: int = 90) -> dict[str, Path]:
    """
    Genera un PNG por corte que tenga datos suficientes.
    Devuelve {corte: ruta_png} solo para los que se generaron.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    datos = _datos_historicos(dias_atras)

    if not datos:
        log.warning("No hay datos históricos para graficar")
        return {}

    generados = {}
    for corte, series in datos.items():
        path = output_dir / f"tendencia_{corte}.png"
        if _grafico_corte(corte, series, path):
            generados[corte] = path
            log.info(f"  📈 {corte}: {path.name}")

    return generados


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    out = Path(__file__).parent / "reports" / f"graficos_{datetime.now():%Y-%m-%d_%H%M}"
    paths = generar_graficos(out)
    print(f"\n{len(paths)} gráficos generados en {out}")
