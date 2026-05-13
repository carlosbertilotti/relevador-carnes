"""
Exporta el último snapshot de precios a data/latest.json
para que apps externas (ej. Midia) lo consuman desde GitHub raw.

Output: data/latest.json con estructura
{
  "ultima_corrida": "2026-05-01",
  "generado": "2026-05-11T13:00:00Z",
  "carnicerias": ["RES", "SEPA (oficial)", ...],
  "cortes": {
    "asado": {
      "mejor_precio": 18500,
      "mejor_carniceria": "RES",
      "promedio": 19200,
      "variacion_pct": -2.3,
      "precios": [
        {"carniceria": "RES", "precio_kg": 18500, "url": "..."},
        ...
      ]
    },
    ...
  }
}
"""
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path(__file__).parent / "data" / "precios.db"
OUT_PATH = Path(__file__).parent / "data" / "latest.json"

# Cortes con suficientes datos para mostrar (mínimo 2 carnicerías en últimos 30 días)
MIN_CARNICERIAS = 2

# Pisos mínimos esperados por kg (en pesos AR, mid-2026).
# Productos por debajo se descartan como anomalías (probablemente "BIFE BANDEJA"
# o sea bandejas chicas de 100-200g donde el scraper toma precio_unidad como precio_kg).
PRECIO_MIN_POR_CORTE = {
    "asado": 6000,
    "bife_angosto": 8000,
    "bife_ancho": 8000,
    "vacio": 5000,
    "matambre": 5000,
    "peceto": 10000,
    "lomo": 10000,
    "cuadril": 8000,
    "tapa_cuadril": 8000,
    "colita_cuadril": 7000,
    "tapa_asado": 5000,
    "osobuco": 4000,
    "picada_comun": 4000,
    "picada_especial": 5000,
    "entrana": 7000,
    "nalga": 8000,
    "tapa_nalga": 8000,
    "paleta": 5000,
    "roast_beef": 5000,
    "bola_lomo": 7000,
    "aguja": 4000,
    "falda": 4000,
    "tortuguita": 5000,
}
PRECIO_MIN_DEFAULT = 4000  # piso global para cortes no listados


def main():
    if not DB_PATH.exists():
        print(f"⚠️  No existe {DB_PATH}, corré primero el relevamiento")
        return

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    # Última fecha relevada
    row = cur.execute("SELECT MAX(fecha) AS f FROM precios").fetchone()
    if not row or not row["f"]:
        print("⚠️  No hay precios en la DB")
        return
    ultima = row["f"]

    # Fecha anterior (para calcular variación)
    row = cur.execute("SELECT MAX(fecha) AS f FROM precios WHERE fecha < ?", (ultima,)).fetchone()
    anterior = row["f"] if row else None

    # Carnicerias activas en la última corrida
    carnicerias = [r["carniceria"] for r in cur.execute(
        "SELECT DISTINCT carniceria FROM precios WHERE fecha = ? ORDER BY carniceria", (ultima,)
    )]

    # Sacamos todos los cortes disponibles en la última corrida (filtrando los muy pobres)
    cortes_disponibles = [r["corte"] for r in cur.execute(
        "SELECT corte_normalizado AS corte, COUNT(DISTINCT carniceria) AS n "
        "FROM precios WHERE fecha = ? AND disponible = 1 "
        "GROUP BY corte_normalizado HAVING n >= ? "
        "ORDER BY corte_normalizado",
        (ultima, MIN_CARNICERIAS)
    )]

    cortes_out = {}
    descartados = 0
    for corte in cortes_disponibles:
        piso = PRECIO_MIN_POR_CORTE.get(corte, PRECIO_MIN_DEFAULT)
        rows = list(cur.execute(
            "SELECT carniceria, corte_original, precio_kg, url_fuente FROM precios "
            "WHERE fecha = ? AND corte_normalizado = ? AND disponible = 1 "
            "ORDER BY precio_kg ASC",
            (ultima, corte)
        ))
        if not rows:
            continue

        # Filtramos anomalías: precios irrazonablemente bajos (probablemente bandejas chicas mal parseadas)
        # Y nombres con palabras delatoras de tamaño chico
        anomaly_keywords = ("bandeja", "paquete", "bj.", "bja", "tray", "x100", "x150", "x200", "x250", "x300", "x350", "x400")
        precios = []
        for r in rows:
            if r["precio_kg"] < piso:
                descartados += 1
                continue
            nombre_low = (r["corte_original"] or "").lower()
            if any(k in nombre_low for k in anomaly_keywords) and r["precio_kg"] < piso * 1.5:
                # bandeja + precio sospechosamente bajo → probable error
                descartados += 1
                continue
            precios.append({"carniceria": r["carniceria"], "precio_kg": r["precio_kg"], "url": r["url_fuente"] or ""})

        if not precios:
            continue
        mejor = precios[0]
        promedio = round(sum(p["precio_kg"] for p in precios) / len(precios), 2)

        # Variación vs corrida anterior (en promedio)
        variacion_pct = None
        if anterior:
            prev_avg = cur.execute(
                "SELECT AVG(precio_kg) AS a FROM precios "
                "WHERE fecha = ? AND corte_normalizado = ? AND disponible = 1",
                (anterior, corte)
            ).fetchone()["a"]
            if prev_avg and prev_avg > 0:
                variacion_pct = round(((promedio - prev_avg) / prev_avg) * 100, 1)

        cortes_out[corte] = {
            "mejor_precio": mejor["precio_kg"],
            "mejor_carniceria": mejor["carniceria"],
            "promedio": promedio,
            "variacion_pct": variacion_pct,
            "precios": precios[:8],  # Top 8 más baratos
        }

    out = {
        "ultima_corrida": ultima,
        "anterior": anterior,
        "generado": datetime.now(timezone.utc).isoformat(),
        "carnicerias": carnicerias,
        "cortes": cortes_out,
    }

    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"✅ Exportado {OUT_PATH}: {len(cortes_out)} cortes, corrida {ultima}")
    if descartados:
        print(f"   ⚠️  {descartados} precios descartados por anomalías (bandejas chicas, etc)")


if __name__ == "__main__":
    main()
