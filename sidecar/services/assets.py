from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import shutil
import stat
import uuid
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import aiosqlite

from backend_core.errors import (
    CapacityExceededError,
    ConflictError,
    InvalidArgumentError,
    ResourceNotFoundError,
)
from backend_core.types import JsonValue
from sidecar.persistence import Database

GIB = 1024**3
DEFAULT_ASSET_QUOTA_BYTES = 10 * GIB
DEFAULT_DISK_RESERVE_BYTES = GIB
ASSET_STATUSES = frozenset({"available", "missing", "orphaned"})


class InsufficientStorageError(CapacityExceededError):
    code = "insufficient_storage"
    retryable = False

    def __init__(self, status: StorageStatus) -> None:
        super().__init__(
            "asset storage does not have enough quota or reserved disk space",
            code=self.code,
            details={
                "requested_bytes": status.requested_bytes,
                "catalog_bytes": status.catalog_bytes,
                "quota_bytes": status.quota_bytes,
                "disk_free_bytes": status.disk_free_bytes,
                "reserve_bytes": status.reserve_bytes,
                "quota_remaining_bytes": status.quota_remaining_bytes,
                "disk_usable_bytes": status.disk_usable_bytes,
                "retryable": False,
            },
        )


class AssetNotFoundError(ResourceNotFoundError):
    code = "asset_not_found"

    def __init__(self, asset_id: str) -> None:
        super().__init__("asset was not found", code=self.code, details={"asset_id": asset_id})


class AssetConflictError(ConflictError):
    code = "asset_conflict"


@dataclass(frozen=True)
class AssetRecord:
    id: str
    kind: str
    relative_path: str
    media_type: str | None
    byte_size: int
    sha256: str
    source_job_id: str | None
    status: str
    metadata: Mapping[str, JsonValue]
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "relative_path": self.relative_path,
            "media_type": self.media_type,
            "byte_size": self.byte_size,
            "sha256": self.sha256,
            "source_job_id": self.source_job_id,
            "status": self.status,
            "metadata": dict(self.metadata),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class StorageStatus:
    requested_bytes: int
    catalog_bytes: int
    quota_bytes: int
    disk_free_bytes: int
    reserve_bytes: int

    @property
    def quota_remaining_bytes(self) -> int:
        return max(0, self.quota_bytes - self.catalog_bytes)

    @property
    def disk_usable_bytes(self) -> int:
        return max(0, self.disk_free_bytes - self.reserve_bytes)

    @property
    def can_allocate(self) -> bool:
        return (
            self.requested_bytes <= self.quota_remaining_bytes
            and self.requested_bytes <= self.disk_usable_bytes
        )

    def to_dict(self) -> dict[str, int | bool]:
        return {
            "requested_bytes": self.requested_bytes,
            "catalog_bytes": self.catalog_bytes,
            "quota_bytes": self.quota_bytes,
            "quota_remaining_bytes": self.quota_remaining_bytes,
            "disk_free_bytes": self.disk_free_bytes,
            "reserve_bytes": self.reserve_bytes,
            "disk_usable_bytes": self.disk_usable_bytes,
            "can_allocate": self.can_allocate,
        }


@dataclass(frozen=True)
class ReconciliationReport:
    missing_asset_ids: tuple[str, ...]
    recovered_asset_ids: tuple[str, ...]
    orphan_asset_ids: tuple[str, ...]
    skipped_relative_paths: tuple[str, ...]

    def to_dict(self) -> dict[str, list[str]]:
        return {
            "missing_asset_ids": list(self.missing_asset_ids),
            "recovered_asset_ids": list(self.recovered_asset_ids),
            "orphan_asset_ids": list(self.orphan_asset_ids),
            "skipped_relative_paths": list(self.skipped_relative_paths),
        }


@dataclass(frozen=True)
class _DeleteIntent:
    directory: Path
    manifest_path: Path
    payload_path: Path
    target_path: Path
    asset_id: str
    relative_path: str


