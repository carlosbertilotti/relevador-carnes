"""
Sube data/latest.json a Supabase (tabla carnes_precios_snapshot, fila id='latest')
para que el panel de Carlos lo lea en vivo.

Requiere env:
    SUPABASE_URL          p.ej. https://qickqhaxbbnbcyhpyljm.supabase.co
    SUPABASE_SERVICE_KEY  service role key (solo server-side / CI)
"""
import json
import os
from pathlib import Path

import httpx

LATEST = Path(__file__).parent / "data" / "latest.json"


def main():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("⚠️  SUPABASE_URL / SUPABASE_SERVICE_KEY no configuradas — salto subida.")
        return
    if not LATEST.exists():
        print(f"⚠️  No existe {LATEST} — nada para subir.")
        return

    payload = json.loads(LATEST.read_text())
    corrida = payload.get("ultima_corrida")
    # Fila 'latest' (la que lee el panel en vivo) + fila por fecha (histórico para gráficos)
    rows = [{"id": "latest", "payload": payload, "updated_at": "now()"}]
    if corrida:
        rows.append({"id": corrida, "payload": payload, "updated_at": "now()"})
    resp = httpx.post(
        f"{url}/rest/v1/carnes_precios_snapshot?on_conflict=id",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=rows,
        timeout=30,
    )
    if resp.status_code in (200, 201, 204):
        print(f"✅ Snapshot subido a Supabase (corrida {corrida}, {len(rows)} filas)")
    else:
        print(f"❌ Supabase respondió {resp.status_code}: {resp.text[:200]}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
