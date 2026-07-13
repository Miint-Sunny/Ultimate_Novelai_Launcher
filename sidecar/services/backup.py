from __future__ import annotations

import asyncio
import ctypes
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import uuid
import zipfile
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager, closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from backend_core.errors import (
    CapacityExceededError,
    ConflictError,
    InvalidArgumentError,
    ResourceNotFoundError,
)
from sidecar.local_settings import read_local_settings, settings_path
from sidecar.persistence import DEFAULT_MIGRATIONS, Database, DatabaseIntegrityError
from sidecar.persistence.migrations import validate_default_schema_connection

if TYPE_CHECKING:
    from sidecar.services.assets import AssetService

BACKUP_FORMAT = "ultimate-novelai-launcher-backup"
BACKUP_FORMAT_VERSION = 1
MANIFEST_NAME = "manifest.json"
DATABASE_NAME = "database.sqlite3"
SETTINGS_NAME = "settings.json"
RESTORE_INTENT_NAME = ".restore-intent.json"
_RESTORE_INTENT_FORMAT = "ultimate-novelai-launcher-restore-intent"
_RESTORE_INTENT_VERSION = 1
_RESTORE_INTENT_MAX_BYTES = 4096
_MAX_SETTINGS_BYTES = 64 * 1024
_DEFAULT_MAX_BACKUP_BYTES = 10 * 1024**3
_DEFAULT_DISK_RESERVE_BYTES = 1024**3


class BackupValidationError(InvalidArgumentError):
    code = "invalid_backup"

    def __init__(self, message: str) -> None:
        super().__init__(message, code=self.code)


class UnsupportedBackupVersionError(ConflictError):
    code = "unsupported_backup_version"

    def __init__(self, version: int) -> None:
        super().__init__(
            f"backup format version {version} is not supported",
            code=self.code,
            details={"version": version, "supported_version": BACKUP_FORMAT_VERSION},
        )


class RestoreFailedError(ConflictError):
    code = "restore_failed"


class RestoreRecoveryError(RestoreFailedError):
    """Fail startup closed when a durable restore transaction is ambiguous."""

    code = "restore_recovery_failed"


@dataclass(frozen=True)
class RestoreIntent:
    token: str
    phase: str
    includes_assets: bool
    includes_settings: bool
    original_database_exists: bool
    original_assets_exists: bool
    original_settings_exists: bool

    def committed(self) -> RestoreIntent:
        return RestoreIntent(
            token=self.token,
            phase="committed",
            includes_assets=self.includes_assets,
            includes_settings=self.includes_settings,
            original_database_exists=self.original_database_exists,
            original_assets_exists=self.original_assets_exists,
            original_settings_exists=self.original_settings_exists,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": _RESTORE_INTENT_FORMAT,
            "version": _RESTORE_INTENT_VERSION,
            "token": self.token,
            "phase": self.phase,
            "includes_assets": self.includes_assets,
            "includes_settings": self.includes_settings,
            "originals": {
                "database": self.original_database_exists,
                "assets": self.original_assets_exists,
                "settings": self.original_settings_exists,
            },
        }


class BackupNotFoundError(ResourceNotFoundError):
    code = "backup_not_found"

    def __init__(self, reference: str) -> None:
        super().__init__(
            "backup was not found",
            code=self.code,
            details={"backup": reference},
        )


class BackupStorageError(CapacityExceededError):
    code = "insufficient_storage"
    retryable = False

    def __init__(
        self,
        *,
        required_bytes: int,
        free_bytes: int,
        reserve_bytes: int,
        managed_bytes: int | None = None,
        quota_bytes: int | None = None,
    ) -> None:
        details: dict[str, int | bool] = {
            "required_bytes": required_bytes,
            "disk_free_bytes": free_bytes,
            "reserve_bytes": reserve_bytes,
            "retryable": False,
        }
        if managed_bytes is not None:
            details["managed_bytes"] = managed_bytes
        if quota_bytes is not None:
            details["quota_bytes"] = quota_bytes
        super().__init__(
            "backup storage does not have enough quota or reserved disk space",
            code=self.code,
            details=details,
        )


@dataclass(frozen=True)
class BackupEntry:
    path: str
    byte_size: int
    sha256: str
    kind: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "byte_size": self.byte_size,
            "sha256": self.sha256,
            "kind": self.kind,
        }


@dataclass(frozen=True)
class BackupManifest:
    backup_id: str
    created_at: str
    schema_version: int
    includes_assets: bool
    files: tuple[BackupEntry, ...]
    format: str = BACKUP_FORMAT
    version: int = BACKUP_FORMAT_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "version": self.version,
            "backup_id": self.backup_id,
            "created_at": self.created_at,
            "schema_version": self.schema_version,
            "includes_assets": self.includes_assets,
            "files": [entry.to_dict() for entry in self.files],
        }


@dataclass(frozen=True)
class BackupResult:
    archive_path: Path
    manifest: BackupManifest


@dataclass(frozen=True)
class BackupDeletion:
    filename: str
    reclaimed_bytes: int


@dataclass
class RestoreStaging:
    path: Path
    archive_path: Path
    manifest: BackupManifest
    root: Path | None = None
    root_identity: tuple[int, int] | None = None
    path_identity: tuple[int, int] | None = None

    @property
    def database_path(self) -> Path:
        return self.path / DATABASE_NAME

    @property
    def assets_path(self) -> Path:
        return self.path / "assets"

    @property
    def settings_path(self) -> Path:
        return self.path / SETTINGS_NAME

    def cleanup(self) -> None:
        if self.root is None or self.root_identity is None or self.path_identity is None:
            shutil.rmtree(self.path, ignore_errors=True)
            return
        _remove_service_child(
            self.root,
            self.root_identity,
            self.path,
            self.path_identity,
            directory=True,
        )

    def __enter__(self) -> RestoreStaging:
        return self

    def __exit__(self, *_args: object) -> None:
        self.cleanup()


@dataclass(frozen=True)
class RestoreResult:
    manifest: BackupManifest
    safety_backup_path: Path


@dataclass(frozen=True)
class _RestorePathSet:
    name: str
    canonical: Path
    candidate: Path
    rollback: Path
    kind: str
    included: bool
    original_exists: bool