class AssetService:
    """Catalog assets without ever evicting user files automatically."""

    def __init__(
        self,
        database: Database,
        root: Path,
        *,
        managed_root: Path | None = None,
        quota_bytes: int = DEFAULT_ASSET_QUOTA_BYTES,
        reserve_bytes: int = DEFAULT_DISK_RESERVE_BYTES,
    ) -> None:
        if quota_bytes < 1 or reserve_bytes < 0:
            raise ValueError("invalid asset storage limits")
        self.database = database
        self.root = Path(root)
        self.managed_root = Path(managed_root) if managed_root is not None else self.root
        self._delete_intent_root = self.root.with_name(f".{self.root.name}-delete-intents")
        self.quota_bytes = quota_bytes
        self.reserve_bytes = reserve_bytes
        self._write_lock = asyncio.Lock()
        self._initialize_lock = asyncio.Lock()
        self._initialized = False
        self._root_identity: tuple[int, int] | None = None
        self._canonical_root: Path | None = None
        self._managed_root_identity: tuple[int, int] | None = None
        self._canonical_managed_root: Path | None = None

    async def initialize(self) -> None:
        async with self._initialize_lock:
            if self._initialized:
                return
            await self.database.initialize()
            self._root_identity = await asyncio.to_thread(_prepare_storage_root, self.root)
            self._canonical_root = await asyncio.to_thread(self.root.resolve, True)
            if self.managed_root == self.root:
                self._managed_root_identity = self._root_identity
                self._canonical_managed_root = self._canonical_root
            else:
                self._managed_root_identity = await asyncio.to_thread(
                    _prepare_storage_root, self.managed_root
                )
                self._canonical_managed_root = await asyncio.to_thread(
                    self.managed_root.resolve, True
                )
                try:
                    self._canonical_root.relative_to(self._canonical_managed_root)
                except ValueError as exc:
                    raise InvalidArgumentError(
                        "asset storage root must be inside the managed data directory"
                    ) from exc
            self._initialized = True

    @asynccontextmanager
    async def snapshot_guard(self) -> AsyncIterator[None]:
        """Keep the catalog and asset tree stable while a backup reads both."""

        await self.initialize()
        async with self._write_lock:
            self._assert_root()
            self._assert_managed_root()
            try:
                yield
            finally:
                self._assert_root()
                self._assert_managed_root()

    async def storage_status(
        self, requested_bytes: int = 0, *, replacing_catalog_bytes: int = 0
    ) -> StorageStatus:
        if requested_bytes < 0 or replacing_catalog_bytes < 0:
            raise InvalidArgumentError("storage byte counts cannot be negative")
        self._assert_root()
        self._assert_managed_root()
        async with self.database.connect() as connection:
            catalog_bytes = await _catalog_bytes(connection)
        effective_catalog = await asyncio.to_thread(
            self._managed_usage_bytes,
            catalog_bytes,
            replacing_catalog_bytes,
            0,
        )
        disk_free = await asyncio.to_thread(lambda: shutil.disk_usage(self.managed_root).free)
        return StorageStatus(
            requested_bytes=requested_bytes,
            catalog_bytes=effective_catalog,
            quota_bytes=self.quota_bytes,
            disk_free_bytes=disk_free,
            reserve_bytes=self.reserve_bytes,
        )

    async def ensure_capacity(
        self, requested_bytes: int, *, replacing_catalog_bytes: int = 0
    ) -> StorageStatus:
        status = await self.storage_status(
            requested_bytes, replacing_catalog_bytes=replacing_catalog_bytes
        )
        if not status.can_allocate:
            raise InsufficientStorageError(status)
        return status

    async def check(self) -> bool:
        """Probe catalog health, storage writability, and the reserved free space."""

        temporary: Path | None = None
        try:
            if not await self.database.check():
                return False
            self._assert_root()
            self._assert_managed_root()
            free_bytes = await asyncio.to_thread(lambda: shutil.disk_usage(self.managed_root).free)
            if free_bytes < self.reserve_bytes:
                return False
            temporary = self.root / f".health.{uuid.uuid4().hex}.part"
            await asyncio.to_thread(_write_file_sync, temporary, b"")
            await asyncio.to_thread(temporary.unlink)
            await asyncio.to_thread(_fsync_directory, self.root)
        except (InvalidArgumentError, OSError):
            return False
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return True

    async def store_bytes(
        self,
        asset_id: str,
        relative_path: str,
        payload: bytes,
        *,
        kind: str = "image",
        media_type: str | None = None,
        source_job_id: str | None = None,
        metadata: Mapping[str, JsonValue] | None = None,
        replace: bool = False,
    ) -> AssetRecord:
        if not isinstance(payload, bytes):
            raise InvalidArgumentError("asset payload must be bytes")
        resolved_id = _normalize_identifier(asset_id, "asset_id")
        normalized_path = _normalize_relative_path(relative_path)
        metadata_json = _canonical_metadata(metadata or {})
        target = self._resolve_relative(normalized_path)

        async with self._write_lock:
            async with self.database.connect() as connection:
                existing_row = await _fetchone(
                    connection, "SELECT * FROM assets WHERE id = ?", (resolved_id,)
                )
                path_owner = await _fetchone(
                    connection,
                    "SELECT id FROM assets WHERE relative_path = ? AND id != ?",
                    (normalized_path, resolved_id),
                )
                catalog_bytes = await _catalog_bytes(connection)
            if path_owner is not None:
                raise AssetConflictError(
                    "asset path is already cataloged",
                    code=AssetConflictError.code,
                    details={
                        "relative_path": normalized_path,
                        "asset_id": str(path_owner["id"]),
                    },
                )
            if target.exists() and not replace:
                raise AssetConflictError(
                    "asset destination already exists",
                    code=AssetConflictError.code,
                    details={"relative_path": normalized_path},
                )
            replacing_catalog = (
                int(existing_row["byte_size"])
                if existing_row is not None and existing_row["status"] in {"available", "orphaned"}
                else 0
            )
            replacing_physical = (
                target.stat().st_size if target.is_file() and not target.is_symlink() else 0
            )
            base_usage = await asyncio.to_thread(
                self._managed_usage_bytes,
                catalog_bytes,
                replacing_catalog,
                replacing_physical,
            )
            disk_free = await asyncio.to_thread(lambda: shutil.disk_usage(self.managed_root).free)
            capacity = StorageStatus(
                requested_bytes=len(payload),
                catalog_bytes=base_usage,
                quota_bytes=self.quota_bytes,
                disk_free_bytes=disk_free,
                reserve_bytes=self.reserve_bytes,
            )
            if not capacity.can_allocate:
                raise InsufficientStorageError(capacity)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
            try:
                await asyncio.to_thread(_write_file_sync, temporary, payload)
                os.replace(temporary, target)
                await asyncio.to_thread(_fsync_directory, target.parent)
            finally:
                temporary.unlink(missing_ok=True)

            # If cataloging fails, the file is intentionally left as an orphan for
            # reconciliation instead of being silently deleted.
            return await self._register_known_file(
                resolved_id,
                normalized_path,
                byte_size=len(payload),
                digest=hashlib.sha256(payload).hexdigest(),
                kind=kind,
                media_type=media_type,
                source_job_id=source_job_id,
                metadata_json=metadata_json,
                status="available",
            )

    async def register_asset(
        self,
        asset_id: str,
        path: Path,
        *,
        kind: str = "image",
        media_type: str | None = None,
        source_job_id: str | None = None,
        metadata: Mapping[str, JsonValue] | None = None,
        status: str = "available",
    ) -> AssetRecord:
        resolved_id = _normalize_identifier(asset_id, "asset_id")
        resolved_path, relative_path = self._resolve_existing(path)
        if status not in ASSET_STATUSES:
            raise InvalidArgumentError("unknown asset status")
        byte_size, digest = await asyncio.to_thread(_measure_file, resolved_path)
        metadata_json = _canonical_metadata(metadata or {})
        async with self._write_lock:
            async with self.database.connect() as connection:
                existing = await _fetchone(
                    connection, "SELECT * FROM assets WHERE id = ?", (resolved_id,)
                )
                catalog_bytes = await _catalog_bytes(connection)
            replacing = (
                int(existing["byte_size"])
                if existing is not None and existing["status"] in {"available", "orphaned"}
                else 0
            )
            projected_catalog = max(0, catalog_bytes - replacing) + byte_size
            projected_usage = await asyncio.to_thread(
                self._managed_usage_bytes,
                projected_catalog,
                0,
                0,
            )
            if projected_usage > self.quota_bytes:
                disk_free = await asyncio.to_thread(
                    lambda: shutil.disk_usage(self.managed_root).free
                )
                raise InsufficientStorageError(
                    StorageStatus(
                        requested_bytes=byte_size,
                        catalog_bytes=max(0, projected_usage - byte_size),
                        quota_bytes=self.quota_bytes,
                        disk_free_bytes=disk_free,
                        reserve_bytes=self.reserve_bytes,
                    )
                )
            return await self._register_known_file(
                resolved_id,
                relative_path,
                byte_size=byte_size,
                digest=digest,
                kind=kind,
                media_type=media_type,
                source_job_id=source_job_id,
                metadata_json=metadata_json,
                status=status,
            )

    async def get_asset(self, asset_id: str) -> AssetRecord | None:
        resolved_id = _normalize_identifier(asset_id, "asset_id")
        async with self.database.connect() as connection:
            row = await _fetchone(connection, "SELECT * FROM assets WHERE id = ?", (resolved_id,))
        return _row_to_asset(row) if row is not None else None

    async def require_asset(self, asset_id: str) -> AssetRecord:
        asset = await self.get_asset(asset_id)
        if asset is None:
            raise AssetNotFoundError(asset_id)
        return asset

    async def list_assets(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        statuses: Iterable[str] | None = None,
    ) -> list[AssetRecord]:
        if limit < 1 or limit > 1000 or offset < 0:
            raise InvalidArgumentError("invalid asset page")
        normalized_statuses = tuple(dict.fromkeys(statuses or ()))
        if any(item not in ASSET_STATUSES for item in normalized_statuses):
            raise InvalidArgumentError("unknown asset status")
        status_values = list(normalized_statuses)
        status_values.extend("" for _ in range(len(ASSET_STATUSES) - len(status_values)))
        parameters: list[object] = [int(bool(normalized_statuses)), *status_values]
        parameters.extend((limit, offset))
        async with self.database.connect() as connection:
            cursor = await connection.execute(
                """
                SELECT * FROM assets
                WHERE ? = 0 OR status IN (?, ?, ?)
                ORDER BY created_at DESC, id
                LIMIT ? OFFSET ?
                """,
                tuple(parameters),
            )
            rows = await cursor.fetchall()
            await cursor.close()
        return [_row_to_asset(row) for row in rows]

    async def remove_from_catalog(self, asset_id: str) -> bool:
        """Forget a catalog row. The underlying file is deliberately untouched."""
        resolved_id = _normalize_identifier(asset_id, "asset_id")
        async with self._write_lock:
            async with self.database.transaction() as connection:
                cursor = await connection.execute("DELETE FROM assets WHERE id = ?", (resolved_id,))
                removed = cursor.rowcount > 0
                await cursor.close()
        return removed

    async def delete_asset(self, asset_id: str) -> bool:
        """Explicitly delete one cataloged file; never called by automatic cleanup."""

        resolved_id = _normalize_identifier(asset_id, "asset_id")
        async with self._write_lock:
            async with self.database.connect() as connection:
                row = await _fetchone(
                    connection,
                    "SELECT * FROM assets WHERE id = ?",
                    (resolved_id,),
                )
            if row is None:
                return False
            target = self._resolve_relative(str(row["relative_path"]))
            if target.is_symlink():
                raise InvalidArgumentError("symbolic-link assets are not supported")
            intent: _DeleteIntent | None = None
            if target.exists():
                if not target.is_file():
                    raise InvalidArgumentError("asset path is not a regular file")
                intent = await asyncio.to_thread(
                    _begin_delete_intent,
                    self._delete_intent_root,
                    target,
                    resolved_id,
                    str(row["relative_path"]),
                )
            try:
                async with self.database.transaction() as connection:
                    cursor = await connection.execute(
                        "DELETE FROM assets WHERE id = ?",
                        (resolved_id,),
                    )
                    removed = cursor.rowcount
                    await cursor.close()
                    if removed != 1:
                        raise AssetConflictError(
                            "asset catalog changed during deletion",
                            code=AssetConflictError.code,
                            details={"asset_id": resolved_id},
                        )
            except BaseException:
                if intent is not None:
                    await asyncio.to_thread(_rollback_delete_intent, intent)
                raise
            if intent is not None:
                try:
                    await asyncio.to_thread(_finish_delete_intent, intent)
                except OSError:
                    # The catalog commit is authoritative. The durable intent is
                    # completed on next startup without touching unrelated files.
                    pass
            return True

    def asset_path(self, asset: AssetRecord) -> Path:
        """Resolve a catalog record inside the asset root without following symlinks."""

        return self._resolve_relative(asset.relative_path)

    async def reconcile_orphans(self) -> ReconciliationReport:
        self._assert_root()
        async with self._write_lock:
            async with self.database.connect() as connection:
                cursor = await connection.execute("SELECT * FROM assets ORDER BY id")
                before_rows = await cursor.fetchall()
                await cursor.close()
            intent_skipped = await asyncio.to_thread(
                self._recover_delete_intents,
                {str(row["id"]): str(row["relative_path"]) for row in before_rows},
            )
            files, scan_skipped = await asyncio.to_thread(self._scan_files)
            self._assert_managed_root()
            managed_physical = await asyncio.to_thread(_physical_bytes, self.managed_root)
            asset_physical = await asyncio.to_thread(_physical_bytes, self.root)
            asset_catalog_limit = max(
                0,
                self.quota_bytes - max(0, managed_physical - asset_physical),
            )
            async with self.database.transaction() as connection:
                cursor = await connection.execute("SELECT * FROM assets ORDER BY id")
                rows = await cursor.fetchall()
                await cursor.close()
                catalog_by_path = {str(row["relative_path"]): row for row in rows}
                catalog_bytes = sum(
                    int(row["byte_size"])
                    for row in rows
                    if row["status"] in {"available", "orphaned"}
                )
                now = _utc_now()
                missing: list[str] = []
                recovered: list[str] = []
                orphaned: list[str] = []
                skipped: list[str] = [*intent_skipped, *scan_skipped]

                for relative_path, row in catalog_by_path.items():
                    if relative_path not in files:
                        if row["status"] != "missing":
                            await connection.execute(
                                "UPDATE assets SET status = 'missing', updated_at = ? WHERE id = ?",
                                (now, row["id"]),
                            )
                            catalog_bytes -= int(row["byte_size"])
                        missing.append(str(row["id"]))
                    else:
                        size, digest = files[relative_path]
                        old_counted = (
                            int(row["byte_size"])
                            if row["status"] in {"available", "orphaned"}
                            else 0
                        )
                        next_status = (
                            "available" if row["status"] == "missing" else str(row["status"])
                        )
                        if (
                            row["status"] == "missing"
                            or int(row["byte_size"]) != size
                            or str(row["sha256"]) != digest
                        ):
                            await connection.execute(
                                """
                                UPDATE assets SET status = ?, byte_size = ?, sha256 = ?,
                                    updated_at = ? WHERE id = ?
                                """,
                                (next_status, size, digest, now, row["id"]),
                            )
                            catalog_bytes = catalog_bytes - old_counted + size
                            if catalog_bytes > asset_catalog_limit:
                                skipped.append(relative_path)
                            if row["status"] == "missing":
                                recovered.append(str(row["id"]))

                for relative_path, (byte_size, digest) in files.items():
                    if relative_path in catalog_by_path:
                        continue
                    if catalog_bytes + byte_size > asset_catalog_limit:
                        skipped.append(relative_path)
                        continue
                    path_digest = hashlib.sha256(relative_path.encode("utf-8")).hexdigest()
                    asset_id = "orphan-" + path_digest[:24]
                    collision = await _fetchone(
                        connection, "SELECT 1 FROM assets WHERE id = ?", (asset_id,)
                    )
                    if collision is not None:
                        asset_id = "orphan-" + uuid.uuid4().hex
                    await connection.execute(
                        """
                        INSERT INTO assets(
                            id, kind, relative_path, media_type, byte_size, sha256,
                            source_job_id, status, metadata_json, created_at, updated_at
                        ) VALUES (?, 'orphan', ?, ?, ?, ?, NULL, 'orphaned', ?, ?, ?)
                        """,
                        (
                            asset_id,
                            relative_path,
                            mimetypes.guess_type(relative_path)[0],
                            byte_size,
                            digest,
                            '{"reconciled":true}',
                            now,
                            now,
                        ),
                    )
                    catalog_bytes += byte_size
                    orphaned.append(asset_id)

        return ReconciliationReport(
            missing_asset_ids=tuple(missing),
            recovered_asset_ids=tuple(recovered),
            orphan_asset_ids=tuple(orphaned),
            skipped_relative_paths=tuple(skipped),
        )

    def _recover_delete_intents(self, catalog_by_id: Mapping[str, str]) -> tuple[str, ...]:
        root = self._delete_intent_root
        if not root.exists():
            return ()
        skipped: list[str] = []
        for directory in sorted(root.iterdir()):
            label = directory.name
            if (
                directory.is_symlink()
                or not directory.is_dir()
                or len(label) != 32
                or any(character not in "0123456789abcdef" for character in label)
            ):
                skipped.append(label)
                continue
            try:
                intent = _read_delete_intent(root, directory, self.root)
                catalog_path = catalog_by_id.get(intent.asset_id)
                if catalog_path == intent.relative_path:
                    if intent.payload_path.exists() and not intent.target_path.exists():
                        os.replace(intent.payload_path, intent.target_path)
                        _fsync_directory(intent.target_path.parent)
                    if intent.payload_path.exists() and intent.target_path.exists():
                        skipped.append(label)
                        continue
                    if not intent.target_path.exists():
                        skipped.append(label)
                        continue
                    _remove_delete_intent_metadata(intent)
                else:
                    _finish_delete_intent(intent)
            except (InvalidArgumentError, OSError, ValueError, json.JSONDecodeError):
                skipped.append(label)
        try:
            root.rmdir()
        except OSError:
            pass
        return tuple(skipped)

    async def _register_known_file(
        self,
        asset_id: str,
        relative_path: str,
        *,
        byte_size: int,
        digest: str,
        kind: str,
        media_type: str | None,
        source_job_id: str | None,
        metadata_json: str,
        status: str,
    ) -> AssetRecord:
        normalized_kind = _normalize_identifier(kind, "kind")
        normalized_source = (
            _normalize_identifier(source_job_id, "source_job_id") if source_job_id else None
        )
        now = _utc_now()
        async with self.database.transaction() as connection:
            path_owner = await _fetchone(
                connection,
                "SELECT id FROM assets WHERE relative_path = ? AND id != ?",
                (relative_path, asset_id),
            )
            if path_owner is not None:
                raise AssetConflictError(
                    "asset path is already cataloged",
                    code=AssetConflictError.code,
                    details={"relative_path": relative_path, "asset_id": str(path_owner["id"])},
                )
            await connection.execute(
                """
                INSERT INTO assets(
                    id, kind, relative_path, media_type, byte_size, sha256,
                    source_job_id, status, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    relative_path = excluded.relative_path,
                    media_type = excluded.media_type,
                    byte_size = excluded.byte_size,
                    sha256 = excluded.sha256,
                    source_job_id = excluded.source_job_id,
                    status = excluded.status,
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
                """,
                (
                    asset_id,
                    normalized_kind,
                    relative_path,
                    media_type or mimetypes.guess_type(relative_path)[0],
                    byte_size,
                    digest,
                    normalized_source,
                    status,
                    metadata_json,
                    now,
                    now,
                ),
            )
            row = await _fetchone(connection, "SELECT * FROM assets WHERE id = ?", (asset_id,))
        assert row is not None
        return _row_to_asset(row)

    def _resolve_relative(self, relative_path: str) -> Path:
        self._assert_root()
        root = self._canonical_root
        assert root is not None
        relative = Path(relative_path)
        current = root
        for part in relative.parts[:-1]:
            current = current / part
            if current.is_symlink():
                raise InvalidArgumentError("symbolic-link asset paths are not supported")
        parent = (root / relative.parent).resolve()
        try:
            parent.relative_to(root)
        except ValueError as exc:
            raise InvalidArgumentError("asset path escapes the asset root") from exc
        candidate = parent / relative.name
        if candidate.is_symlink():
            raise InvalidArgumentError("symbolic-link assets are not supported")
        return candidate

    def _resolve_existing(self, path: Path) -> tuple[Path, str]:
        self._assert_root()
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        if candidate.is_symlink():
            raise InvalidArgumentError("symbolic-link assets are not supported")
        try:
            resolved = candidate.resolve(strict=True)
            root = self._canonical_root
            assert root is not None
            relative = resolved.relative_to(root).as_posix()
        except (FileNotFoundError, ValueError) as exc:
            raise InvalidArgumentError("asset must be a file inside the asset root") from exc
        if not resolved.is_file():
            raise InvalidArgumentError("asset must be a regular file")
        return resolved, relative

    def _scan_files(self) -> tuple[dict[str, tuple[int, str]], tuple[str, ...]]:
        self._assert_root()
        files: dict[str, tuple[int, str]] = {}
        skipped: list[str] = []
        root = self._canonical_root
        assert root is not None
        for path in sorted(root.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            raw_relative = path.relative_to(root).as_posix()
            if _is_service_temporary_file(path.name):
                try:
                    path.unlink()
                except OSError:
                    skipped.append(raw_relative)
                continue
            if path.name.endswith(".part"):
                # Unknown ``.part`` files may be user-owned. Ignore them but do
                # not delete anything that does not match our exact temp format.
                continue
            try:
                relative = _normalize_relative_path(raw_relative)
                files[relative] = _measure_file(path)
            except (InvalidArgumentError, OSError):
                skipped.append(raw_relative)
        return files, tuple(skipped)

    def _assert_root(self) -> None:
        identity = self._root_identity
        if identity is None:
            raise InvalidArgumentError("asset storage has not been initialized")
        try:
            metadata = os.lstat(self.root)
        except FileNotFoundError as exc:
            raise InvalidArgumentError("asset storage root is missing") from exc
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != identity
        ):
            raise InvalidArgumentError("asset storage root changed or is not a regular directory")

    def _assert_managed_root(self) -> None:
        identity = self._managed_root_identity
        if identity is None:
            raise InvalidArgumentError("managed data directory has not been initialized")
        try:
            metadata = os.lstat(self.managed_root)
        except FileNotFoundError as exc:
            raise InvalidArgumentError("managed data directory is missing") from exc
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != identity
        ):
            raise InvalidArgumentError(
                "managed data directory changed or is not a regular directory"
            )

    def _managed_usage_bytes(
        self,
        catalog_bytes: int,
        replacing_catalog_bytes: int,
        replacing_physical_bytes: int,
    ) -> int:
        """Count the complete managed tree, using the catalog as an asset floor."""

        self._assert_root()
        self._assert_managed_root()
        asset_physical = _physical_bytes(self.root)
        managed_physical = _physical_bytes(self.managed_root)
        non_asset_physical = max(0, managed_physical - asset_physical)
        effective_assets = max(
            max(0, catalog_bytes - replacing_catalog_bytes),
            max(0, asset_physical - replacing_physical_bytes),
        )
        return non_asset_physical + effective_assets


