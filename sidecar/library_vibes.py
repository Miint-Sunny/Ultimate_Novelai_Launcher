from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any

from .config import Settings
from .db import connect, utc_now
from .library_assets import (
    asset_dir,
    atomic_write_bytes,
    atomic_write_text,
    delete_file_if_safe,
    model_to_encoding_key,
    now_ms,
    safe_existing_path,
    safe_name,
    save_base64_asset,
    to_float,
    to_int,
    unique_filename,
)
from .library_tables import fetch_all


def list_vibes(settings: Settings) -> list[dict[str, Any]]:
    rows = fetch_all(settings, "SELECT * FROM vibes ORDER BY created_at DESC")
    return [_vibe_to_api(row) for row in rows]


def create_vibe(
    settings: Settings,
    vibe_data: dict[str, Any],
    name: str | None,
    uploader_id: str | None = None,
) -> dict[str, Any]:
    vibe_id = uuid.uuid4().hex
    created_at = to_int(vibe_data.get("createdAt")) or now_ms()
    display_name = str(name or vibe_data.get("name") or f"vibe-{vibe_id[:8]}").strip()
    filename = unique_filename(settings, display_name, vibe_id)
    file_path = asset_dir(settings, "vibes") / filename
    thumbnail_path = save_base64_asset(
        settings,
        "vibes",
        f"{vibe_id}_thumb",
        vibe_data.get("thumbnail"),
    )
    try:
        atomic_write_text(
            file_path,
            json.dumps({**vibe_data, "name": display_name}, ensure_ascii=False),
        )
    except Exception:
        if thumbnail_path:
            delete_file_if_safe(settings, "vibes", str(thumbnail_path))
        raise
    encodings = vibe_data.get("encodings")
    supported_models = list(encodings.keys()) if isinstance(encodings, dict) else []
    raw_import_info = vibe_data.get("importInfo")
    import_info: dict[str, Any] = raw_import_info if isinstance(raw_import_info, dict) else {}
    row = {
        "id": vibe_id,
        "name": display_name,
        "filename": filename,
        "file_path": str(file_path),
        "thumbnail_path": str(thumbnail_path) if thumbnail_path else None,
        "supported_models_json": json.dumps(supported_models, ensure_ascii=False),
        "default_strength": to_float(
            import_info.get("strength") or vibe_data.get("defaultStrength")
        ),
        "default_info_extracted": to_float(
            import_info.get("information_extracted") or vibe_data.get("defaultInfoExtracted")
        ),
        "created_at": created_at,
        "uploader_id": uploader_id or "local",
        "uploaded_at": now_ms(),
        "has_image": 1 if vibe_data.get("image") else 0,
        "updated_at": utc_now(),
    }
    try:
        with closing(connect(settings.db_path)) as conn:
            conn.execute(
                """
                INSERT INTO vibes (
                    id, name, filename, file_path, thumbnail_path, supported_models_json,
                    default_strength, default_info_extracted, created_at, uploader_id,
                    uploaded_at, has_image, updated_at
                ) VALUES (
                    :id, :name, :filename, :file_path, :thumbnail_path, :supported_models_json,
                    :default_strength, :default_info_extracted, :created_at, :uploader_id,
                    :uploaded_at, :has_image, :updated_at
                )
                """,
                row,
            )
            conn.commit()
    except Exception:
        delete_file_if_safe(settings, "vibes", str(file_path))
        if thumbnail_path:
            delete_file_if_safe(settings, "vibes", str(thumbnail_path))
        raise
    return _vibe_to_api(row)


def get_vibe_file(settings: Settings, filename: str) -> dict[str, Any] | None:
    row = find_vibe(settings, filename)
    if not row:
        return None
    path = safe_existing_path(settings, "vibes", row["file_path"])
    return json.loads(path.read_text(encoding="utf-8"))