class BackupService:
    """Create versioned ZIP backups and restore only from validated staging."""

    def __init__(
        self,
        database: Database,
        assets_root: Path,
        *,
        asset_service: AssetService | None = None,
        managed_root: Path | None = None,
        backup_dir: Path | None = None,
        staging_root: Path | None = None,
        quota_bytes: int = _DEFAULT_MAX_BACKUP_BYTES,
        max_entries: int = 100_000,
        max_uncompressed_bytes: int = _DEFAULT_MAX_BACKUP_BYTES,
        max_compression_ratio: int = 1_000,
        disk_reserve_bytes: int = _DEFAULT_DISK_RESERVE_BYTES,
    ) -> None:
        self.database = database
        self.assets_root = Path(assets_root)
        self.asset_service = asset_service
        self.data_dir = database.path.parent
        self.managed_root = Path(managed_root) if managed_root is not None else self.data_dir
        self.settings_path = settings_path(self.data_dir)
        self.restore_intent_path = self.data_dir / RESTORE_INTENT_NAME
        self.backup_dir = backup_dir or database.path.parent / "backups"
        self.staging_root = staging_root or database.path.parent / ".restore-staging"
        self.max_entries = max_entries
        self.max_uncompressed_bytes = max_uncompressed_bytes
        self.max_compression_ratio = max_compression_ratio
        self.disk_reserve_bytes = disk_reserve_bytes
        if (
            max_entries < 2
            or max_uncompressed_bytes < 1
            or max_compression_ratio < 1
            or disk_reserve_bytes < 0
            or quota_bytes < 1
        ):
            raise ValueError("invalid backup validation limits")
        self.quota_bytes = quota_bytes
        self._operation_lock = asyncio.Lock()
        self._recovery_lock = asyncio.Lock()
        self._initialized = False
        self._backup_dir_identity: tuple[int, int] | None = None
        self._staging_root_identity: tuple[int, int] | None = None
        self._managed_root_identity: tuple[int, int] | None = None

    async def initialize(self) -> None:
        # Recovery must run before Database.initialize(): migration startup is
        # permitted to create a fresh database, which would otherwise hide a
        # canonical -> rollback crash gap.
        async with self._operation_lock:
            if self._initialized:
                self._assert_service_roots()
                await self.database.initialize()
                return
            await self._recover_interrupted_restore()
            await self.database.initialize()
            self.assets_root.mkdir(parents=True, exist_ok=True)
            self._managed_root_identity = await asyncio.to_thread(
                _prepare_service_directory, self.managed_root, "managed data directory"
            )
            self._backup_dir_identity = await asyncio.to_thread(
                _prepare_service_directory, self.backup_dir, "backup directory"
            )
            self._staging_root_identity = await asyncio.to_thread(
                _prepare_service_directory, self.staging_root, "restore staging directory"
            )
            self._assert_service_roots()
            self._initialized = True

    async def _ensure_initialized(self) -> None:
        if not self._initialized:
            await self.initialize()
        else:
            self._assert_service_roots()

    async def recover_interrupted_restore(self) -> None:
        """Recover the one durable restore transaction, without opening SQLite.

        ``prepared`` is an uncommitted transaction and always restores the old
        canonical paths. ``committed`` keeps the new paths and only completes
        cleanup. Malformed intents or impossible path combinations abort startup
        instead of allowing SQLite to create an empty replacement database.
        """

        async with self._operation_lock:
            await self._recover_interrupted_restore()

    async def _recover_interrupted_restore(self) -> None:
        async with self._recovery_lock:
            await asyncio.to_thread(self._recover_interrupted_restore_sync)

    async def create_backup(
        self, destination: Path | None = None, *, include_assets: bool = True
    ) -> BackupResult:
        await self.initialize()
        async with self._operation_lock:
            self._assert_service_roots()
            return await self._create_backup_unlocked(destination, include_assets=include_assets)

    async def list_backups(self) -> tuple[BackupResult, ...]:
        """Return validated backups owned by this service's backup directory.

        Invalid or partially-written archives are intentionally omitted. They remain
        available on disk for diagnostics, but can never be selected for restore by
        an untrusted API reference.
        """

        await self.initialize()
        async with self._operation_lock:
            return await self._list_backups_unlocked()

    async def _list_backups_unlocked(self) -> tuple[BackupResult, ...]:
        self._assert_service_roots()
        candidates = await asyncio.to_thread(self._backup_files)
        results: list[BackupResult] = []
        for archive_path in candidates:
            try:
                manifest = await self._validate_backup_unlocked(archive_path)
            except (BackupValidationError, UnsupportedBackupVersionError):
                continue
            results.append(BackupResult(archive_path=archive_path, manifest=manifest))
        return tuple(results)

    async def resolve_backup(self, reference: str) -> Path:
        """Resolve a UUID or safe filename without escaping ``backup_dir``."""

        await self.initialize()
        async with self._operation_lock:
            return await self._resolve_backup_unlocked(reference)

    async def _resolve_backup_unlocked(self, reference: str) -> Path:
        self._assert_service_roots()
        normalized = _validate_backup_reference(reference)
        if normalized.endswith(".zip"):
            candidate = self.backup_dir / normalized
            if not await asyncio.to_thread(_is_regular_file, candidate):
                raise BackupNotFoundError(reference)
            return candidate

        for result in await self._list_backups_unlocked():
            if result.manifest.backup_id == normalized:
                return result.archive_path
        raise BackupNotFoundError(reference)

    async def delete_backup(self, reference: str) -> BackupDeletion:
        """Explicitly delete one owned archive; never used by automatic cleanup."""

        await self.initialize()
        async with self._operation_lock:
            archive_path = await self._resolve_backup_unlocked(reference)
            self._assert_service_roots()
            metadata = await asyncio.to_thread(os.lstat, archive_path)
            if not stat.S_ISREG(metadata.st_mode):
                raise BackupNotFoundError(reference)
            reclaimed_bytes = metadata.st_size
            await asyncio.to_thread(archive_path.unlink)
            await asyncio.to_thread(_fsync_directory, self.backup_dir)
            self._assert_service_roots()
            return BackupDeletion(
                filename=archive_path.name,
                reclaimed_bytes=reclaimed_bytes,
            )

    async def validate_backup(self, archive_path: Path) -> BackupManifest:
        await self._ensure_initialized()
        async with self._operation_lock:
            return await self._validate_backup_unlocked(archive_path)

    async def _validate_backup_unlocked(self, archive_path: Path) -> BackupManifest:
        staging = await self._stage_restore_unlocked(archive_path)
        try:
            return staging.manifest
        finally:
            await asyncio.to_thread(staging.cleanup)

    async def stage_restore(self, archive_path: Path) -> RestoreStaging:
        await self._ensure_initialized()
        async with self._operation_lock:
            return await self._stage_restore_unlocked(archive_path)

    async def _stage_restore_unlocked(self, archive_path: Path) -> RestoreStaging:
        self._assert_service_roots()
        archive = Path(archive_path)
        if not await asyncio.to_thread(_is_regular_file, archive):
            raise BackupValidationError("backup archive does not exist or is not a regular file")
        staging = Path(tempfile.mkdtemp(prefix="restore-", dir=self.staging_root))
        staging_identity = await asyncio.to_thread(_directory_identity, staging)
        try:
            manifest = await asyncio.to_thread(
                _extract_and_validate,
                archive,
                staging,
                self.database.migrations.latest_version,
                self.max_entries,
                self.max_uncompressed_bytes,
                self.max_compression_ratio,
                self.disk_reserve_bytes,
            )
        except BaseException:
            await asyncio.to_thread(
                _remove_service_child,
                self.staging_root,
                self._require_staging_root_identity(),
                staging,
                staging_identity,
                True,
            )
            raise
        self._assert_service_roots()
        return RestoreStaging(
            path=staging,
            archive_path=archive,
            manifest=manifest,
            root=self.staging_root,
            root_identity=self._require_staging_root_identity(),
            path_identity=staging_identity,
        )

    async def restore_backup(self, archive_path: Path) -> RestoreResult:
        """Stage, verify, safety-backup, swap, and roll back on any failure."""
        staging = await self.stage_restore(archive_path)
        return await self.restore_staged(staging)

    async def restore_staged(self, staging: RestoreStaging) -> RestoreResult:
        """Apply a previously validated staging tree and always consume it."""

        await self.initialize()
        try:
            async with self._operation_lock:
                safety = await self._create_backup_unlocked(None, include_assets=True)
                return await self._apply_staged_restore(staging, safety)
        finally:
            await asyncio.to_thread(staging.cleanup)

    async def _create_backup_unlocked(
        self, destination: Path | None, *, include_assets: bool
    ) -> BackupResult:
        self._assert_service_roots()
        now = datetime.now(timezone.utc)
        if destination is None:
            filename = (
                f"backup-v{BACKUP_FORMAT_VERSION}-{now.strftime('%Y%m%dT%H%M%SZ')}-"
                f"{uuid.uuid4().hex[:8]}.zip"
            )
            destination = self.backup_dir / filename
        destination = Path(destination)
        if destination.parent == self.backup_dir:
            self._assert_service_roots()
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise ConflictError(
                "backup destination already exists",
                code="backup_exists",
                details={"path": str(destination)},
            )
        if _is_within(destination.resolve(), self.assets_root.resolve()):
            raise InvalidArgumentError("backup destination cannot be inside the asset root")

        build_dir: Path | None = None
        build_identity: tuple[int, int] | None = None
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
        try:
            async with self._asset_snapshot_guard():
                managed_usage = await self._managed_usage_bytes()
                build_dir = Path(tempfile.mkdtemp(prefix="backup-build-", dir=self.backup_dir))
                build_identity = await asyncio.to_thread(_directory_identity, build_dir)
                snapshot = build_dir / DATABASE_NAME
                await asyncio.to_thread(_sqlite_backup, self.database.path, snapshot)
                asset_files = await asyncio.to_thread(self._asset_files) if include_assets else []
                local_settings = await asyncio.to_thread(read_local_settings, self.data_dir)
                settings_payload = _encode_local_settings(local_settings)
                estimated_archive_bytes = (
                    snapshot.stat().st_size
                    + len(settings_payload)
                    + sum(path.stat().st_size for path in asset_files)
                    + max(64 * 1024, (len(asset_files) + 3) * 512)
                )
                if estimated_archive_bytes > self.max_uncompressed_bytes:
                    raise BackupStorageError(
                        required_bytes=estimated_archive_bytes,
                        free_bytes=await asyncio.to_thread(
                            lambda: shutil.disk_usage(destination.parent).free
                        ),
                        reserve_bytes=self.disk_reserve_bytes,
                    )
                await asyncio.to_thread(
                    _require_disk_capacity,
                    destination.parent,
                    estimated_archive_bytes,
                    self.disk_reserve_bytes,
                )
                await asyncio.to_thread(
                    _write_backup_zip,
                    temporary,
                    snapshot,
                    asset_files,
                    self.assets_root,
                    settings_payload,
                    include_assets,
                    now.isoformat(),
                )
                await asyncio.to_thread(_fsync_file, temporary)
                archive_bytes = (await asyncio.to_thread(os.lstat, temporary)).st_size
                # Validate the completed temporary archive before making it a
                # persistent user backup. A rejected archive never consumes quota.
                validated = await self._validate_backup_unlocked(temporary)
                if self._destination_uses_managed_quota(destination):
                    disk_free = await asyncio.to_thread(
                        lambda: shutil.disk_usage(self.managed_root).free
                    )
                    current_usage = await self._managed_usage_bytes()
                    build_bytes = await asyncio.to_thread(_regular_file_bytes, build_dir)
                    projected_usage = max(
                        managed_usage + archive_bytes,
                        max(0, current_usage - build_bytes),
                    )
                    if projected_usage > self.quota_bytes:
                        raise BackupStorageError(
                            required_bytes=archive_bytes,
                            free_bytes=disk_free,
                            reserve_bytes=self.disk_reserve_bytes,
                            managed_bytes=max(0, projected_usage - archive_bytes),
                            quota_bytes=self.quota_bytes,
                        )
                self._assert_service_roots()
                _durable_replace(temporary, destination)
                await asyncio.to_thread(_fsync_directory, destination.parent)
            return BackupResult(archive_path=destination, manifest=validated)
        finally:
            if destination.parent == self.backup_dir:
                identity = self._backup_dir_identity
                if identity is not None:
                    await asyncio.to_thread(
                        _remove_service_child_if_present,
                        self.backup_dir,
                        identity,
                        temporary,
                        False,
                    )
            else:
                temporary.unlink(missing_ok=True)
            if build_dir is not None and build_identity is not None:
                await asyncio.to_thread(
                    _remove_service_child,
                    self.backup_dir,
                    self._require_backup_dir_identity(),
                    build_dir,
                    build_identity,
                    True,
                )

    @asynccontextmanager
    async def _asset_snapshot_guard(self) -> AsyncIterator[None]:
        if self.asset_service is None:
            yield
            return
        async with self.asset_service.snapshot_guard():
            yield

    async def _managed_usage_bytes(self) -> int:
        if self.asset_service is not None:
            return (await self.asset_service.storage_status()).catalog_bytes
        self._assert_service_roots()
        return await asyncio.to_thread(_regular_file_bytes, self.managed_root)

    def _destination_uses_managed_quota(self, destination: Path) -> bool:
        managed = self.managed_root.resolve(strict=True)
        return _is_within(destination.resolve(strict=False), managed)

    async def _apply_staged_restore(
        self, staging: RestoreStaging, safety: BackupResult
    ) -> RestoreResult:
        token = uuid.uuid4().hex
        intent = RestoreIntent(
            token=token,
            phase="prepared",
            includes_assets=staging.manifest.includes_assets,
            includes_settings=staging.settings_path.is_file(),
            original_database_exists=self.database.path.exists(),
            original_assets_exists=self.assets_root.exists(),
            original_settings_exists=self.settings_path.exists(),
        )
        paths = self._restore_path_sets(intent)
        self._validate_restore_layout(paths)
        prepared_durable = False
        try:
            await asyncio.to_thread(self._prepare_restore_candidates, staging, paths)
            await asyncio.to_thread(_write_restore_intent, self.restore_intent_path, intent)
            prepared_durable = True
            await self.database.close()
            await asyncio.to_thread(self._install_restore_candidates, paths)
            await self.database.initialize()
            committed = intent.committed()
            await asyncio.to_thread(
                _write_restore_intent,
                self.restore_intent_path,
                committed,
            )
        except Exception as exc:
            self.database.mark_not_ready()
            try:
                recovered_phase: str | None = None
                if prepared_durable or self.restore_intent_path.exists():
                    recovered_phase = await asyncio.to_thread(
                        self._recover_interrupted_restore_sync
                    )
                else:
                    await asyncio.to_thread(self._remove_restore_candidates, paths)
                await self.database.initialize()
            except BaseException as rollback_exc:
                raise RestoreFailedError(
                    "restore and rollback both failed",
                    code=RestoreFailedError.code,
                    details={
                        "safety_backup_path": str(safety.archive_path),
                        "restore_intent_path": str(self.restore_intent_path),
                    },
                ) from rollback_exc
            if recovered_phase == "committed":
                return RestoreResult(
                    manifest=staging.manifest,
                    safety_backup_path=safety.archive_path,
                )
            raise RestoreFailedError(
                "restore failed; the previous data was restored",
                code=RestoreFailedError.code,
                details={"safety_backup_path": str(safety.archive_path)},
            ) from exc

        # The committed marker is durable before cleanup. If the process stops at
        # any point below, startup keeps the new canonical paths and resumes this
        # idempotent cleanup.
        try:
            await asyncio.to_thread(self._finish_committed_restore, committed)
        except Exception as exc:
            raise RestoreFailedError(
                "restore committed but durable cleanup is incomplete; restart required",
                code=RestoreFailedError.code,
                details={
                    "safety_backup_path": str(safety.archive_path),
                    "restore_intent_path": str(self.restore_intent_path),
                },
            ) from exc

        return RestoreResult(
            manifest=staging.manifest,
            safety_backup_path=safety.archive_path,
        )

    def _recover_interrupted_restore_sync(self) -> str | None:
        if _path_kind(self.restore_intent_path) == "absent":
            self._recover_orphans_without_intent()
            return None
        if _path_kind(self.restore_intent_path) != "file":
            raise RestoreRecoveryError(
                "restore intent is not a regular file",
                code=RestoreRecoveryError.code,
                details={"restore_intent_path": str(self.restore_intent_path)},
            )

        intent = _read_restore_intent(self.restore_intent_path)
        paths = self._restore_path_sets(intent)
        self._validate_restore_layout(paths)
        if intent.phase == "prepared":
            for path_set in paths:
                if path_set.included:
                    if path_set.name == "database" and (
                        _path_kind(path_set.rollback) != "absent" or not path_set.original_exists
                    ):
                        # Once the old database has moved to rollback, any WAL,
                        # SHM, or rollback journal at the canonical basename
                        # belongs to the uncommitted candidate database.
                        self._discard_database_sidecars()
                    _recover_prepared_path(path_set)
                else:
                    _require_transaction_paths_absent(path_set)
            _remove_restore_intent(self.restore_intent_path, intent.token)
            self._remove_restore_intent_temporaries()
            return "prepared"

        self._finish_committed_restore(intent)
        return "committed"

    def _prepare_restore_candidates(
        self,
        staging: RestoreStaging,
        paths: tuple[_RestorePathSet, ...],
    ) -> None:
        by_name = {path_set.name: path_set for path_set in paths}
        try:
            database = by_name["database"]
            _durable_replace(staging.database_path, database.candidate)
            _fsync_file(database.candidate)
            _fsync_directory(database.candidate.parent)

            assets = by_name["assets"]
            if assets.included:
                staging.assets_path.mkdir(parents=True, exist_ok=True)
                _durable_replace(staging.assets_path, assets.candidate)
                _fsync_tree(assets.candidate)
                _fsync_directory(assets.candidate.parent)

            local_settings = by_name["settings"]
            if local_settings.included:
                _durable_replace(staging.settings_path, local_settings.candidate)
                try:
                    local_settings.candidate.chmod(0o600)
                except OSError:
                    pass
                _fsync_file(local_settings.candidate)
                _fsync_directory(local_settings.candidate.parent)
        except Exception:
            self._remove_restore_candidates(paths)
            raise

    def _install_restore_candidates(self, paths: tuple[_RestorePathSet, ...]) -> None:
        self._prepare_database_sidecars_for_swap()
        for path_set in paths:
            if not path_set.included:
                continue
            _require_kind(path_set.candidate, path_set.kind, path_set.name)
            canonical_kind = _path_kind(path_set.canonical)
            if path_set.original_exists:
                if canonical_kind != path_set.kind:
                    raise RestoreRecoveryError(
                        f"restore source {path_set.name} changed before installation",
                        code=RestoreRecoveryError.code,
                    )
                if _path_kind(path_set.rollback) != "absent":
                    raise RestoreRecoveryError(
                        f"restore rollback path for {path_set.name} already exists",
                        code=RestoreRecoveryError.code,
                    )
                _durable_replace(path_set.canonical, path_set.rollback)
                _fsync_directory(path_set.canonical.parent)
            elif canonical_kind != "absent":
                raise RestoreRecoveryError(
                    f"restore destination {path_set.name} appeared during installation",
                    code=RestoreRecoveryError.code,
                )
            _durable_replace(path_set.candidate, path_set.canonical)
            _fsync_directory(path_set.canonical.parent)

    def _prepare_database_sidecars_for_swap(self) -> None:
        wal, shared_memory, journal = self._database_sidecar_paths()
        for path in (wal, shared_memory, journal):
            kind = _path_kind(path)
            if kind not in {"absent", "file"}:
                raise RestoreRecoveryError(
                    "SQLite sidecar has an unexpected path type",
                    code=RestoreRecoveryError.code,
                    details={"path": str(path), "type": kind},
                )
        if _path_kind(wal) == "file" and wal.stat().st_size != 0:
            raise RestoreRecoveryError(
                "SQLite WAL did not checkpoint before restore",
                code=RestoreRecoveryError.code,
            )
        if _path_kind(journal) != "absent":
            raise RestoreRecoveryError(
                "SQLite rollback journal exists before restore",
                code=RestoreRecoveryError.code,
            )
        _remove_owned_path(wal, "file", "SQLite WAL")
        _remove_owned_path(shared_memory, "file", "SQLite shared memory")

    def _discard_database_sidecars(self) -> None:
        for path in self._database_sidecar_paths():
            _remove_owned_path(path, "file", "uncommitted SQLite sidecar")

    def _database_sidecar_paths(self) -> tuple[Path, Path, Path]:
        database_path = self.database.path
        return (
            database_path.with_name(f"{database_path.name}-wal"),
            database_path.with_name(f"{database_path.name}-shm"),
            database_path.with_name(f"{database_path.name}-journal"),
        )

    def _finish_committed_restore(self, intent: RestoreIntent) -> None:
        paths = self._restore_path_sets(intent)
        self._validate_restore_layout(paths)
        # Validate the complete committed shape before deleting any rollback
        # evidence. An ambiguous asset/settings path must not cause partial
        # cleanup of the database transaction artifacts.
        for path_set in paths:
            if not path_set.included:
                _require_transaction_paths_absent(path_set)
                continue
            _require_kind(path_set.canonical, path_set.kind, path_set.name)
            for artifact in (path_set.candidate, path_set.rollback):
                artifact_kind = _path_kind(artifact)
                if artifact_kind not in {"absent", path_set.kind}:
                    raise RestoreRecoveryError(
                        "committed restore artifact has an unexpected path type",
                        code=RestoreRecoveryError.code,
                        details={"path": str(artifact), "type": artifact_kind},
                    )
        for path_set in paths:
            if not path_set.included:
                continue
            _remove_owned_path(path_set.candidate, path_set.kind, path_set.name)
            _remove_owned_path(path_set.rollback, path_set.kind, path_set.name)
        _remove_restore_intent(self.restore_intent_path, intent.token)
        self._remove_restore_intent_temporaries()

    def _remove_restore_candidates(self, paths: tuple[_RestorePathSet, ...]) -> None:
        for path_set in paths:
            _remove_owned_path(path_set.candidate, path_set.kind, path_set.name)

    def _restore_path_sets(self, intent: RestoreIntent) -> tuple[_RestorePathSet, ...]:
        token = intent.token
        return (
            _restore_path_set(
                "database",
                self.database.path,
                "file",
                token,
                included=True,
                original_exists=intent.original_database_exists,
            ),
            _restore_path_set(
                "assets",
                self.assets_root,
                "directory",
                token,
                included=intent.includes_assets,
                original_exists=intent.original_assets_exists,
            ),
            _restore_path_set(
                "settings",
                self.settings_path,
                "file",
                token,
                included=intent.includes_settings,
                original_exists=intent.original_settings_exists,
            ),
        )

    def _validate_restore_layout(self, paths: tuple[_RestorePathSet, ...]) -> None:
        data_dir = self.data_dir.resolve(strict=False)
        canonical_paths = {path_set.canonical.resolve(strict=False) for path_set in paths}
        if len(canonical_paths) != len(paths):
            raise RestoreRecoveryError(
                "restore canonical paths overlap",
                code=RestoreRecoveryError.code,
            )
        if any(path_set.canonical.parent.resolve(strict=False) != data_dir for path_set in paths):
            raise RestoreRecoveryError(
                "restore canonical paths must be direct children of the data directory",
                code=RestoreRecoveryError.code,
            )
        derived_paths = {
            candidate
            for path_set in paths
            for candidate in (path_set.canonical, path_set.candidate, path_set.rollback)
        }
        if len(derived_paths) != len(paths) * 3:
            raise RestoreRecoveryError(
                "restore transaction paths overlap",
                code=RestoreRecoveryError.code,
            )

    def _recover_orphans_without_intent(self) -> None:
        rollbacks = self._matching_restore_artifacts("rollback")
        if rollbacks:
            raise RestoreRecoveryError(
                "restore rollback artifacts exist without a durable intent",
                code=RestoreRecoveryError.code,
                details={"artifacts": [str(path) for path, _kind in rollbacks]},
            )
        for path, expected_kind in self._matching_restore_artifacts("restore"):
            _remove_owned_path(path, expected_kind, "orphan restore candidate")
        self._remove_restore_intent_temporaries()

    def _remove_restore_intent_temporaries(self) -> None:
        prefix = f".{self.restore_intent_path.name}."
        suffix = ".part"
        for path in self.data_dir.glob(f"{prefix}*{suffix}"):
            token = path.name.removeprefix(prefix).removesuffix(suffix)
            if not _is_restore_token(token):
                raise RestoreRecoveryError(
                    "restore intent temporary file has an invalid transaction token",
                    code=RestoreRecoveryError.code,
                    details={"artifact": str(path)},
                )
            _remove_owned_path(path, "file", "restore intent temporary")

    def _matching_restore_artifacts(self, role: str) -> list[tuple[Path, str]]:
        matches: list[tuple[Path, str]] = []
        canonical = (
            (self.database.path, "file"),
            (self.assets_root, "directory"),
            (self.settings_path, "file"),
        )
        for path, kind in canonical:
            prefix = f".{path.name}.{role}-"
            for candidate in path.parent.glob(f"{prefix}*"):
                token = candidate.name.removeprefix(prefix)
                if not _is_restore_token(token):
                    raise RestoreRecoveryError(
                        "restore artifact has an invalid transaction token",
                        code=RestoreRecoveryError.code,
                        details={"artifact": str(candidate)},
                    )
                matches.append((candidate, kind))
        return matches

    def _asset_files(self) -> list[Path]:
        if not self.assets_root.exists():
            return []
        root = self.assets_root.resolve()
        return [
            path
            for path in sorted(root.rglob("*"))
            if path.is_file() and not path.is_symlink() and not path.name.endswith(".part")
        ]

    def _backup_files(self) -> list[Path]:
        self._assert_service_roots()
        if not self.backup_dir.exists():
            return []
        return [
            path
            for path in sorted(self.backup_dir.glob("*.zip"), reverse=True)
            if _is_regular_file(path)
        ]

    def _assert_service_roots(self) -> None:
        _assert_service_directory(
            self.managed_root,
            self._require_managed_root_identity(),
            "managed data directory",
        )
        _assert_service_directory(
            self.backup_dir,
            self._require_backup_dir_identity(),
            "backup directory",
        )
        _assert_service_directory(
            self.staging_root,
            self._require_staging_root_identity(),
            "restore staging directory",
        )

    def _require_managed_root_identity(self) -> tuple[int, int]:
        if self._managed_root_identity is None:
            raise InvalidArgumentError("backup service has not been initialized")
        return self._managed_root_identity

    def _require_backup_dir_identity(self) -> tuple[int, int]:
        if self._backup_dir_identity is None:
            raise InvalidArgumentError("backup service has not been initialized")
        return self._backup_dir_identity

    def _require_staging_root_identity(self) -> tuple[int, int]:
        if self._staging_root_identity is None:
            raise InvalidArgumentError("backup service has not been initialized")
        return self._staging_root_identity