async def _catalog_bytes(connection: aiosqlite.Connection) -> int:
    row = await _fetchone(
        connection,
        "SELECT COALESCE(SUM(byte_size), 0) AS total FROM assets WHERE status != 'missing'",
    )
    assert row is not None
    return int(row["total"])


async def _fetchone(
    connection: aiosqlite.Connection, sql: str, parameters: Sequence[object] = ()
) -> aiosqlite.Row | None:
    cursor = await connection.execute(sql, tuple(parameters))
    row = await cursor.fetchone()
    await cursor.close()
    return row


def _row_to_asset(row: aiosqlite.Row) -> AssetRecord:
    metadata = json.loads(row["metadata_json"])
    if not isinstance(metadata, dict):
        raise InvalidArgumentError("asset catalog metadata is invalid")
    return AssetRecord(
        id=str(row["id"]),
        kind=str(row["kind"]),
        relative_path=_normalize_relative_path(str(row["relative_path"])),
        media_type=str(row["media_type"]) if row["media_type"] is not None else None,
        byte_size=int(row["byte_size"]),
        sha256=str(row["sha256"]),
        source_job_id=str(row["source_job_id"]) if row["source_job_id"] is not None else None,
        status=str(row["status"]),
        metadata=metadata,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _normalize_relative_path(value: str) -> str:
    raw = str(value).strip()
    if not raw or len(raw) > 1024 or "\\" in raw or any(ord(char) < 32 for char in raw):
        raise InvalidArgumentError("asset relative_path is invalid")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(
        part in {"", ".", ".."} or ":" in part or part.endswith((".", " ")) for part in path.parts
    ):
        raise InvalidArgumentError("asset relative_path is invalid")
    return path.as_posix()


def _normalize_identifier(value: str, field: str) -> str:
    normalized = str(value).strip()
    if not normalized or len(normalized) > 200 or any(ord(char) < 32 for char in normalized):
        raise InvalidArgumentError(f"{field} is invalid")
    return normalized


def _is_service_temporary_file(name: str) -> bool:
    stem, separator, suffix = name.rpartition(".")
    if separator != "." or suffix != "part":
        return False
    prefix, separator, token = stem.rpartition(".")
    return (
        separator == "."
        and prefix.startswith(".")
        and len(prefix) > 1
        and len(token) == 32
        and all(character in "0123456789abcdef" for character in token)
    )


def _canonical_metadata(value: Mapping[str, JsonValue]) -> str:
    if not isinstance(value, Mapping):
        raise InvalidArgumentError("asset metadata must be a JSON object")
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise InvalidArgumentError("asset metadata must contain valid JSON values") from exc


def _begin_delete_intent(
    intent_root: Path,
    target: Path,
    asset_id: str,
    relative_path: str,
) -> _DeleteIntent:
    normalized_id = _normalize_identifier(asset_id, "asset_id")
    normalized_path = _normalize_relative_path(relative_path)
    intent_root.mkdir(parents=True, exist_ok=True)
    if intent_root.is_symlink():
        raise InvalidArgumentError("asset delete-intent root must not be a symbolic link")
    directory = intent_root / uuid.uuid4().hex
    directory.mkdir(mode=0o700)
    intent = _DeleteIntent(
        directory=directory,
        manifest_path=directory / "intent.json",
        payload_path=directory / "payload",
        target_path=target,
        asset_id=normalized_id,
        relative_path=normalized_path,
    )
    manifest = json.dumps(
        {
            "version": 1,
            "asset_id": normalized_id,
            "relative_path": normalized_path,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    moved = False
    try:
        _write_file_sync(intent.manifest_path, manifest)
        _fsync_directory(directory)
        os.replace(target, intent.payload_path)
        moved = True
        _fsync_directory(target.parent)
        _fsync_directory(directory)
        return intent
    except BaseException:
        if moved and intent.payload_path.exists() and not target.exists():
            os.replace(intent.payload_path, target)
            _fsync_directory(target.parent)
        try:
            _remove_delete_intent_metadata(intent)
        except OSError:
            pass
        raise


def _read_delete_intent(
    intent_root: Path,
    directory: Path,
    assets_root: Path,
) -> _DeleteIntent:
    if directory.parent != intent_root or directory.is_symlink():
        raise InvalidArgumentError("asset delete intent escapes its root")
    manifest_path = directory / "intent.json"
    payload_path = directory / "payload"
    if (
        manifest_path.is_symlink()
        or not manifest_path.is_file()
        or manifest_path.stat().st_size > 64 * 1024
        or payload_path.is_symlink()
    ):
        raise InvalidArgumentError("asset delete intent is invalid")
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or set(raw) != {"version", "asset_id", "relative_path"}:
        raise InvalidArgumentError("asset delete intent manifest is invalid")
    if raw["version"] != 1:
        raise InvalidArgumentError("asset delete intent version is unsupported")
    asset_id = _normalize_identifier(str(raw["asset_id"]), "asset_id")
    relative_path = _normalize_relative_path(str(raw["relative_path"]))
    target_path = _resolve_delete_target(assets_root, relative_path)
    return _DeleteIntent(
        directory=directory,
        manifest_path=manifest_path,
        payload_path=payload_path,
        target_path=target_path,
        asset_id=asset_id,
        relative_path=relative_path,
    )


def _resolve_delete_target(assets_root: Path, relative_path: str) -> Path:
    root = assets_root.resolve()
    relative = PurePosixPath(relative_path)
    candidate = root.joinpath(*relative.parts)
    current = root
    for part in relative.parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise InvalidArgumentError("symbolic-link asset paths are not supported")
    try:
        candidate.parent.resolve().relative_to(root)
    except ValueError as exc:
        raise InvalidArgumentError("asset delete intent escapes the asset root") from exc
    if candidate.is_symlink():
        raise InvalidArgumentError("symbolic-link assets are not supported")
    return candidate


def _rollback_delete_intent(intent: _DeleteIntent) -> None:
    if intent.payload_path.exists():
        if intent.target_path.exists():
            raise FileExistsError("asset target was recreated while deletion rolled back")
        os.replace(intent.payload_path, intent.target_path)
        _fsync_directory(intent.target_path.parent)
    _remove_delete_intent_metadata(intent)


def _finish_delete_intent(intent: _DeleteIntent) -> None:
    if intent.payload_path.is_symlink():
        raise InvalidArgumentError("asset delete-intent payload must not be a symbolic link")
    intent.payload_path.unlink(missing_ok=True)
    _remove_delete_intent_metadata(intent)


def _remove_delete_intent_metadata(intent: _DeleteIntent) -> None:
    intent.manifest_path.unlink(missing_ok=True)
    intent.directory.rmdir()
    _fsync_directory(intent.directory.parent)


def _measure_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _write_file_sync(path: Path, payload: bytes) -> None:
    with path.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def _prepare_storage_root(path: Path) -> tuple[int, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        path.mkdir(mode=0o700)
        metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise InvalidArgumentError("asset storage root must be a regular directory")
    return metadata.st_dev, metadata.st_ino


def _physical_bytes(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            total += path.stat().st_size
        except FileNotFoundError:
            continue
    return total


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
