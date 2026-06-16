from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from typing import Any

from .config import Settings
from .db import connect, utc_now
from .library_assets import now_ms, save_base64_asset, slug, string_or_none
from .library_tables import delete_by_key, fetch_all, find_one


def list_ocs(settings: Settings) -> list[dict[str, Any]]:
    rows = fetch_all(settings, "SELECT * FROM ocs ORDER BY created_at DESC")
    return [_oc_to_api(row) for row in rows]


def create_oc(settings: Settings, data: dict[str, Any]) -> dict[str, Any]:
    created_at = now_ms()
    oc_id = uuid.uuid4().hex
    zh_name = string_or_none(data.get("zh_name"))
    en_name = string_or_none(data.get("en_name")) or slug(zh_name or f"oc-{oc_id[:8]}")
    preview_path = save_base64_asset(settings, "oc", oc_id, data.get("preview_base64"))
    row = {
        "id": oc_id,
        "en_name": en_name,
        "zh_name": zh_name,
        "zh_aliases_json": json.dumps(data.get("zh_aliases") or [], ensure_ascii=False),
        "tag_group": str(data.get("tag_group") or "").strip(),
        "negative_prompt": string_or_none(data.get("negative_prompt")),
        "preview_path": str(preview_path) if preview_path else None,
        "created_by": string_or_none(data.get("created_by")) or "local",
        "created_at": created_at,
        "updated_at": utc_now(),
    }
    if not row["tag_group"]:
        raise ValueError("tag_group is required")
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            INSERT INTO ocs (
                id, en_name, zh_name, zh_aliases_json, tag_group, negative_prompt,
                preview_path, created_by, created_at, updated_at
            ) VALUES (
                :id, :en_name, :zh_name, :zh_aliases_json, :tag_group, :negative_prompt,
                :preview_path, :created_by, :created_at, :updated_at
            )
            """,
            row,
        )
        conn.commit()
    return _oc_to_api(row)


def update_oc(settings: Settings, key: str, data: dict[str, Any]) -> dict[str, Any] | None:
    row = find_one(settings, "ocs", key, "en_name")
    if not row:
        return None
    updates = {
        "zh_name": data.get("zh_name", row["zh_name"]),
        "zh_aliases_json": json.dumps(data.get("zh_aliases", json.loads(row["zh_aliases_json"])), ensure_ascii=False),
        "tag_group": data.get("tag_group", row["tag_group"]),
        "negative_prompt": data.get("negative_prompt", row["negative_prompt"]),
        "created_by": data.get("created_by", row["created_by"]),
        "created_at": int(data.get("created_at", row["created_at"]) or row["created_at"]),
        "updated_at": utc_now(),
        "id": row["id"],
    }
    preview_path = save_base64_asset(settings, "oc", row["id"], data.get("preview_base64"))
    updates["preview_path"] = str(preview_path) if preview_path else row["preview_path"]
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            UPDATE ocs SET
                zh_name = :zh_name,
                zh_aliases_json = :zh_aliases_json,
                tag_group = :tag_group,
                negative_prompt = :negative_prompt,
                preview_path = :preview_path,
                created_by = :created_by,
                created_at = :created_at,
                updated_at = :updated_at
            WHERE id = :id
            """,
            updates,
        )
        conn.commit()
    return get_oc(settings, row["id"])


def delete_oc(settings: Settings, key: str) -> bool:
    return delete_by_key(settings, "ocs", key, "en_name")


def get_oc(settings: Settings, key: str) -> dict[str, Any] | None:
    row = find_one(settings, "ocs", key, "en_name")
    return _oc_to_api(row) if row else None


def _oc_to_api(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "en_name": row["en_name"],
        "zh_name": row["zh_name"],
        "zh_aliases": json.loads(row["zh_aliases_json"] or "[]"),
        "tag_group": row["tag_group"],
        "negative_prompt": row["negative_prompt"] or "",
        "preview_url": f"/api/oc/preview/{row['id']}" if row["preview_path"] else None,
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "configured": True,
    }
