"""
Normaliza nombres de cortes de carne tal como aparecen en distintas carnicerías
y supermercados a una nomenclatura estándar.

V2: 27 cortes organizados por sección:
  TRASERO NOBLE:   lomo, entraña, bife ancho, bife angosto, vacío, matambre
  TRASERO RUEDA:   colita_cuadril, peceto, tapa_cuadril (picaña), cuadril,
                   nalga, jamon_cuadrado, pulpa_bocado, bola_lomo, tapa_nalga,
                   bocado_ancho, tortuguita, roast_beef
  ASADO/COSTILLAR: asado, tapa_asado, falda
  CUARTO DELANTERO: aguja, paleta, osobuco, brazuelo, cogote
  PICADAS:         picada_comun, picada_especial
"""
import re
import unicodedata
from typing import Optional


# ─── Cortes estándar v2 ──────────────────────────────────────────────────────
CORTES_ESTANDAR = {
    # TRASERO NOBLE
    "lomo",
    "entrana",
    "bife_ancho",        # ojo de bife
    "bife_angosto",      # bife de chorizo
    "vacio",
    "matambre",
    # TRASERO RUEDA
    "colita_cuadril",
    "peceto",
    "tapa_cuadril",      # picaña
    "cuadril",
    "nalga",
    "jamon_cuadrado",
    "pulpa_bocado",
    "bola_lomo",
    "tapa_nalga",
    "bocado_ancho",
    "tortuguita",
    "roast_beef",
    # ASADO / COSTILLAR
    "asado",
    "tapa_asado",
    "falda",
    # CUARTO DELANTERO
    "aguja",
    "paleta",
    "osobuco",
    "brazuelo",
    "cogote",
    # PICADAS
    "picada_comun",
    "picada_especial",
}


# Sección a la que pertenece cada corte (útil para reportes por sección)
SECCION = {
    "lomo": "trasero_noble", "entrana": "trasero_noble", "bife_ancho": "trasero_noble",
    "bife_angosto": "trasero_noble", "vacio": "trasero_noble", "matambre": "trasero_noble",

    "colita_cuadril": "trasero_rueda", "peceto": "trasero_rueda",
    "tapa_cuadril": "trasero_rueda", "cuadril": "trasero_rueda", "nalga": "trasero_rueda",
    "jamon_cuadrado": "trasero_rueda", "pulpa_bocado": "trasero_rueda",
    "bola_lomo": "trasero_rueda", "tapa_nalga": "trasero_rueda",
    "bocado_ancho": "trasero_rueda", "tortuguita": "trasero_rueda",
    "roast_beef": "trasero_rueda",

    "asado": "asado_costillar", "tapa_asado": "asado_costillar", "falda": "asado_costillar",

    "aguja": "cuarto_delantero", "paleta": "cuarto_delantero", "osobuco": "cuarto_delantero",
    "brazuelo": "cuarto_delantero", "cogote": "cuarto_delantero",

    "picada_comun": "picadas", "picada_especial": "picadas",
}


# ─── Patrones de matching ────────────────────────────────────────────────────
# Orden CRÍTICO: los más específicos van primero. Si "tapa de asado" estuviera
# después de "asado", todos los "tapa de asado" se clasificarían como "asado".
PATRONES: list[tuple[str, str]] = [
    # ─── 2-3 palabras (más específicos primero) ───
    (r"\bcolita\s+de\s+cuadril\b",      "colita_cuadril"),
    (r"\btapa\s+de\s+cuadril\b",        "tapa_cuadril"),
    (r"\bpica[ñn]a\b",                   "tapa_cuadril"),
    (r"\btapa\s+de\s+asado\b",          "tapa_asado"),
    (r"\btapa\s+de\s+nalga\b",          "tapa_nalga"),
    (r"\bjam[óo]n\s+cuadrado\b",        "jamon_cuadrado"),
    (r"\bpulpa\s+(de\s+)?bocado\b",     "pulpa_bocado"),
    (r"\bbola\s+(de\s+)?lomo\b",        "bola_lomo"),
    (r"\bbocado\s+ancho\b",             "bocado_ancho"),
    (r"\broast\s*beef\b",               "roast_beef"),
    (r"\bfalda\s+(deshuesada|chica)\b", "falda"),

    # ─── Picadas ───
    (r"\b(carne\s+)?picada\s+especial\b",          "picada_especial"),
    (r"\b(carne\s+)?picada\s+(magra|premium)\b",   "picada_especial"),
    (r"\b(carne\s+)?picada(\s+comun)?\b",          "picada_comun"),

    # ─── Bifes ───
    (r"\bbife\s+angosto\b",        "bife_angosto"),
    (r"\bbife\s+de\s+chorizo\b",   "bife_angosto"),
    (r"\bbife\s+ancho\b",          "bife_ancho"),
    (r"\bojo\s+de\s+bife\b",       "bife_ancho"),

    # ─── 1 palabra (al final, los más genéricos) ───
    (r"\blomo\b",          "lomo"),
    (r"\bentra[ñn]a\b",    "entrana"),
    (r"\bpeceto\b",        "peceto"),
    (r"\bcuadril\b",       "cuadril"),
    (r"\bnalga\b",         "nalga"),
    (r"\btortuguita\b",    "tortuguita"),
    (r"\bosobuco\b",       "osobuco"),
    (r"\bbrazuelo\b",      "brazuelo"),
    (r"\bpaleta\b",        "paleta"),
    (r"\baguja\b",         "aguja"),
    (r"\bcogote\b",        "cogote"),
    (r"\bvac[ií]o\b",      "vacio"),
    (r"\bmatambre\b",      "matambre"),
    (r"\bfalda\b",         "falda"),
    (r"\basado\b",         "asado"),
]


