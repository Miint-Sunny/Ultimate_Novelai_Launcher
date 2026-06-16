from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import Settings
from .storage import ensure_storage


@dataclass(frozen=True)
class GenerationRecord:
    id: str
    input: str
    mode: str
    tags: str
    negative: str
    params: dict[str, Any]
    image_path: str | None
    status: str
    error: str | None
    created_at: str

    @property
    def image_url(self) -> str | None:
        return f"/images/{self.id}" if self.image_path and self.status == "success" else None

    def to_api(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "image_id": self.id,
            "image_url": self.image_url,
            "image_path": self.image_path,
            "input": self.input,
            "mode": self.mode,
            "tags": self.tags,
            "negative": self.negative,
            "params": self.params,
            "status": self.status,
            "error": self.error,
            "created_at": self.created_at,
        }


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(settings: Settings) -> None:
    ensure_storage(settings)
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS generations (
                id TEXT PRIMARY KEY,
                input TEXT NOT NULL,
                mode TEXT NOT NULL,
                tags TEXT NOT NULL,
                negative TEXT NOT NULL,
                params_json TEXT NOT NULL,
                image_path TEXT,
                status TEXT NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tag_translations (
                tag TEXT PRIMARY KEY,
                zh TEXT NOT NULL,
                source TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def create_generation(
    settings: Settings,
    *,
    generation_id: str,
    user_input: str,
    mode: str,
    tags: str,
    negative: str,
    params: dict[str, Any],
) -> GenerationRecord:
    created_at = utc_now()
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            INSERT INTO generations (
                id, input, mode, tags, negative, params_json, image_path, status, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?)
            """,
            (
                generation_id,
                user_input,
                mode,
                tags,
                negative,
                json.dumps(params, ensure_ascii=False),
                created_at,
            ),
        )
        conn.commit()
    return GenerationRecord(
        id=generation_id,
        input=user_input,
        mode=mode,
        tags=tags,
        negative=negative,
        params=params,
        image_path=None,
        status="pending",
        error=None,
        created_at=created_at,
    )


def mark_success(settings: Settings, generation_id: str, path: Path) -> GenerationRecord:
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            "UPDATE generations SET image_path = ?, status = 'success', error = NULL WHERE id = ?",
            (str(path), generation_id),
        )
        conn.commit()
    record = get_generation(settings, generation_id)
    if record is None:
        raise KeyError(generation_id)
    return record


def mark_error(settings: Settings, generation_id: str, error: str) -> GenerationRecord:
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            "UPDATE generations SET status = 'error', error = ? WHERE id = ?",
            (error, generation_id),
        )
        conn.commit()
    record = get_generation(settings, generation_id)
    if record is None:
        raise KeyError(generation_id)
    return record


def get_generation(settings: Settings, generation_id: str) -> GenerationRecord | None:
    with closing(connect(settings.db_path)) as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ?",
            (generation_id,),
        ).fetchone()
    return _row_to_record(row) if row else None


def list_history(settings: Settings, limit: int = 100) -> list[GenerationRecord]:
    with closing(connect(settings.db_path)) as conn:
        rows = conn.execute(
            """
            SELECT * FROM generations
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [_row_to_record(row) for row in rows]


def lookup_tag_translations(settings: Settings, tags: list[str]) -> dict[str, str]:
    keys = [_normalize_tag(tag) for tag in tags if _normalize_tag(tag)]
    if not keys:
        return {}
    placeholders = ",".join("?" for _ in keys)
    with closing(connect(settings.db_path)) as conn:
        rows = conn.execute(
            f"SELECT tag, zh FROM tag_translations WHERE tag IN ({placeholders})",
            keys,
        ).fetchall()
    return {row["tag"]: row["zh"] for row in rows}


def upsert_tag_translations(settings: Settings, entries: list[dict[str, str]]) -> int:
    rows: list[tuple[str, str, str, str]] = []
    now = utc_now()
    for entry in entries:
        tag = _normalize_tag(entry.get("tag", ""))
        zh = str(entry.get("zh", "")).strip()
        source = str(entry.get("source", "ai") or "ai").strip()
        if tag and zh:
            rows.append((tag, zh, source, now))
    if not rows:
        return 0
    with closing(connect(settings.db_path)) as conn:
        conn.executemany(
            """
            INSERT INTO tag_translations (tag, zh, source, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(tag) DO UPDATE SET
                zh = excluded.zh,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            rows,
        )
        conn.commit()
    return len(rows)


def _row_to_record(row: sqlite3.Row) -> GenerationRecord:
    return GenerationRecord(
        id=row["id"],
        input=row["input"],
        mode=row["mode"],
        tags=row["tags"],
        negative=row["negative"],
        params=json.loads(row["params_json"]),
        image_path=row["image_path"],
        status=row["status"],
        error=row["error"],
        created_at=row["created_at"],
    )


def _normalize_tag(tag: str) -> str:
    return str(tag).strip().lower().replace(" ", "_")