def _write_backup_zip(
    destination: Path,
    snapshot: Path,
    asset_files: Sequence[Path],
    assets_root: Path,
    settings_payload: bytes,
    includes_assets: bool,
    created_at: str,
) -> BackupManifest:
    entries: list[BackupEntry] = []
    with zipfile.ZipFile(
        destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True
    ) as archive:
        entries.append(_write_zip_file(archive, snapshot, DATABASE_NAME, "database"))
        entries.append(_write_zip_bytes(archive, settings_payload, SETTINGS_NAME, "settings"))
        root = assets_root.resolve()
        for asset_path in asset_files:
            relative = asset_path.resolve().relative_to(root).as_posix()
            entries.append(_write_zip_file(archive, asset_path, f"assets/{relative}", "asset"))
        schema_version = _validate_sqlite_database(snapshot, max_supported=None)
        manifest = BackupManifest(
            backup_id=str(uuid.uuid4()),
            created_at=created_at,
            schema_version=schema_version,
            includes_assets=includes_assets,
            files=tuple(entries),
        )
        archive.writestr(
            MANIFEST_NAME,
            json.dumps(
                manifest.to_dict(),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
    return manifest


def _write_zip_file(
    archive: zipfile.ZipFile, source: Path, archive_name: str, kind: str
) -> BackupEntry:
    digest = hashlib.sha256()
    size = 0
    with (
        source.open("rb") as input_file,
        archive.open(archive_name, "w", force_zip64=True) as output,
    ):
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            output.write(chunk)
            digest.update(chunk)
            size += len(chunk)
    return BackupEntry(path=archive_name, byte_size=size, sha256=digest.hexdigest(), kind=kind)


def _write_zip_bytes(
    archive: zipfile.ZipFile,
    payload: bytes,
    archive_name: str,
    kind: str,
) -> BackupEntry:
    archive.writestr(archive_name, payload)
    return BackupEntry(
        path=archive_name,
        byte_size=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        kind=kind,
    )


def _extract_and_validate(
    archive_path: Path,
    staging: Path,
    max_schema_version: int,
    max_entries: int,
    max_uncompressed_bytes: int,
    max_compression_ratio: int,
    disk_reserve_bytes: int,
) -> BackupManifest:
    try:
        archive = zipfile.ZipFile(archive_path, "r", allowZip64=True)
    except (OSError, zipfile.BadZipFile) as exc:
        raise BackupValidationError("backup is not a readable ZIP archive") from exc

    with archive:
        all_infos = archive.infolist()
        if len(all_infos) > max_entries:
            raise BackupValidationError("backup contains too many files")
        # Validate directory records too: they are not extracted, but accepting an
        # unsafe or symlinked directory makes archive behavior platform-dependent.
        for info in all_infos:
            _validate_zip_member(info)
        infos = [info for info in all_infos if not info.is_dir()]
        names: set[str] = set()
        total_size = 0
        by_name: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            name = _validate_zip_member(info)
            if name in names:
                raise BackupValidationError("backup contains duplicate paths")
            names.add(name)
            by_name[name] = info
            total_size += info.file_size
            if total_size > max_uncompressed_bytes:
                raise BackupValidationError("backup expands beyond the permitted size")
            if info.file_size and info.compress_size == 0:
                raise BackupValidationError("backup contains an invalid compressed member")
            if (
                info.file_size > 1024 * 1024
                and info.file_size > info.compress_size * max_compression_ratio
            ):
                raise BackupValidationError("backup contains a suspicious compression ratio")

        disk_free = shutil.disk_usage(staging).free
        if total_size > max(0, disk_free - disk_reserve_bytes):
            raise BackupStorageError(
                required_bytes=total_size,
                free_bytes=disk_free,
                reserve_bytes=disk_reserve_bytes,
            )

        manifest_info = by_name.get(MANIFEST_NAME)
        if manifest_info is None or manifest_info.file_size > 5 * 1024 * 1024:
            raise BackupValidationError("backup manifest is missing or too large")
        try:
            manifest_data = json.loads(archive.read(manifest_info).decode("utf-8"))
        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
            OSError,
            RuntimeError,
            zipfile.BadZipFile,
        ) as exc:
            raise BackupValidationError("backup manifest is not valid JSON") from exc
        manifest = _parse_manifest(manifest_data)
        expected = {entry.path for entry in manifest.files}
        actual = names - {MANIFEST_NAME}
        if expected != actual:
            raise BackupValidationError("backup files do not match the manifest")
        if DATABASE_NAME not in expected:
            raise BackupValidationError("backup does not contain a database snapshot")
        database_entry = next(entry for entry in manifest.files if entry.path == DATABASE_NAME)
        if database_entry.kind != "database":
            raise BackupValidationError("backup database entry has an invalid kind")
        settings_entry = next(
            (entry for entry in manifest.files if entry.path == SETTINGS_NAME),
            None,
        )
        if settings_entry is not None and settings_entry.kind != "settings":
            raise BackupValidationError("backup settings entry has an invalid kind")
        if any(
            entry.path.startswith("assets/") and entry.kind != "asset" for entry in manifest.files
        ):
            raise BackupValidationError("backup asset entry has an invalid kind")
        if any(
            name not in {DATABASE_NAME, SETTINGS_NAME} and not name.startswith("assets/")
            for name in expected
        ):
            raise BackupValidationError("backup contains an unsupported payload path")
        if not manifest.includes_assets and any(name.startswith("assets/") for name in expected):
            raise BackupValidationError("asset payloads conflict with the manifest")

        entry_by_path = {entry.path: entry for entry in manifest.files}
        for name in sorted(actual):
            destination = staging.joinpath(*PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            try:
                with archive.open(by_name[name], "r") as source, destination.open("xb") as output:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        size += len(chunk)
                        if size > entry_by_path[name].byte_size:
                            raise BackupValidationError("backup member exceeds its declared size")
                        digest.update(chunk)
                        output.write(chunk)
            except (OSError, EOFError, RuntimeError, zipfile.BadZipFile) as exc:
                raise BackupValidationError("backup member could not be extracted") from exc
            entry = entry_by_path[name]
            if size != entry.byte_size or digest.hexdigest() != entry.sha256:
                raise BackupValidationError("backup member checksum does not match the manifest")

    schema_version = _validate_sqlite_database(staging / DATABASE_NAME, max_schema_version)
    if manifest.schema_version != schema_version:
        raise BackupValidationError("manifest and database schema versions do not match")
    if (staging / SETTINGS_NAME).is_file():
        _validate_local_settings(staging)
    _validate_asset_catalog(staging, manifest)
    return manifest


def _parse_manifest(value: object) -> BackupManifest:
    if not isinstance(value, dict) or value.get("format") != BACKUP_FORMAT:
        raise BackupValidationError("backup manifest has an unknown format")
    version = value.get("version")
    if not isinstance(version, int):
        raise BackupValidationError("backup manifest version is invalid")
    if version != BACKUP_FORMAT_VERSION:
        raise UnsupportedBackupVersionError(version)
    try:
        backup_id = str(uuid.UUID(str(value["backup_id"])))
        created_at = str(value["created_at"])
        raw_schema_version = value["schema_version"]
        if isinstance(raw_schema_version, bool):
            raise ValueError
        schema_version = int(raw_schema_version)
        includes_assets = value["includes_assets"]
        raw_files = value["files"]
    except (KeyError, TypeError, ValueError) as exc:
        raise BackupValidationError("backup manifest is incomplete") from exc
    if (
        not backup_id
        or not created_at
        or schema_version < 0
        or not isinstance(includes_assets, bool)
    ):
        raise BackupValidationError("backup manifest fields are invalid")
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BackupValidationError("backup creation timestamp is invalid") from exc
    if created.tzinfo is None or created.utcoffset() is None:
        raise BackupValidationError("backup creation timestamp must include a timezone")
    if not isinstance(raw_files, list):
        raise BackupValidationError("backup manifest file list is invalid")

    files: list[BackupEntry] = []
    seen: set[str] = set()
    for raw in raw_files:
        if not isinstance(raw, dict):
            raise BackupValidationError("backup manifest entry is invalid")
        try:
            path = _validate_manifest_path(str(raw["path"]))
            raw_byte_size = raw["byte_size"]
            if isinstance(raw_byte_size, bool):
                raise ValueError
            byte_size = int(raw_byte_size)
            digest = str(raw["sha256"])
            kind = str(raw["kind"])
        except (KeyError, TypeError, ValueError) as exc:
            raise BackupValidationError("backup manifest entry is incomplete") from exc
        if path in seen or byte_size < 0 or not _is_sha256(digest) or not kind:
            raise BackupValidationError("backup manifest entry fields are invalid")
        seen.add(path)
        files.append(BackupEntry(path=path, byte_size=byte_size, sha256=digest, kind=kind))
    return BackupManifest(
        backup_id=backup_id,
        created_at=created_at,
        schema_version=schema_version,
        includes_assets=includes_assets,
        files=tuple(files),
    )


def _validate_zip_member(info: zipfile.ZipInfo) -> str:
    mode = (info.external_attr >> 16) & 0o170000
    if mode == stat.S_IFLNK:
        raise BackupValidationError("backup contains a symbolic link")
    if info.filename == MANIFEST_NAME:
        return MANIFEST_NAME
    return _validate_manifest_path(info.filename)


def _validate_manifest_path(value: str) -> str:
    if not value or "\\" in value or "\x00" in value:
        raise BackupValidationError("backup contains an unsafe path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(":" in part or part.endswith((".", " ")) for part in path.parts)
        or value == MANIFEST_NAME
    ):
        raise BackupValidationError("backup contains an unsafe path")
    return path.as_posix()


def _validate_sqlite_database(path: Path, max_supported: int | None) -> int:
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            result = [str(row[0]) for row in connection.execute("PRAGMA quick_check").fetchall()]
            if result != ["ok"]:
                raise BackupValidationError("backup database failed SQLite quick_check")
            user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            ).fetchone()
            applied: dict[int, tuple[str, str]] = {}
            if table:
                applied = {
                    int(row[0]): (str(row[1]), str(row[2]))
                    for row in connection.execute(
                        "SELECT version, name, checksum FROM schema_migrations"
                    ).fetchall()
                }
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise BackupValidationError("backup database is not a valid SQLite database") from exc
    schema_version = max(max(applied, default=0), user_version)
    if max_supported is not None and schema_version > max_supported:
        raise BackupValidationError("backup database schema is newer than this application")
    definitions = {item.version: item for item in DEFAULT_MIGRATIONS}
    if applied and set(applied) != set(range(1, max(applied) + 1)):
        raise BackupValidationError("backup database migration history contains a gap")
    for version, (name, checksum) in applied.items():
        migration = definitions.get(version)
        if migration is None or migration.name != name or migration.checksum != checksum:
            raise BackupValidationError("backup database migration checksums are invalid")
    if schema_version:
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                validate_default_schema_connection(connection, schema_version)
            finally:
                connection.close()
        except (sqlite3.Error, DatabaseIntegrityError) as exc:
            raise BackupValidationError("backup database schema is invalid") from exc
    return schema_version


def _validate_asset_catalog(staging: Path, manifest: BackupManifest) -> None:
    if not manifest.includes_assets:
        return
    entries = {entry.path: entry for entry in manifest.files}
    connection = sqlite3.connect(f"file:{staging / DATABASE_NAME}?mode=ro", uri=True)
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets'"
        ).fetchone()
        if not table:
            return
        rows = connection.execute(
            "SELECT relative_path, byte_size, sha256, status FROM assets WHERE status != 'missing'"
        ).fetchall()
    finally:
        connection.close()
    for relative_path, byte_size, digest, _status in rows:
        safe_path = _validate_manifest_path(f"assets/{relative_path}")
        entry = entries.get(safe_path)
        if entry is None or entry.byte_size != int(byte_size) or entry.sha256 != str(digest):
            raise BackupValidationError("backup assets do not match the database catalog")