# Cosas a IGNORAR: productos que el matching podría agarrar pero no nos interesan
IGNORAR = [
    r"\bhamburguesas?\b",
    r"\bmilanesas?\b",
    r"\bempanadas?\b",
    r"\bchorizo\s+(parrillero|colorado|seco|bombon|criollo)\b",
    r"\bmorcilla",
    r"\bri[ñn][óo]n",
    r"\bh[ií]gado",
    r"\bcoraz[óo]n",
    r"\bmollejas?\b",
    r"\bchinchulines?\b",
    r"\btripa",
    r"\blengua",
    r"\bpollo|\bave\b",
    r"\bcerdo|\bbondiola|\bpechito",
    r"\bcordero",
    r"\bpescado|\bsalm[óo]n|\bmerluza|\bat[úu]n",
    r"\bvegana?\b|\bplant[\s-]?based\b",
    r"\bcongelad",   # por ahora ignoramos congelados
]


def _limpiar(nombre: str) -> str:
    """Pasa a minúsculas y normaliza acentos."""
    s = nombre.lower().strip()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"\s+", " ", s)
    return s


def normalizar(nombre_producto: str) -> Optional[str]:
    """Devuelve el corte_normalizado o None si no es uno de los cortes trackeados."""
    s = _limpiar(nombre_producto)

    # Filtros de exclusión
    for ignore_pat in IGNORAR:
        if re.search(ignore_pat, s):
            return None

    # Buscar primera coincidencia (orden importa)
    for patron, corte in PATRONES:
        if re.search(patron, s):
            return corte

    return None


def corte_pretty(corte: str) -> str:
    """Convierte 'bife_angosto' -> 'Bife Angosto' para mostrar en reportes."""
    pretty = {
        "tapa_cuadril": "Tapa de Cuadril (Picaña)",
        "tapa_nalga":   "Tapa de Nalga",
        "tapa_asado":   "Tapa de Asado",
        "bola_lomo":    "Bola de Lomo",
        "pulpa_bocado": "Pulpa de Bocado",
        "bocado_ancho": "Bocado Ancho",
        "jamon_cuadrado": "Jamón Cuadrado",
        "roast_beef":   "Roast Beef",
        "colita_cuadril": "Colita de Cuadril",
        "bife_angosto": "Bife Angosto",
        "bife_ancho":   "Bife Ancho",
        "picada_comun": "Picada Común",
        "picada_especial": "Picada Especial",
        "entrana":      "Entraña",
        "vacio":        "Vacío",
    }
    return pretty.get(corte, corte.replace("_", " ").title())


# ─── Tests rápidos ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    casos = [
        # Trasero noble
        ("Bife de Chorizo Premium x kg", "bife_angosto"),
        ("BIFE ANGOSTO x kg", "bife_angosto"),
        ("Ojo de Bife Black Angus", "bife_ancho"),
        ("Bife Ancho x kg", "bife_ancho"),
        ("Lomo limpio", "lomo"),
        ("Entraña fina", "entrana"),
        ("Vacío entero", "vacio"),
        ("Matambre de novillito", "matambre"),

        # Trasero rueda
        ("Colita de Cuadril", "colita_cuadril"),
        ("Cuadril sin tapa", "cuadril"),
        ("Tapa de Cuadril", "tapa_cuadril"),
        ("Picaña Premium", "tapa_cuadril"),
        ("Peceto", "peceto"),
        ("Nalga sin tapa", "nalga"),
        ("Tapa de Nalga", "tapa_nalga"),
        ("Jamón Cuadrado", "jamon_cuadrado"),
        ("Pulpa de Bocado", "pulpa_bocado"),
        ("Bola de Lomo", "bola_lomo"),
        ("Bocado Ancho", "bocado_ancho"),
        ("Tortuguita Novillito", "tortuguita"),
        ("Roast Beef Premium", "roast_beef"),
        ("RoastBeef", "roast_beef"),

        # Asado / costillar
        ("Asado de tira", "asado"),
        ("Asado Banderita", "asado"),
        ("Tapa de Asado Novillito", "tapa_asado"),
        ("Falda chica", "falda"),
        ("Falda deshuesada", "falda"),
        ("Falda", "falda"),

        # Cuarto delantero
        ("Aguja con hueso", "aguja"),
        ("Paleta de novillo", "paleta"),
        ("Osobuco con caracú", "osobuco"),
        ("Brazuelo", "brazuelo"),
        ("Cogote", "cogote"),

        # Picadas
        ("Carne Picada Común", "picada_comun"),
        ("Carne Picada Especial", "picada_especial"),
        ("Picada Magra", "picada_especial"),

        # Ignorar (otra carne / no carne / preparados)
        ("Hamburguesas Paty x 4u", None),
        ("Milanesas de carne", None),
        ("Pollo entero fresco", None),
        ("Bondiola de cerdo", None),
        ("Paleta de cerdo", None),         # tiene "paleta" pero también "cerdo"
        ("Chorizo parrillero", None),
        ("Salmón rosado", None),
        ("Yogur descremado", None),
    ]
    ok = sum(1 for nom, esp in casos if normalizar(nom) == esp)
    print(f"Tests: {ok}/{len(casos)} ok\n")
    for nom, esp in casos:
        got = normalizar(nom)
        marca = "✓" if got == esp else "✗"
        print(f"  {marca}  {nom!r:42s} -> {got!r:18s} (esperado: {esp!r})")
