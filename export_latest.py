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

# Cortes que queremos exponer (los más relevantes para asado / día a día)
CORTES_DESTACADOS = [
    "asado",
    "bife_angosto",
    "bife_ancho",
    "vacio",
    "matambre",
    "peceto",
    "cuadril",
    "tapa_cuadril",
    "colita_cuadril",
    "tapa_asado",
    "lomo",
    "osobuco",
    "picada_comun",
    "picada_especial",
    "entrana",
    "nalga",
]


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

    cortes_out = {}
    for corte in CORTES_DESTACADOS:
        rows = list(cur.execute(
            "SELECT carniceria, precio_kg, url_fuente FROM precios "
            "WHERE fecha = ? AND corte_normalizado = ? AND disponible = 1 "
            "ORDER BY precio_kg ASC",
            (ultima, corte)
        ))
        if not rows:
            continue

        precios = [
            {"carniceria": r["carniceria"], "precio_kg": r["precio_kg"], "url": r["url_fuente"] or ""}
            for r in rows
        ]
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


if __name__ == "__main__":
    main()
