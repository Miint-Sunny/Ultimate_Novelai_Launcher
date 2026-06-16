from __future__ import annotations

import sqlite3
import uuid
from contextlib import closing
from typing import Any

from .config import Settings
from .db import connect, utc_now
from .library_assets import format_ms, now_ms, save_base64_asset, string_or_none
from .library_tables import delete_by_key, fetch_all, find_one


def list_artists(settings: Settings) -> list[dict[str, Any]]:
    rows = fetch_all(settings, "SELECT * FROM artists ORDER BY created_time DESC")
    return [_artist_to_api(row) for row in rows]


def create_artist(settings: Settings, data: dict[str, Any]) -> dict[str, Any]:
    artist_id = uuid.uuid4().hex
    created_time = now_ms()
    artist_string = str(data.get("artist_string") or "").strip()
    if not artist_string:
        raise ValueError("artist_string is required")
    name = string_or_none(data.get("name")) or artist_string[:48] or f"artist-{artist_id[:8]}"
    preview_path = save_base64_asset(settings, "artists", artist_id, data.get("preview_base64"))
    row = {
        "id": artist_id,
        "name": name,
        "artist_string": artist_string,
        "negative": string_or_none(data.get("negative")),
        "preview_path": str(preview_path) if preview_path else None,
        "usage_count": 0,
        "added_by": string_or_none(data.get("added_by")) or "local",
        "created_time": created_time,
        "updated_at": utc_now(),
    }
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            INSERT INTO artists (
                id, name, artist_string, negative, preview_path, usage_count,
                added_by, created_time, updated_at
            ) VALUES (
                :id, :name, :artist_string, :negative, :preview_path, :usage_count,
                :added_by, :created_time, :updated_at
            )
            """,
            row,
        )
        conn.commit()
    return _artist_to_api(row)


def update_artist(settings: Settings, key: str, data: dict[str, Any]) -> dict[str, Any] | None:
    row = find_one(settings, "artists", key, "name")
    if not row:
        return None
    preview_path = save_base64_asset(settings, "artists", row["id"], data.get("preview_base64"))
    updates = {
        "artist_string": data.get("artist_string", row["artist_string"]),
        "negative": data.get("negative", row["negative"]),
        "preview_path": str(preview_path) if preview_path else row["preview_path"],
        "added_by": data.get("added_by", row["added_by"]),
        "updated_at": utc_now(),
        "id": row["id"],
    }
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            UPDATE artists SET
                artist_string = :artist_string,
                negative = :negative,
                preview_path = :preview_path,
                added_by = :added_by,
                updated_at = :updated_at
            WHERE id = :id
            """,
            updates,
        )
        conn.commit()
    return get_artist(settings, row["id"])


def delete_artist(settings: Settings, key: str) -> bool:
    return delete_by_key(settings, "artists", key, "name")


def use_artist(settings: Settings, key: str) -> bool:
    row = find_one(settings, "artists", key, "name")
    if not row:
        return False
    with closing(connect(settings.db_path)) as conn:
        conn.execute("UPDATE artists SET usage_count = usage_count + 1 WHERE id = ?", (row["id"],))
        conn.commit()
    return True


def get_artist(settings: Settings, key: str) -> dict[str, Any] | None:
    row = find_one(settings, "artists", key, "name")
    return _artist_to_api(row) if row else None


def _artist_to_api(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "artist_string": row["artist_string"],
        "negative": row["negative"] or "",
        "preview_url": f"/api/artists/preview/{row['id']}" if row["preview_path"] else None,
        "usage_count": int(row["usage_count"] or 0),
        "created_time": row["created_time"],
        "created_time_str": format_ms(row["created_time"]),
        "added_by": row["added_by"],
        "configured": True,
    }
