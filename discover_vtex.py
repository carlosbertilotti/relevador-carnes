"""
Helper para descubrir el ID de la categoría 'Carnes' en cualquier sitio VTEX.

Uso:
    python discover_vtex.py https://www.cotodigital.com.ar
    python discover_vtex.py https://www.carrefour.com.ar
    python discover_vtex.py https://diaonline.supermercadosdia.com.ar

Imprime las categorías cuyo nombre contiene 'carne', 'vacun', 'res', etc.
con su ID, ruta y URL. Usá ese ID en el atributo `categoria_carne_id`
de la subclase correspondiente en scrapers/<sitio>.py.
"""
import sys
import logging

import httpx


USER_AGENT = "Mozilla/5.0 RelevadorPreciosCarnes/1.0 (descubrimiento de IDs)"


def descubrir(base_url: str):
    base_url = base_url.rstrip("/")
    print(f"\nConsultando árbol de categorías de {base_url}...")

    # VTEX expone el árbol con profundidad N en /api/catalog_system/pub/category/tree/N
    for profundidad in (4, 3, 2):
        url = f"{base_url}/api/catalog_system/pub/category/tree/{profundidad}"
        try:
            r = httpx.get(url, timeout=30, headers={"User-Agent": USER_AGENT},
                          follow_redirects=True)
            r.raise_for_status()
            tree = r.json()
            print(f"  ✓ obtenido árbol con profundidad {profundidad} ({len(tree)} categorías raíz)\n")
            break
        except Exception as e:
            print(f"  ✗ profundidad {profundidad}: {e}")
    else:
        print("\nNo se pudo obtener el árbol VTEX. ¿Estás seguro que el sitio usa VTEX?")
        return

    encontradas = []

    def buscar(nodos, ruta=""):
        for n in nodos:
            nombre = n.get("name", "")
            ruta_actual = f"{ruta} > {nombre}" if ruta else nombre
            n_lower = nombre.lower()
            if any(k in n_lower for k in
                   ["carne", "vacun", "novillo", "ternera", "res ", "carniceria"]):
                encontradas.append({
                    "id": n.get("id"),
                    "ruta": ruta_actual,
                    "url": n.get("url", ""),
                    "tiene_hijos": bool(n.get("children")),
                })
            if n.get("children"):
                buscar(n["children"], ruta_actual)

    buscar(tree)

    if not encontradas:
        print("No se encontraron categorías con palabras clave de carne.")
        print("Categorías de primer nivel disponibles:")
        for n in tree:
            print(f"  [{n.get('id'):>6}] {n.get('name')}")
        return

    print("Categorías candidatas (las que NO tienen hijos suelen ser las útiles):\n")
    for c in encontradas:
        marca = "📁" if c["tiene_hijos"] else "📄"
        print(f"  {marca} [{c['id']:>6}]  {c['ruta']}")
        if c["url"]:
            print(f"            → {c['url']}")
    print()
    print("Tomá el ID de la categoría más específica (📄 = sin subcategorías)")
    print("y ponelo en `categoria_carne_id` del scraper correspondiente.\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Uso: python discover_vtex.py <base_url>")
        print("Ej:  python discover_vtex.py https://www.cotodigital.com.ar")
        sys.exit(1)
    logging.basicConfig(level=logging.WARNING)
    descubrir(sys.argv[1])
