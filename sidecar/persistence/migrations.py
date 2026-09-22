from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import stat
import time
from collections.abc import Iterable, Sequence
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite


class MigrationError(RuntimeError):
    """Base class for migration failures that must stop sidecar startup."""


class FutureSchemaError(MigrationError):
    pass


class MigrationChecksumError(MigrationError):
    pass


class DatabaseIntegrityError(MigrationError):
    pass


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]

    @property
    def checksum(self) -> str:
        payload = "\n-- statement --\n".join(statement.strip() for statement in self.statements)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


BASELINE_VERSION = 1

DEFAULT_MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        version=BASELINE_VERSION,
        name="baseline_legacy_sidecar",
        statements=(
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
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_generations_created_at
            ON generations(created_at DESC)
            """,
            """
            CREATE TABLE IF NOT EXISTS tag_translations (
                tag TEXT PRIMARY KEY,
                zh TEXT NOT NULL,
                source TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """,
        ),
    ),
    Migration(
        version=2,
        name="persistent_jobs_and_assets",
        statements=(
            """
            CREATE TABLE generation_jobs (
                queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                owner TEXT,
                idempotency_key TEXT,
                request_hash TEXT NOT NULL,
                request_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN (
                        'queued', 'running', 'cancelling', 'succeeded',
                        'failed', 'cancelled', 'interrupted'
                    )
                ),
                progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
                result_json TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            )
            """,
            """
            CREATE UNIQUE INDEX uq_generation_jobs_idempotency
            ON generation_jobs(COALESCE(owner, ''), idempotency_key)
            WHERE idempotency_key IS NOT NULL
            """,
            """
            CREATE INDEX idx_generation_jobs_fifo
            ON generation_jobs(status, queue_sequence)
            """,
            """
            CREATE TABLE job_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE INDEX idx_job_events_job_sequence
            ON job_events(job_id, sequence)
            """,
            """
            CREATE TABLE assets (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE,
                media_type TEXT,
                byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
                sha256 TEXT NOT NULL,
                source_job_id TEXT,
                status TEXT NOT NULL CHECK (status IN ('available', 'missing', 'orphaned')),
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_job_id) REFERENCES generation_jobs(id) ON DELETE SET NULL
            )
            """,
            """
            CREATE INDEX idx_assets_created_at ON assets(created_at DESC)
            """,
            """
            CREATE INDEX idx_assets_source_job ON assets(source_job_id)
            """,
        ),
    ),
    Migration(
        version=3,
        name="unify_legacy_generation_history",
        statements=(
            """
            INSERT OR IGNORE INTO generation_jobs(
                id, owner, idempotency_key, request_hash, request_json, status,
                progress, result_json, error_code, error_message, created_at,
                updated_at, started_at, finished_at
            )
            SELECT
                id,
                NULL,
                NULL,
                'legacy:' || id,
                json_object(
                    'input', input,
                    'mode', CASE WHEN mode IN ('natural', 'tags') THEN mode ELSE 'tags' END,
                    'tags', tags,
                    'negative', negative,
                    'params', json(
                        CASE WHEN json_valid(params_json) THEN params_json ELSE '{}' END
                    ),
                    'legacy_payload', NULL
                ),
                CASE status
                    WHEN 'success' THEN 'succeeded'
                    WHEN 'pending' THEN 'interrupted'
                    ELSE 'failed'
                END,
                CASE WHEN status = 'success' THEN 1 ELSE 0 END,
                CASE WHEN status = 'success' THEN json_object(
                    'image_id', id,
                    'image_url', '/images/' || id,
                    'image_path', image_path,
                    'input', input,
                    'mode', mode,
                    'tags', tags,
                    'negative', negative,
                    'params', json(
                        CASE WHEN json_valid(params_json) THEN params_json ELSE '{}' END
                    ),
                    'created_at', created_at,
                    'legacy', json('true')
                ) ELSE NULL END,
                CASE
                    WHEN status = 'pending' THEN 'worker_restarted'
                    WHEN status = 'success' THEN NULL
                    ELSE 'legacy_generation_failed'
                END,
                CASE
                    WHEN status = 'pending' THEN 'legacy generation was interrupted by upgrade'
                    WHEN status = 'success' THEN NULL
                    ELSE COALESCE(error, 'legacy generation failed')
                END,
                created_at,
                created_at,
                created_at,
                created_at
            FROM generations
            """,
            """
            INSERT INTO job_events(job_id, kind, status, data_json, created_at)
            SELECT
                jobs.id,
                jobs.status,
                jobs.status,
                '{"migrated_from":"generations"}',
                jobs.created_at
            FROM generation_jobs AS jobs
            JOIN generations AS legacy ON legacy.id = jobs.id
            WHERE NOT EXISTS (
                SELECT 1 FROM job_events AS events WHERE events.job_id = jobs.id
            )
            """,
        ),
    ),
    Migration(
        version=4,
        name="canonical_local_library",
        statements=(
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
            """,
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
            """,
            """
            CREATE TABLE IF NOT EXISTS crs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                zh_names_json TEXT NOT NULL,
                preview_path TEXT,
                created_time INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """,
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
            """,
            """
            CREATE TABLE library_entries (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('oc', 'artist', 'cr', 'vibe')),
                lookup_key TEXT NOT NULL,
                data_json TEXT NOT NULL,
                primary_asset_id TEXT,
                thumbnail_asset_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(owner, kind, lookup_key),
                FOREIGN KEY(primary_asset_id) REFERENCES assets(id) ON DELETE SET NULL,
                FOREIGN KEY(thumbnail_asset_id) REFERENCES assets(id) ON DELETE SET NULL
            )
            """,
            """
            CREATE INDEX idx_library_entries_owner_kind_created
            ON library_entries(owner, kind, created_at DESC, id)
            """,
            """
            INSERT OR IGNORE INTO library_entries(
                id, owner, kind, lookup_key, data_json, primary_asset_id,
                thumbnail_asset_id, created_at, updated_at
            )
            SELECT
                'legacy-oc-' || id,
                'local',
                'oc',
                en_name,
                json_object(
                    'en_name', en_name,
                    'zh_name', zh_name,
                    'zh_aliases', json(
                        CASE WHEN json_valid(zh_aliases_json) THEN zh_aliases_json ELSE '[]' END
                    ),
                    'tag_group', tag_group,
                    'negative_prompt', COALESCE(negative_prompt, ''),
                    'created_by', COALESCE(created_by, 'local'),
                    'created_at', created_at,
                    'legacy_id', id,
                    'legacy_primary_path', preview_path
                ),
                NULL,
                NULL,
                updated_at,
                updated_at
            FROM ocs
            """,
            """
            INSERT OR IGNORE INTO library_entries(
                id, owner, kind, lookup_key, data_json, primary_asset_id,
                thumbnail_asset_id, created_at, updated_at
            )
            SELECT
                'legacy-artist-' || id,
                'local',
                'artist',
                name,
                json_object(
                    'name', name,
                    'artist_string', artist_string,
                    'negative', COALESCE(negative, ''),
                    'usage_count', usage_count,
                    'added_by', COALESCE(added_by, 'local'),
                    'created_time', created_time,
                    'legacy_id', id,
                    'legacy_primary_path', preview_path
                ),
                NULL,
                NULL,
                updated_at,
                updated_at
            FROM artists
            """,
            """
            INSERT OR IGNORE INTO library_entries(
                id, owner, kind, lookup_key, data_json, primary_asset_id,
                thumbnail_asset_id, created_at, updated_at
            )
            SELECT
                'legacy-cr-' || id,
                'local',
                'cr',
                name,
                json_object(
                    'name', name,
                    'zh_names', json(
                        CASE WHEN json_valid(zh_names_json) THEN zh_names_json ELSE '[]' END
                    ),
                    'created_time', created_time,
                    'legacy_id', id,
                    'legacy_primary_path', preview_path
                ),
                NULL,
                NULL,
                updated_at,
                updated_at
            FROM crs
            """,
            """
            INSERT OR IGNORE INTO library_entries(
                id, owner, kind, lookup_key, data_json, primary_asset_id,
                thumbnail_asset_id, created_at, updated_at
            )
            SELECT
                'legacy-vibe-' || id,
                'local',
                'vibe',
                filename,
                json_object(
                    'name', name,
                    'filename', filename,
                    'supported_models', json(
                        CASE
                            WHEN json_valid(supported_models_json)
                            THEN supported_models_json
                            ELSE '[]'
                        END
                    ),
                    'default_strength', default_strength,
                    'default_info_extracted', default_info_extracted,
                    'created_at', created_at,
                    'has_image', json(CASE WHEN has_image THEN 'true' ELSE 'false' END),
                    'uploader_id', COALESCE(uploader_id, 'local'),
                    'uploaded_at', uploaded_at,
                    'legacy_id', id,
                    'legacy_primary_path', file_path,
                    'legacy_thumbnail_path', thumbnail_path
                ),
                NULL,
                NULL,
                updated_at,
                updated_at
            FROM vibes
            """,
        ),
    ),
)

