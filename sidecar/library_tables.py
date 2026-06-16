from __future__ import annotations

import sqlite3
from contextlib import closing

from .config import Settings
from .db import connect
from .library_assets import delete_file_if_safe, ensure_asset_dirs


def init_library(settings: Settings) -> None:
    ensure_asset_dirs(settings)
    with closing(connect(settings.db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ocs (
                id TEXT PRIMARY KEY,
                en_name TEXT NOT NULL UNIQUE,
                zh_name TEXT,
                zh_aliases_json TEXT NOT NULL,
                tag_group TEXT NOT NULL,
                negative_prompt TEXT,
                preview_path TEXT,
                created_by TEXT,
                created_at INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS artists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                artist_string TEXT NOT NULL,
                negative TEXT,
                preview_path TEXT,
                usage_count INTEGER NOT NULL DEFAULT 0,
                added_by TEXT,
                created_time INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS crs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                zh_names_json TEXT NOT NULL,
                preview_path TEXT,
                created_time INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vibes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                filename TEXT NOT NULL UNIQUE,
                file_path TEXT NOT NULL,
                thumbnail_path TEXT,
                supported_models_json TEXT NOT NULL,
                default_strength REAL,
                default_info_extracted REAL,
                created_at INTEGER NOT NULL,
                uploader_id TEXT,
                uploaded_at INTEGER,
                has_image INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def fetch_all(settings: Settings, query: str) -> list[sqlite3.Row]:
    with closing(connect(settings.db_path)) as conn:
        return conn.execute(query).fetchall()


def find_one(settings: Settings, table: str, key: str, alt_column: str) -> sqlite3.Row | None:
    with closing(connect(settings.db_path)) as conn:
        return conn.execute(
            f"SELECT * FROM {table} WHERE id = ? OR {alt_column} = ?",
            (key, key),
        ).fetchone()


def delete_by_key(settings: Settings, table: str, key: str, alt_column: str) -> bool:
    row = find_one(settings, table, key, alt_column)
    if not row:
        return False
    preview = row["preview_path"] if "preview_path" in row.keys() else None
    if preview:
        asset_kind = {"ocs": "oc", "artists": "artists", "crs": "cr"}[table]
        delete_file_if_safe(settings, asset_kind, preview)
    with closing(connect(settings.db_path)) as conn:
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (row["id"],))
        conn.commit()
    return True