def _validate_local_settings(staging: Path) -> None:
    path = staging / SETTINGS_NAME
    try:
        if path.stat().st_size > _MAX_SETTINGS_BYTES:
            raise BackupValidationError("backup settings exceed the permitted size")
        value = json.loads(path.read_text(encoding="utf-8"))
    except BackupValidationError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackupValidationError("backup settings are not valid JSON") from exc
    if not isinstance(value, dict):
        raise BackupValidationError("backup settings must be a JSON object")
    # The same parser used at normal startup is the source of truth. Requiring the
    # archive payload to equal its sanitized representation prevents secrets or
    # future unknown fields from hitching a ride in an otherwise valid backup.
    if value != read_local_settings(staging):
        raise BackupValidationError("backup settings contain unsupported or unsafe fields")


def _sqlite_backup(source: Path, destination: Path) -> None:
    with (
        closing(sqlite3.connect(str(source))) as source_db,
        closing(sqlite3.connect(str(destination))) as target_db,
    ):
        source_db.backup(target_db)


def _restore_path_set(
    name: str,
    canonical: Path,
    kind: str,
    token: str,
    *,
    included: bool,
    original_exists: bool,
) -> _RestorePathSet:
    if not _is_restore_token(token):
        raise RestoreRecoveryError(
            "restore intent contains an invalid transaction token",
            code=RestoreRecoveryError.code,
        )
    canonical = Path(canonical)
    return _RestorePathSet(
        name=name,
        canonical=canonical,
        candidate=canonical.with_name(f".{canonical.name}.restore-{token}"),
        rollback=canonical.with_name(f".{canonical.name}.rollback-{token}"),
        kind=kind,
        included=included,
        original_exists=original_exists,
    )


