"""
Genera datos sintéticos realistas para probar el dashboard sin scrapers reales.

Uso:
    python seed_demo.py              # carga 30 días de datos demo
    python seed_demo.py --dias 60    # más historia
    python seed_demo.py --limpiar    # borra todo y vuelve a sembrar

Una vez que los scrapers reales funcionen, podés borrar la data demo con:
    python seed_demo.py --limpiar
y después correr `python run.py` para datos reales.
"""
import argparse
import random
import sqlite3
from datetime import datetime, timedelta

from storage import DB_PATH, init_db, registrar_corrida


# Precios de referencia $/kg al 30/04/2026 (orientativos)
PRECIOS_BASE = {
    "asado":           8500,
    "vacio":          11500,
    "matambre":       10800,
    "bife_angosto":   13500,
    "bife_ancho":     12800,
    "lomo":           17000,
    "tapa_asado":      9200,
    "cuadril":        10200,
    "colita_cuadril": 11200,
    "peceto":         12500,
    "osobuco":         5800,
    "picada_comun":    6500,
    "picada_especial": 7800,
}

# Multiplicador por carnicería (commodity ~ base, premium ~1.5x, mayorista ~0.85x)
CARNICERIAS = [
    # (nombre, segmento, factor)
    ("Coto",                  "commodity",  1.00),
    ("Carrefour",             "commodity",  1.05),
    ("Día",                   "commodity",  0.95),
    ("Vea",                   "commodity",  0.98),
    ("ChangoMás",             "commodity",  0.97),
    ("La Anónima",            "commodity",  1.02),
    ("Jumbo",                 "intermedio", 1.18),
    ("Disco",                 "intermedio", 1.15),
    ("Las Heras",             "intermedio", 1.10),
    ("RES",                   "premium",    1.55),
    ("Josimar",               "premium",    1.45),
    ("Maxiconsumo",           "mayorista",  0.85),
    ("IPCVA (referencia)",    "benchmark",  0.78),
]


def generar(dias: int, limpiar: bool):
    init_db()

    if limpiar:
        with sqlite3.connect(DB_PATH) as con:
            con.execute("DELETE FROM precios")
            con.execute("DELETE FROM corridas")
            print(f"🗑️  BD limpiada")

    random.seed(42)
    hoy = datetime.now()
    inicio = hoy - timedelta(days=dias)

    # Inflación mensual realista: ~3% por mes acumulando
    rows = []
    corridas = []

    # Generar puntos cada 3-4 días (típico de relevamientos 2x/semana)
    fechas = []
    f = inicio
    while f <= hoy:
        fechas.append(f)
        f += timedelta(days=random.choice([3, 4]))

    for fecha in fechas:
        # Inflación acumulada desde inicio: ~0.1% por día
        dias_desde_inicio = (fecha - inicio).days
        inflacion = 1 + (dias_desde_inicio * 0.001)

        for carn, segmento, factor in CARNICERIAS:
            cortes_relevados = 0
            for corte, base in PRECIOS_BASE.items():
                # Algunas cadenas no relevan todos los cortes
                if random.random() < 0.15:
                    continue
                # Precios premium son más volátiles
                volatilidad = 0.04 if segmento == "premium" else 0.02
                ruido = random.gauss(1.0, volatilidad)
                precio_kg = round(base * factor * inflacion * ruido, 2)
                rows.append((
                    fecha.strftime("%Y-%m-%d"),
                    carn,
                    segmento,
                    f"{corte.replace('_', ' ').title()} (demo)",
                    corte,
                    precio_kg,
                    "ARS",
                    "https://demo.local/seed",
                    None, None, None, 1,
                ))
                cortes_relevados += 1
            corridas.append((
                fecha.strftime("%Y-%m-%d"), carn, cortes_relevados,
                round(random.uniform(2, 8), 1), None,
                int(cortes_relevados < 3),
            ))

    with sqlite3.connect(DB_PATH) as con:
        con.executemany(
            """
            INSERT OR REPLACE INTO precios
            (fecha, carniceria, segmento, corte_original, corte_normalizado,
             precio_kg, moneda, url_fuente, peso_g, con_hueso, marca, disponible)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            rows,
        )
        con.executemany(
            """
            INSERT OR REPLACE INTO corridas
            (fecha, carniceria, cortes_relevados, duracion_s, error, sospechoso)
            VALUES (?,?,?,?,?,?)
            """,
            corridas,
        )

    print(f"✅ Sembrados {len(rows)} precios sintéticos en {len(fechas)} fechas")
    print(f"   ({len(CARNICERIAS)} carnicerías × {len(PRECIOS_BASE)} cortes × {len(fechas)} fechas)")
    print(f"   Rango: {fechas[0]:%d/%m/%Y} → {fechas[-1]:%d/%m/%Y}")
    print()
    print("Ahora podés:")
    print("  streamlit run dashboard.py     # explorar el dashboard")
    print("  python reporte.py              # generar md/xlsx/pdf desde la BD")
    print()
    print("Cuando los scrapers reales funcionen:")
    print("  python seed_demo.py --limpiar  # borrar data demo")
    print("  python run.py                  # relevamiento real")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dias", type=int, default=30)
    parser.add_argument("--limpiar", action="store_true",
                        help="Borrar BD antes de sembrar")
    args = parser.parse_args()
    generar(args.dias, args.limpiar)
