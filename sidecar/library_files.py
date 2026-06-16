from __future__ import annotations

from pathlib import Path

from .config import Settings
from .library_assets import safe_existing_path
from .library_tables import find_one
from .library_vibes import find_vibe


def asset_file(settings: Settings, kind: str, key: str) -> Path | None:
    if kind == "vibes":
        row = find_vibe(settings, key)
        candidate = row["thumbnail_path"] if row else None
    else:
        table = {"oc": "ocs", "artists": "artists", "cr": "crs"}[kind]
        alt = {"oc": "en_name", "artists": "name", "cr": "name"}[kind]
        row = find_one(settings, table, key, alt)
        candidate = row["preview_path"] if row else None
    if not candidate:
        return None
    return safe_existing_path(settings, kind, candidate)