def _recover_prepared_path(path_set: _RestorePathSet) -> None:
    canonical_kind = _path_kind(path_set.canonical)
    candidate_kind = _path_kind(path_set.candidate)
    rollback_kind = _path_kind(path_set.rollback)
    for path, actual_kind in (
        (path_set.canonical, canonical_kind),
        (path_set.candidate, candidate_kind),
        (path_set.rollback, rollback_kind),
    ):
        if actual_kind not in {"absent", path_set.kind}:
            raise RestoreRecoveryError(
                f"restore path has an unexpected type: {path}",
                code=RestoreRecoveryError.code,
                details={"path": str(path), "type": actual_kind},
            )

    state = (
        canonical_kind != "absent",
        candidate_kind != "absent",
        rollback_kind != "absent",
    )
    if path_set.original_exists:
        if state == (True, False, True):
            # New canonical -> candidate. A crash after this rename leaves the
            # next idempotent recovery in the (False, True, True) state.
            _durable_replace(path_set.canonical, path_set.candidate)
            _fsync_directory(path_set.canonical.parent)
            state = (False, True, True)
        if state == (False, True, True):
            _durable_replace(path_set.rollback, path_set.canonical)
            _fsync_directory(path_set.canonical.parent)
            state = (True, True, False)
        if state == (True, True, False):
            _remove_owned_path(path_set.candidate, path_set.kind, path_set.name)
            state = (True, False, False)
        if state != (True, False, False):
            raise RestoreRecoveryError(
                f"prepared restore state for {path_set.name} is ambiguous",
                code=RestoreRecoveryError.code,
                details={"state": list(state)},
            )
        return

    if rollback_kind != "absent":
        raise RestoreRecoveryError(
            f"prepared restore unexpectedly has an old {path_set.name}",
            code=RestoreRecoveryError.code,
            details={"state": list(state)},
        )
    if state == (True, False, False):
        _durable_replace(path_set.canonical, path_set.candidate)
        _fsync_directory(path_set.canonical.parent)
        state = (False, True, False)
    if state == (False, True, False):
        _remove_owned_path(path_set.candidate, path_set.kind, path_set.name)
        state = (False, False, False)
    if state != (False, False, False):
        raise RestoreRecoveryError(
            f"prepared restore state for {path_set.name} is ambiguous",
            code=RestoreRecoveryError.code,
            details={"state": list(state)},
        )


