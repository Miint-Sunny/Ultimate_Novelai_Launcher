from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from typing import Any

from .config import Settings
from .db import connect, utc_now
from .library_assets import now_ms, save_base64_asset
from .library_tables import delete_by_key, fetch_all, find_one


def list_crs(settings: Settings) -> list[dict[str, Any]]:
    rows = fetch_all(settings, "SELECT * FROM crs ORDER BY created_time DESC")
    return [_cr_to_api(row) for row in rows]


def create_cr(settings: Settings, data: dict[str, Any]) -> dict[str, Any]:
    cr_id = uuid.uuid4().hex
    created_time = now_ms()
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")
    preview_path = save_base64_asset(settings, "cr", cr_id, data.get("image_base64"))
    row = {
        "id": cr_id,
        "name": name,
        "zh_names_json": json.dumps(data.get("zh_names") or [], ensure_ascii=False),
        "preview_path": str(preview_path) if preview_path else None,
        "created_time": created_time,
        "updated_at": utc_now(),
    }
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            INSERT INTO crs (id, name, zh_names_json, preview_path, created_time, updated_at)
            VALUES (:id, :name, :zh_names_json, :preview_path, :created_time, :updated_at)
            """,
            row,
        )
        conn.commit()
    return _cr_to_api(row)


def update_cr(settings: Settings, cr_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    row = find_one(settings, "crs", cr_id, "name")
    if not row:
        return None
    updates = {
        "name": data.get("name", row["name"]),
        "zh_names_json": json.dumps(data.get("zh_names", json.loads(row["zh_names_json"])), ensure_ascii=False),
        "updated_at": utc_now(),
        "id": row["id"],
    }
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            "UPDATE crs SET name = :name, zh_names_json = :zh_names_json, updated_at = :updated_at WHERE id = :id",
            updates,
        )
        conn.commit()
    return get_cr(settings, row["id"])


def delete_cr(settings: Settings, cr_id: str) -> bool:
    return delete_by_key(settings, "crs", cr_id, "name")


def get_cr(settings: Settings, cr_id: str) -> dict[str, Any] | None:
    row = find_one(settings, "crs", cr_id, "name")
    return _cr_to_api(row) if row else None


def _cr_to_api(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "preview_url": f"/api/cr/preview/{row['id']}" if row["preview_path"] else None,
        "created_time": row["created_time"],
        "zh_names": json.loads(row["zh_names_json"] or "[]"),
        "configured": True,
    }