_EXPECTED_COLUMNS: dict[str, tuple[tuple[str, str, int, int], ...]] = {
    "schema_migrations": (
        ("version", "INTEGER", 0, 1),
        ("name", "TEXT", 1, 0),
        ("checksum", "TEXT", 1, 0),
        ("applied_at", "TEXT", 1, 0),
    ),
    "generations": (
        ("id", "TEXT", 0, 1),
        ("input", "TEXT", 1, 0),
        ("mode", "TEXT", 1, 0),
        ("tags", "TEXT", 1, 0),
        ("negative", "TEXT", 1, 0),
        ("params_json", "TEXT", 1, 0),
        ("image_path", "TEXT", 0, 0),
        ("status", "TEXT", 1, 0),
        ("error", "TEXT", 0, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "tag_translations": (
        ("tag", "TEXT", 0, 1),
        ("zh", "TEXT", 1, 0),
        ("source", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "generation_jobs": (
        ("queue_sequence", "INTEGER", 0, 1),
        ("id", "TEXT", 1, 0),
        ("owner", "TEXT", 0, 0),
        ("idempotency_key", "TEXT", 0, 0),
        ("request_hash", "TEXT", 1, 0),
        ("request_json", "TEXT", 1, 0),
        ("status", "TEXT", 1, 0),
        ("progress", "REAL", 1, 0),
        ("result_json", "TEXT", 0, 0),
        ("error_code", "TEXT", 0, 0),
        ("error_message", "TEXT", 0, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
        ("started_at", "TEXT", 0, 0),
        ("finished_at", "TEXT", 0, 0),
    ),
    "job_events": (
        ("sequence", "INTEGER", 0, 1),
        ("job_id", "TEXT", 1, 0),
        ("kind", "TEXT", 1, 0),
        ("status", "TEXT", 1, 0),
        ("data_json", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "assets": (
        ("id", "TEXT", 0, 1),
        ("kind", "TEXT", 1, 0),
        ("relative_path", "TEXT", 1, 0),
        ("media_type", "TEXT", 0, 0),
        ("byte_size", "INTEGER", 1, 0),
        ("sha256", "TEXT", 1, 0),
        ("source_job_id", "TEXT", 0, 0),
        ("status", "TEXT", 1, 0),
        ("metadata_json", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "ocs": (
        ("id", "TEXT", 0, 1),
        ("en_name", "TEXT", 1, 0),
        ("zh_name", "TEXT", 0, 0),
        ("zh_aliases_json", "TEXT", 1, 0),
        ("tag_group", "TEXT", 1, 0),
        ("negative_prompt", "TEXT", 0, 0),
        ("preview_path", "TEXT", 0, 0),
        ("created_by", "TEXT", 0, 0),
        ("created_at", "INTEGER", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "artists": (
        ("id", "TEXT", 0, 1),
        ("name", "TEXT", 1, 0),
        ("artist_string", "TEXT", 1, 0),
        ("negative", "TEXT", 0, 0),
        ("preview_path", "TEXT", 0, 0),
        ("usage_count", "INTEGER", 1, 0),
        ("added_by", "TEXT", 0, 0),
        ("created_time", "INTEGER", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "crs": (
        ("id", "TEXT", 0, 1),
        ("name", "TEXT", 1, 0),
        ("zh_names_json", "TEXT", 1, 0),
        ("preview_path", "TEXT", 0, 0),
        ("created_time", "INTEGER", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "vibes": (
        ("id", "TEXT", 0, 1),
        ("name", "TEXT", 1, 0),
        ("filename", "TEXT", 1, 0),
        ("file_path", "TEXT", 1, 0),
        ("thumbnail_path", "TEXT", 0, 0),
        ("supported_models_json", "TEXT", 1, 0),
        ("default_strength", "REAL", 0, 0),
        ("default_info_extracted", "REAL", 0, 0),
        ("created_at", "INTEGER", 1, 0),
        ("uploader_id", "TEXT", 0, 0),
        ("uploaded_at", "INTEGER", 0, 0),
        ("has_image", "INTEGER", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "library_entries": (
        ("id", "TEXT", 0, 1),
        ("owner", "TEXT", 1, 0),
        ("kind", "TEXT", 1, 0),
        ("lookup_key", "TEXT", 1, 0),
        ("data_json", "TEXT", 1, 0),
        ("primary_asset_id", "TEXT", 0, 0),
        ("thumbnail_asset_id", "TEXT", 0, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
}

_EXPECTED_INDEXES: dict[str, tuple[str, int, int, tuple[str | None, ...]]] = {
    "idx_generations_created_at": ("generations", 0, 0, ("created_at",)),
    "uq_generation_jobs_idempotency": (
        "generation_jobs",
        1,
        1,
        (None, "idempotency_key"),
    ),
    "idx_generation_jobs_fifo": (
        "generation_jobs",
        0,
        0,
        ("status", "queue_sequence"),
    ),
    "idx_job_events_job_sequence": (
        "job_events",
        0,
        0,
        ("job_id", "sequence"),
    ),
    "idx_assets_created_at": ("assets", 0, 0, ("created_at",)),
    "idx_assets_source_job": ("assets", 0, 0, ("source_job_id",)),
    "idx_library_entries_owner_kind_created": (
        "library_entries",
        0,
        0,
        ("owner", "kind", "created_at", "id"),
    ),
}

_EXPECTED_FOREIGN_KEYS: dict[str, set[tuple[str, str, str, str, str]]] = {
    "job_events": {("job_id", "generation_jobs", "id", "NO ACTION", "CASCADE")},
    "assets": {("source_job_id", "generation_jobs", "id", "NO ACTION", "SET NULL")},
    "library_entries": {
        ("thumbnail_asset_id", "assets", "id", "NO ACTION", "SET NULL"),
        ("primary_asset_id", "assets", "id", "NO ACTION", "SET NULL"),
    },
}


class MigrationRunner:
    """Apply immutable, checksummed migrations under one immediate transaction."""

    def __init__(
        self,
        db_path: Path,
        *,
        migrations: Sequence[Migration] = DEFAULT_MIGRATIONS,
        backup_dir: Path | None = None,
        backup_keep: int = 3,
        busy_timeout_ms: int = 10_000,
    ) -> None:
        self.db_path = Path(db_path)
        self.migrations = tuple(sorted(migrations, key=lambda item: item.version))
        self.backup_dir = backup_dir or self.db_path.parent / "migration-backups"
        self.backup_keep = max(0, backup_keep)
        self.busy_timeout_ms = busy_timeout_ms
        self._validate_definitions()

    @property
    def latest_version(self) -> int:
        return self.migrations[-1].version if self.migrations else 0

    async def migrate(self) -> list[int]:
        existed, identity = await asyncio.to_thread(prepare_database_file, self.db_path)
        connection = await aiosqlite.connect(database_uri(self.db_path, mode="rw"), uri=True)
        try:
            await asyncio.to_thread(assert_database_identity, self.db_path, identity)
            await configure_live_connection(
                connection,
                busy_timeout_ms=self.busy_timeout_ms,
                enable_wal=True,
            )
            await self._quick_check(connection)
            applied = await self._read_applied(connection)
            user_version = await self._read_user_version(connection)
            self._validate_applied(applied, user_version)
            pending = [item for item in self.migrations if item.version not in applied]
            if not pending:
                if self.migrations == DEFAULT_MIGRATIONS:
                    await asyncio.to_thread(
                        validate_default_schema,
                        self.db_path,
                        self.latest_version,
                    )
                return []

            await connection.execute("BEGIN IMMEDIATE")
            try:
                # Another process may have migrated while BEGIN IMMEDIATE waited.
                applied = await self._read_applied(connection)
                user_version = await self._read_user_version(connection)
                self._validate_applied(applied, user_version)
                pending = [item for item in self.migrations if item.version not in applied]
                if not pending:
                    await connection.commit()
                    return []
                # The immediate transaction prevents a writer from changing the
                # source between this snapshot and the first schema statement.
                if existed:
                    await self._create_backup(
                        applied_version=max(max(applied, default=0), user_version)
                    )
                await self._ensure_migration_table(connection)
                for migration in pending:
                    for statement in migration.statements:
                        await connection.execute(statement)
                    await connection.execute(
                        """
                        INSERT INTO schema_migrations(version, name, checksum, applied_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (
                            migration.version,
                            migration.name,
                            migration.checksum,
                            _utc_now(),
                        ),
                    )
                await connection.execute(f"PRAGMA user_version = {self.latest_version}")
                # Validate the uncommitted schema on aiosqlite's worker thread.
                # A post-commit validation cannot roll back an incompatible legacy
                # table that was left in place by CREATE TABLE IF NOT EXISTS.
                await self._quick_check(connection)
                if self.migrations == DEFAULT_MIGRATIONS:
                    await _validate_default_schema_live(
                        connection,
                        self.latest_version,
                    )
                await connection.commit()
            except BaseException:
                await connection.rollback()
                raise

            return [item.version for item in pending]
        finally:
            await connection.close()

    async def current_version(self) -> int:
        identity = await asyncio.to_thread(existing_database_identity, self.db_path)
        if identity is None:
            return 0
        connection = await aiosqlite.connect(database_uri(self.db_path, mode="rw"), uri=True)
        try:
            await asyncio.to_thread(assert_database_identity, self.db_path, identity)
            await configure_live_connection(
                connection,
                busy_timeout_ms=self.busy_timeout_ms,
                enable_wal=False,
            )
            applied = await self._read_applied(connection)
            user_version = await self._read_user_version(connection)
            self._validate_applied(applied, user_version)
            return max(max(applied, default=0), user_version)
        finally:
            await connection.close()

    async def _read_applied(self, connection: aiosqlite.Connection) -> dict[int, tuple[str, str]]:
        row = await _fetchone(
            connection,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        if row is None:
            return {}
        cursor = await connection.execute(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return {int(row[0]): (str(row[1]), str(row[2])) for row in rows}

    async def _read_user_version(self, connection: aiosqlite.Connection) -> int:
        row = await _fetchone(connection, "PRAGMA user_version")
        return int(str(row[0])) if row else 0

    async def _ensure_migration_table(self, connection: aiosqlite.Connection) -> None:
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
            """
        )

    async def _quick_check(self, connection: aiosqlite.Connection) -> None:
        try:
            cursor = await connection.execute("PRAGMA quick_check")
            rows = await cursor.fetchall()
            await cursor.close()
        except aiosqlite.DatabaseError as exc:
            raise DatabaseIntegrityError("SQLite quick_check could not read the database") from exc
        results = [str(row[0]) for row in rows]
        if results != ["ok"]:
            raise DatabaseIntegrityError("SQLite quick_check failed: " + "; ".join(results))

    def _validate_applied(self, applied: dict[int, tuple[str, str]], user_version: int) -> None:
        highest = max(max(applied, default=0), user_version)
        if highest > self.latest_version:
            raise FutureSchemaError(
                f"database schema {highest} is newer than supported schema {self.latest_version}"
            )
        definitions = {item.version: item for item in self.migrations}
        if applied:
            highest_applied = max(applied)
            expected = set(range(1, highest_applied + 1))
            if set(applied) != expected:
                raise MigrationChecksumError("applied migration history contains a gap")
        for version, (name, checksum) in applied.items():
            migration = definitions.get(version)
            if migration is None:
                raise MigrationChecksumError(f"unknown applied migration {version}")
            if name != migration.name or checksum != migration.checksum:
                raise MigrationChecksumError(f"checksum mismatch for migration {version}")

    def _validate_definitions(self) -> None:
        versions = [item.version for item in self.migrations]
        if versions != list(range(1, len(versions) + 1)):
            raise ValueError("migration versions must be contiguous and start at 1")
        if any(not item.statements for item in self.migrations):
            raise ValueError("migrations must contain at least one statement")

    async def _create_backup(self, *, applied_version: int) -> Path:
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        destination = self.backup_dir / (
            f"{self.db_path.stem}.pre-migration-v{applied_version}-to-v{self.latest_version}"
            f"-{timestamp}-{time.time_ns()}.sqlite3"
        )
        await asyncio.to_thread(_sqlite_backup, self.db_path, destination)
        await asyncio.to_thread(self._prune_backups)
        return destination

    def _prune_backups(self) -> None:
        candidates = sorted(
            self.backup_dir.glob(f"{self.db_path.stem}.pre-migration-*.sqlite3"),
            key=lambda path: (path.stat().st_mtime_ns, path.name),
            reverse=True,
        )
        for path in candidates[self.backup_keep :]:
            path.unlink(missing_ok=True)


async def configure_live_connection(
    connection: aiosqlite.Connection,
    *,
    busy_timeout_ms: int,
    enable_wal: bool,
) -> None:
    """Apply and verify the connection invariants used by the live sidecar DB."""

    try:
        await connection.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
        if enable_wal:
            row = await _enable_wal(connection, busy_timeout_ms=busy_timeout_ms)
        else:
            row = await _fetchone(connection, "PRAGMA journal_mode")
        if row is None or str(row[0]).lower() != "wal":
            raise DatabaseIntegrityError("SQLite WAL journal mode could not be enabled")
        await connection.execute("PRAGMA synchronous = FULL")
        await connection.execute("PRAGMA foreign_keys = ON")
        synchronous = await _fetchone(connection, "PRAGMA synchronous")
        foreign_keys = await _fetchone(connection, "PRAGMA foreign_keys")
        busy_timeout = await _fetchone(connection, "PRAGMA busy_timeout")
    except aiosqlite.DatabaseError as exc:
        raise DatabaseIntegrityError("SQLite connection invariants could not be applied") from exc
    if synchronous is None or int(str(synchronous[0])) != 2:
        raise DatabaseIntegrityError("SQLite synchronous mode is not FULL")
    if foreign_keys is None or int(str(foreign_keys[0])) != 1:
        raise DatabaseIntegrityError("SQLite foreign key enforcement is disabled")
    if busy_timeout is None or int(str(busy_timeout[0])) != int(busy_timeout_ms):
        raise DatabaseIntegrityError("SQLite busy timeout was not applied")


"""切进 WAL 时两次重试之间的等待。短到不拖慢启动,长到让对手的事务有机会收尾。"""
_WAL_RETRY_INTERVAL_SECONDS = 0.02


async def _enable_wal(
    connection: aiosqlite.Connection, *, busy_timeout_ms: int
) -> aiosqlite.Row | tuple[object, ...] | None:
    """把 journal mode 切到 WAL,自己吸收「切换期的 SQLITE_BUSY」。

    `PRAGMA busy_timeout` 盖不住这一条。切**进** WAL 要拿独占锁,而这条语句在别的连接
    开着同一个库时**直接返回 SQLITE_BUSY,不走 busy handler**:实测把 busy_timeout 设成
    5000 ms,对手持写锁时它 **0.000 s** 就抛 ``database is locked``。所以退避只能自己做。

    重试是安全的,因为它**幂等**:库一旦已经是 WAL,再执行只是把 ``wal`` 读回来,
    即使此刻别人正持写锁也照样成功(同一次实测验证)。也就是说输掉这一局的连接
    重试时走的是幂等路径,不会第二次去抢独占锁。

    预算直接复用调用方的 ``busy_timeout_ms``——它表达的就是「这个库上愿意为锁等多久」,
    没必要再发明一个常量。等满仍未成功就把原异常抛出去,由调用方转成
    ``DatabaseIntegrityError``:**fail-closed 不变**,起不来好过带着错的 journal mode 起来。

    真实触发场景不只是测试里两个 ``Database`` 打架:sidecar 重启与旧进程收尾重叠、
    单实例守卫失手时,同一个库上就会有两条初始化路径,输掉的那条会起不来。
    """

    deadline = time.monotonic() + max(int(busy_timeout_ms), 0) / 1000
    while True:
        try:
            return await _fetchone(connection, "PRAGMA journal_mode = WAL")
        except aiosqlite.OperationalError as exc:
            message = str(exc).lower()
            # 只吸收「锁竞争」这一类;损坏、只读、磁盘满之类要原样上抛。
            if "locked" not in message and "busy" not in message:
                raise
            if time.monotonic() >= deadline:
                raise
            await asyncio.sleep(_WAL_RETRY_INTERVAL_SECONDS)


async def _fetchone(
    connection: aiosqlite.Connection, sql: str, parameters: Iterable[object] = ()
) -> aiosqlite.Row | tuple[object, ...] | None:
    cursor = await connection.execute(sql, tuple(parameters))
    row = await cursor.fetchone()
    await cursor.close()
    return row


def _sqlite_backup(source: Path, destination: Path) -> None:
    source_identity = require_regular_database(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination_identity = create_regular_file(destination)
    except FileExistsError as exc:
        raise DatabaseIntegrityError("migration backup destination already exists") from exc
    with (
        closing(sqlite3.connect(database_uri(source, mode="ro"), uri=True)) as source_db,
        closing(sqlite3.connect(database_uri(destination, mode="rw"), uri=True)) as target_db,
    ):
        assert_database_identity(source, source_identity)
        assert_database_identity(destination, destination_identity)
        source_db.backup(target_db)


def validate_default_schema(path: Path, schema_version: int) -> None:
    """Validate logical schema/data invariants that ``quick_check`` cannot see."""

    try:
        identity = require_regular_database(path)
        connection = sqlite3.connect(database_uri(path, mode="ro"), uri=True)
        try:
            assert_database_identity(path, identity)
            validate_default_schema_connection(connection, schema_version)
        finally:
            connection.close()
    except DatabaseIntegrityError:
        raise
    except sqlite3.Error as exc:
        raise DatabaseIntegrityError("SQLite logical schema validation failed") from exc


async def _validate_default_schema_live(
    connection: aiosqlite.Connection,
    schema_version: int,
) -> None:
    """Run the synchronous logical validator inside aiosqlite's worker thread.

    This deliberately uses aiosqlite's serialized execution hook so validation
    observes the same connection and uncommitted migration transaction.  The
    dependency is locked, and keeping one validator avoids drift between pre- and
    post-commit schema checks.
    """

    raw_connection = connection._conn  # pyright: ignore[reportPrivateUsage]
    await connection._execute(  # pyright: ignore[reportPrivateUsage]
        validate_default_schema_connection,
        raw_connection,
        schema_version,
    )


def database_uri(path: Path, *, mode: str) -> str:
    return f"{path.absolute().as_uri()}?mode={mode}"


def _file_identity(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def require_regular_database(path: Path) -> tuple[int, int]:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as exc:
        raise DatabaseIntegrityError("SQLite database file is missing") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise DatabaseIntegrityError("SQLite database path is not a regular file")
    return _file_identity(metadata)


def existing_database_identity(path: Path) -> tuple[int, int] | None:
    try:
        return require_regular_database(path)
    except DatabaseIntegrityError:
        try:
            os.lstat(path)
        except FileNotFoundError:
            return None
        raise


def create_regular_file(path: Path) -> tuple[int, int]:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    os.close(descriptor)
    return require_regular_database(path)


def prepare_database_file(path: Path) -> tuple[bool, tuple[int, int]]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return False, create_regular_file(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise DatabaseIntegrityError("SQLite database path is not a regular file")
    return metadata.st_size > 0, _file_identity(metadata)


def assert_database_identity(path: Path, expected: tuple[int, int]) -> None:
    actual = require_regular_database(path)
    if actual != expected:
        raise DatabaseIntegrityError("SQLite database path changed while it was being opened")


def validate_default_schema_connection(
    connection: sqlite3.Connection,
    schema_version: int,
) -> None:
    if schema_version < 1 or schema_version > DEFAULT_MIGRATIONS[-1].version:
        raise DatabaseIntegrityError("SQLite schema version is unsupported")
    required_tables = {"schema_migrations", "generations", "tag_translations"}
    if schema_version >= 2:
        required_tables.update({"generation_jobs", "job_events", "assets"})
    if schema_version >= 4:
        required_tables.update({"ocs", "artists", "crs", "vibes", "library_entries"})

    for table in sorted(required_tables):
        rows = connection.execute(f"PRAGMA table_info('{table}')").fetchall()
        actual = tuple((str(row[1]), str(row[2]).upper(), int(row[3]), int(row[5])) for row in rows)
        if actual != _EXPECTED_COLUMNS[table]:
            raise DatabaseIntegrityError(f"SQLite table schema mismatch: {table}")

    required_indexes = {"idx_generations_created_at"}
    if schema_version >= 2:
        required_indexes.update(
            name for name in _EXPECTED_INDEXES if name != "idx_library_entries_owner_kind_created"
        )
    if schema_version >= 4:
        required_indexes.add("idx_library_entries_owner_kind_created")
    for name in sorted(required_indexes):
        table, unique, partial, columns = _EXPECTED_INDEXES[name]
        index_rows = {
            str(row[1]): (int(row[2]), int(row[4]))
            for row in connection.execute(f"PRAGMA index_list('{table}')").fetchall()
        }
        if index_rows.get(name) != (unique, partial):
            raise DatabaseIntegrityError(f"SQLite index schema mismatch: {name}")
        actual_columns = tuple(
            str(row[2]) if row[2] is not None else None
            for row in connection.execute(f"PRAGMA index_info('{name}')").fetchall()
        )
        if actual_columns != columns:
            raise DatabaseIntegrityError(f"SQLite index columns mismatch: {name}")

    if schema_version >= 2:
        foreign_key_tables = {"job_events", "assets"}
        if schema_version >= 4:
            foreign_key_tables.add("library_entries")
        for table in foreign_key_tables:
            expected = _EXPECTED_FOREIGN_KEYS[table]
            actual = {
                (str(row[3]), str(row[2]), str(row[4]), str(row[5]), str(row[6]))
                for row in connection.execute(f"PRAGMA foreign_key_list('{table}')").fetchall()
            }
            if actual != expected:
                raise DatabaseIntegrityError(f"SQLite foreign key mismatch: {table}")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise DatabaseIntegrityError("SQLite foreign key check failed")

        jobs_sql = _normalized_schema_sql(connection, "generation_jobs")
        assets_sql = _normalized_schema_sql(connection, "assets")
        required_job_fragments = (
            "autoincrement",
            "'queued','running','cancelling','succeeded','failed','cancelled','interrupted'",
            "progress>=0andprogress<=1",
        )
        if any(fragment not in jobs_sql for fragment in required_job_fragments):
            raise DatabaseIntegrityError("SQLite generation job constraints are missing")
        if "'available','missing','orphaned'" not in assets_sql or "byte_size>=0" not in assets_sql:
            raise DatabaseIntegrityError("SQLite asset constraints are missing")

        invalid_json = (
            "SELECT 1 FROM generation_jobs "
            "WHERE NOT json_valid(request_json) "
            "OR (result_json IS NOT NULL AND NOT json_valid(result_json)) LIMIT 1"
        )
        if connection.execute(invalid_json).fetchone() is not None:
            raise DatabaseIntegrityError("SQLite generation job JSON is invalid")
        if (
            connection.execute(
                "SELECT 1 FROM job_events WHERE NOT json_valid(data_json) LIMIT 1"
            ).fetchone()
            is not None
        ):
            raise DatabaseIntegrityError("SQLite job event JSON is invalid")
        if (
            connection.execute(
                "SELECT 1 FROM assets WHERE NOT json_valid(metadata_json) LIMIT 1"
            ).fetchone()
            is not None
        ):
            raise DatabaseIntegrityError("SQLite asset metadata JSON is invalid")

    if schema_version >= 4:
        library_sql = _normalized_schema_sql(connection, "library_entries")
        if "'oc','artist','cr','vibe'" not in library_sql:
            raise DatabaseIntegrityError("SQLite library kind constraints are missing")
        if (
            connection.execute(
                "SELECT 1 FROM library_entries WHERE NOT json_valid(data_json) LIMIT 1"
            ).fetchone()
            is not None
        ):
            raise DatabaseIntegrityError("SQLite library JSON is invalid")

    if (
        connection.execute(
            "SELECT 1 FROM generations WHERE NOT json_valid(params_json) LIMIT 1"
        ).fetchone()
        is not None
    ):
        raise DatabaseIntegrityError("SQLite legacy generation JSON is invalid")


def _normalized_schema_sql(connection: sqlite3.Connection, table: str) -> str:
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    if row is None or not isinstance(row[0], str):
        return ""
    return "".join(str(row[0]).lower().split())


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