def _require_transaction_paths_absent(path_set: _RestorePathSet) -> None:
    if any(_path_kind(path) != "absent" for path in (path_set.candidate, path_set.rollback)):
        raise RestoreRecoveryError(
            f"restore intent excludes {path_set.name}, but transaction artifacts exist",
            code=RestoreRecoveryError.code,
        )


def _require_kind(path: Path, expected: str, name: str) -> None:
    actual = _path_kind(path)
    if actual != expected:
        raise RestoreRecoveryError(
            f"restore {name} path is {actual}, expected {expected}",
            code=RestoreRecoveryError.code,
            details={"path": str(path), "type": actual},
        )


def _remove_owned_path(path: Path, expected_kind: str, name: str) -> None:
    actual_kind = _path_kind(path)
    if actual_kind == "absent":
        return
    if actual_kind != expected_kind:
        raise RestoreRecoveryError(
            f"refusing to remove unexpected {name} path type",
            code=RestoreRecoveryError.code,
            details={"path": str(path), "type": actual_kind},
        )
    if expected_kind == "directory":
        shutil.rmtree(path)
    else:
        path.unlink()
    _fsync_directory(path.parent)


def _path_kind(path: Path) -> str:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return "absent"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def _is_restore_token(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value)


def _write_restore_intent(path: Path, intent: RestoreIntent) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        intent.to_dict(),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    temporary = path.with_name(f".{path.name}.{intent.token}.part")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        _durable_replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_restore_intent(path: Path) -> RestoreIntent:
    try:
        if path.stat().st_size > _RESTORE_INTENT_MAX_BYTES:
            raise RestoreRecoveryError(
                "restore intent exceeds its maximum size",
                code=RestoreRecoveryError.code,
            )
        payload = path.read_text(encoding="utf-8")
        value = json.loads(payload, object_pairs_hook=_reject_duplicate_json_keys)
    except RestoreRecoveryError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RestoreRecoveryError(
            "restore intent is unreadable",
            code=RestoreRecoveryError.code,
        ) from exc
    if not isinstance(value, dict) or set(value) != {
        "format",
        "version",
        "token",
        "phase",
        "includes_assets",
        "includes_settings",
        "originals",
    }:
        raise RestoreRecoveryError(
            "restore intent has an invalid shape",
            code=RestoreRecoveryError.code,
        )
    originals = value["originals"]
    if not isinstance(originals, dict) or set(originals) != {
        "database",
        "assets",
        "settings",
    }:
        raise RestoreRecoveryError(
            "restore intent has invalid original-path metadata",
            code=RestoreRecoveryError.code,
        )
    token = value["token"]
    phase = value["phase"]
    flags = (
        value["includes_assets"],
        value["includes_settings"],
        originals["database"],
        originals["assets"],
        originals["settings"],
    )
    if (
        value["format"] != _RESTORE_INTENT_FORMAT
        or type(value["version"]) is not int
        or value["version"] != _RESTORE_INTENT_VERSION
        or not isinstance(token, str)
        or not _is_restore_token(token)
        or phase not in {"prepared", "committed"}
        or any(not isinstance(flag, bool) for flag in flags)
    ):
        raise RestoreRecoveryError(
            "restore intent contains invalid values",
            code=RestoreRecoveryError.code,
        )
    return RestoreIntent(
        token=token,
        phase=phase,
        includes_assets=flags[0],
        includes_settings=flags[1],
        original_database_exists=flags[2],
        original_assets_exists=flags[3],
        original_settings_exists=flags[4],
    )


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RestoreRecoveryError(
                "restore intent contains duplicate JSON keys",
                code=RestoreRecoveryError.code,
            )
        result[key] = value
    return result


