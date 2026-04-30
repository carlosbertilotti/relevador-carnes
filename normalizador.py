"""
Normaliza nombres de cortes de carne tal como aparecen en distintas carnicerías
y supermercados a una nomenclatura estándar.

V1: 13 cortes principales. Para extender, agregar entradas en CORTES_ESTANDAR
y patrones en PATRONES (ordenados de más específico a más genérico).
"""
import re
import unicodedata
from typing import Optional

# ─── Cortes estándar v1 ──────────────────────────────────────────────────────
CORTES_ESTANDAR = {
    "asado",
    "vacio",
    "matambre",
    "bife_angosto",
    "bife_ancho",
    "lomo",
    "tapa_asado",
    "cuadril",
    "colita_cuadril",
    "peceto",
    "osobuco",
    "picada_comun",
    "picada_especial",
}

# ─── Patrones de matching ────────────────────────────────────────────────────
# Orden crítico: los más específicos van primero. Si "tapa de asado" estuviera
# después de "asado", todos los "tapa de asado" se clasificarían como "asado".
PATRONES: list[tuple[str, str]] = [
    # Cortes con dos palabras (van primero)
    (r"\bcolita\s+de\s+cuadril\b", "colita_cuadril"),
    (r"\btapa\s+de\s+asado\b", "tapa_asado"),

    # Picadas
    (r"\b(carne\s+)?picada\s+especial\b", "picada_especial"),
    (r"\b(carne\s+)?picada\s+(magra|premium)\b", "picada_especial"),
    (r"\b(carne\s+)?picada(\s+comun)?\b", "picada_comun"),

    # Bifes
    (r"\bbife\s+angosto\b", "bife_angosto"),
    (r"\bbife\s+de\s+chorizo\b", "bife_angosto"),
    (r"\bbife\s+ancho\b", "bife_ancho"),
    (r"\bojo\s+de\s+bife\b", "bife_ancho"),

    # Una sola palabra (van al final)
    (r"\blomo\b", "lomo"),
    (r"\bpeceto\b", "peceto"),
    (r"\bcuadril\b", "cuadril"),
    (r"\bosobuco\b", "osobuco"),
    (r"\bvac[ií]o\b", "vacio"),
    (r"\bmatambre\b", "matambre"),
    (r"\basado\b", "asado"),
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
    r"\bcongelad",  # por ahora ignoramos congelados
]


def _limpiar(nombre: str) -> str:
    """Pasa a minúsculas y normaliza acentos."""
    s = nombre.lower().strip()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"\s+", " ", s)
    return s


def normalizar(nombre_producto: str) -> Optional[str]:
    """
    Devuelve el corte_normalizado o None si el producto no es uno
    de los cortes que estamos trackeando.

    Ejemplos:
        "Bife de Chorizo Premium x kg"     -> "bife_angosto"
        "Carne picada común"                -> "picada_comun"
        "Tapa de Asado Novillito"           -> "tapa_asado"
        "Hamburguesa Paty x 4u"             -> None  (ignorado)
        "Pollo entero"                      -> None  (ignorado)
    """
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
    return corte.replace("_", " ").title()


# ─── Tests rápidos ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    casos = [
        ("Bife de Chorizo Premium x kg", "bife_angosto"),
        ("BIFE ANGOSTO x kg", "bife_angosto"),
        ("Ojo de Bife Black Angus", "bife_ancho"),
        ("Tapa de Asado Novillito", "tapa_asado"),
        ("Asado de tira", "asado"),
        ("Asado Banderita", "asado"),
        ("Carne Picada Común", "picada_comun"),
        ("Carne Picada Especial", "picada_especial"),
        ("Picada Magra", "picada_especial"),
        ("Colita de Cuadril", "colita_cuadril"),
        ("Cuadril sin tapa", "cuadril"),
        ("Vacío entero", "vacio"),
        ("Matambre de novillito", "matambre"),
        ("Lomo limpio", "lomo"),
        ("Peceto", "peceto"),
        ("Osobuco con caracú", "osobuco"),
        # Ignorar:
        ("Hamburguesas Paty x 4u", None),
        ("Milanesas de carne", None),
        ("Pollo entero fresco", None),
        ("Bondiola de cerdo", None),
        ("Chorizo parrillero", None),
        ("Salmón rosado", None),
        ("Yogur descremado", None),
    ]
    ok = sum(1 for nom, esp in casos if normalizar(nom) == esp)
    print(f"Tests: {ok}/{len(casos)} ok\n")
    for nom, esp in casos:
        got = normalizar(nom)
        marca = "✓" if got == esp else "✗"
        print(f"  {marca}  {nom!r:45s} -> {got!r:20s} (esperado: {esp!r})")