def update_vibe(settings: Settings, filename: str, data: dict[str, Any]) -> dict[str, Any] | None:
    row = find_vibe(settings, filename)
    if not row:
        return None
    vibe_json = get_vibe_file(settings, filename) or {}
    if data.get("name"):
        vibe_json["name"] = data["name"]
    raw_import_info = vibe_json.get("importInfo")
    import_info: dict[str, Any] = raw_import_info if isinstance(raw_import_info, dict) else {}
    if "default_strength" in data and data["default_strength"] is not None:
        import_info["strength"] = data["default_strength"]
    if "default_info_extracted" in data and data["default_info_extracted"] is not None:
        import_info["information_extracted"] = data["default_info_extracted"]
    if import_info:
        vibe_json["importInfo"] = import_info
    file_path = safe_existing_path(settings, "vibes", row["file_path"])
    previous_payload = file_path.read_bytes()
    atomic_write_text(file_path, json.dumps(vibe_json, ensure_ascii=False))
    updates = {
        "name": str(vibe_json.get("name") or row["name"]),
        "default_strength": to_float(import_info.get("strength")),
        "default_info_extracted": to_float(import_info.get("information_extracted")),
        "updated_at": utc_now(),
        "id": row["id"],
    }
    try:
        with closing(connect(settings.db_path)) as conn:
            conn.execute(
                """
                UPDATE vibes SET
                    name = :name,
                    default_strength = :default_strength,
                    default_info_extracted = :default_info_extracted,
                    updated_at = :updated_at
                WHERE id = :id
                """,
                updates,
            )
            conn.commit()
    except Exception:
        atomic_write_bytes(file_path, previous_payload)
        raise
    return get_vibe(settings, filename)


def delete_vibe(settings: Settings, filename: str) -> bool:
    row = find_vibe(settings, filename)
    if not row:
        return False
    with closing(connect(settings.db_path)) as conn:
        conn.execute("DELETE FROM vibes WHERE id = ?", (row["id"],))
        conn.commit()
    delete_file_if_safe(settings, "vibes", row["file_path"])
    if row["thumbnail_path"]:
        delete_file_if_safe(settings, "vibes", row["thumbnail_path"])
    return True


def get_vibe(settings: Settings, filename: str) -> dict[str, Any] | None:
    row = find_vibe(settings, filename)
    return _vibe_to_api(row) if row else None


def get_vibe_encoding(
    settings: Settings,
    filename: str,
    model: str,
    information_extracted: float,
) -> str | None:
    data = get_vibe_file(settings, filename)
    if not data:
        return None
    encodings = data.get("encodings")
    if not isinstance(encodings, dict):
        return None
    for key in (model, model_to_encoding_key(model)):
        value = encodings.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            for ie_key in (
                str(information_extracted),
                f"{information_extracted:.2f}",
                f"{information_extracted:.1f}",
            ):
                encoded = value.get(ie_key)
                if isinstance(encoded, str):
                    return encoded
    return None


def vibe_download_file(settings: Settings, filename: str) -> Path | None:
    row = find_vibe(settings, filename)
    if not row:
        return None
    return safe_existing_path(settings, "vibes", row["file_path"])


def find_vibe(settings: Settings, filename: str) -> sqlite3.Row | None:
    if "/" in filename or "\\" in filename:
        raise ValueError("invalid vibe filename")
    safe = safe_name(filename)
    with closing(connect(settings.db_path)) as conn:
        return conn.execute(
            "SELECT * FROM vibes WHERE filename = ? OR id = ?",
            (safe, safe),
        ).fetchone()


def _vibe_to_api(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "filename": row["filename"],
        "thumbnail": f"/api/vibes/thumbnail/{row['filename']}" if row["thumbnail_path"] else "",
        "supportedModels": json.loads(row["supported_models_json"] or "[]"),
        "defaultStrength": row["default_strength"],
        "defaultInfoExtracted": row["default_info_extracted"],
        "createdAt": row["created_at"],
        "hasImage": bool(row["has_image"]),
        "uploaderId": row["uploader_id"],
        "uploadedAt": row["uploaded_at"],
        "configured": True,
    }