def _remove_restore_intent(path: Path, token: str) -> None:
    _require_kind(path, "file", "intent")
    path.unlink()
    temporary = path.with_name(f".{path.name}.{token}.part")
    if _path_kind(temporary) == "file":
        temporary.unlink()
    elif _path_kind(temporary) != "absent":
        raise RestoreRecoveryError(
            "restore intent temporary path has an unexpected type",
            code=RestoreRecoveryError.code,
        )
    _fsync_directory(path.parent)


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _prepare_service_directory(path: Path, label: str) -> tuple[int, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
        metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise InvalidArgumentError(f"{label} must be a regular directory")
    return metadata.st_dev, metadata.st_ino


def _assert_service_directory(
    path: Path,
    identity: tuple[int, int],
    label: str,
) -> None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as exc:
        raise InvalidArgumentError(f"{label} is missing") from exc
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or (metadata.st_dev, metadata.st_ino) != identity
    ):
        raise InvalidArgumentError(f"{label} changed or is not a regular directory")


def _directory_identity(path: Path) -> tuple[int, int]:
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise InvalidArgumentError("service path is not a regular directory")
    return metadata.st_dev, metadata.st_ino


def _remove_service_child(
    root: Path,
    root_identity: tuple[int, int],
    child: Path,
    child_identity: tuple[int, int],
    directory: bool,
) -> None:
    try:
        _assert_service_directory(root, root_identity, "service directory")
    except InvalidArgumentError:
        return
    if child.parent != root:
        return
    try:
        metadata = os.lstat(child)
    except FileNotFoundError:
        return
    expected = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not expected or stat.S_ISLNK(metadata.st_mode):
        return
    if (metadata.st_dev, metadata.st_ino) != child_identity:
        return
    if directory:
        shutil.rmtree(child)
    else:
        child.unlink()
    _fsync_directory(root)


