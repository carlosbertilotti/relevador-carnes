"""
Diagnóstico: descarga el ZIP de SEPA, abre el primer sub-ZIP y muestra
qué archivos y columnas tiene. Sirve para alinear el scraper con la
estructura real actual.

Uso:
    python inspect_sepa.py
"""
import io
import zipfile
import httpx
import re

URL_DATASET = "https://datos.produccion.gob.ar/dataset/sepa-precios"


def main():
    print("Descargando página del dataset...")
    html = httpx.get(URL_DATASET, follow_redirects=True, timeout=60).text
    m = re.search(r'href=["\']([^"\']+\.zip)["\']', html, re.I)
    if not m:
        print("ERROR: no se encontró link al ZIP")
        return
    url = m.group(1)
    if url.startswith("/"):
        url = "https://datos.produccion.gob.ar" + url
    print(f"ZIP: {url}\n")

    print("Descargando ZIP madre (~340 MB, tarda 1-2 min)...")
    contenido = httpx.get(url, follow_redirects=True, timeout=180).content
    print(f"Descargado: {len(contenido)/1e6:.1f} MB\n")

    zf = zipfile.ZipFile(io.BytesIO(contenido))
    sub_zips = [n for n in zf.namelist() if n.endswith(".zip")]
    print(f"Sub-ZIPs encontrados: {len(sub_zips)}")
    print(f"Ejemplos: {sub_zips[:3]}\n")

    # Inspeccionar el primer sub-zip
    sub_name = sub_zips[0]
    print(f"=== Inspeccionando: {sub_name} ===\n")
    sub_data = zf.read(sub_name)
    sub_zf = zipfile.ZipFile(io.BytesIO(sub_data))
    print(f"Archivos adentro: {sub_zf.namelist()}\n")

    for name in sub_zf.namelist():
        if not name.endswith((".csv", ".txt")):
            continue
        print(f"--- {name} ---")
        with sub_zf.open(name) as fp:
            txt = fp.read(2000).decode("utf-8", errors="replace")
            print(txt)
            print("...\n" if len(txt) >= 2000 else "")


if __name__ == "__main__":
    main()