def _remove_service_child_if_present(
    root: Path,
    root_identity: tuple[int, int],
    child: Path,
    directory: bool,
) -> None:
    try:
        metadata = os.lstat(child)
    except FileNotFoundError:
        return
    _remove_service_child(
        root,
        root_identity,
        child,
        (metadata.st_dev, metadata.st_ino),
        directory,
    )


def _regular_file_bytes(root: Path) -> int:
    total = 0
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            entries = list(os.scandir(directory))
        except FileNotFoundError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
            except FileNotFoundError:
                continue
    return total


def _is_regular_file(path: Path) -> bool:
    return not path.is_symlink() and path.is_file()


def _encode_local_settings(value: dict[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _require_disk_capacity(path: Path, required_bytes: int, reserve_bytes: int) -> None:
    free_bytes = shutil.disk_usage(path).free
    if required_bytes > max(0, free_bytes - reserve_bytes):
        raise BackupStorageError(
            required_bytes=required_bytes,
            free_bytes=free_bytes,
            reserve_bytes=reserve_bytes,
        )


def _validate_backup_reference(value: str) -> str:
    if not isinstance(value, str):
        raise InvalidArgumentError(
            "backup reference must be a string",
            code="invalid_backup_reference",
        )
    normalized = value.strip()
    if normalized != value or not normalized or len(normalized) > 200:
        raise InvalidArgumentError(
            "backup reference is invalid",
            code="invalid_backup_reference",
        )
    try:
        parsed_id = str(uuid.UUID(normalized))
    except ValueError:
        parsed_id = ""
    if parsed_id == normalized.lower():
        return parsed_id
    if (
        not normalized.endswith(".zip")
        or normalized.startswith(".")
        or any(
            character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
            for character in normalized
        )
        or Path(normalized).name != normalized
    ):
        raise InvalidArgumentError(
            "backup reference is invalid",
            code="invalid_backup_reference",
        )
    return normalized


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _durable_replace(source: Path, destination: Path) -> None:
    """Atomically rename with durable ordering on supported release platforms.

    POSIX callers fsync the containing directory immediately after this helper.
    Windows cannot portably fsync a directory handle, so MoveFileExW's
    WRITE_THROUGH contract is required for the intent/canonical ordering. Failure
    is surfaced rather than silently weakening restore durability.
    """

    if os.name != "nt":
        os.replace(source, destination)
        return

    win_dll = getattr(ctypes, "WinDLL", None)
    get_last_error = getattr(ctypes, "get_last_error", None)
    if win_dll is None or get_last_error is None:
        raise OSError("durable Windows rename support is unavailable")
    kernel32: Any = win_dll("kernel32", use_last_error=True)
    move_file = kernel32.MoveFileExW
    move_file.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    move_file.restype = ctypes.c_int
    movefile_replace_existing = 0x00000001
    movefile_write_through = 0x00000008
    succeeded = move_file(
        str(Path(source).absolute()),
        str(Path(destination).absolute()),
        movefile_replace_existing | movefile_write_through,
    )
    if not succeeded:
        error = int(get_last_error())
        raise OSError(
            error,
            f"MoveFileExW durable rename failed with Windows error {error}",
            str(source),
            str(destination),
        )


def _fsync_file(path: Path) -> None:
    with path.open("rb") as handle:
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_tree(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            _fsync_file(path)
    directories = [path for path in root.rglob("*") if path.is_dir()]
    for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        _fsync_directory(directory)
    _fsync_directory(root)
