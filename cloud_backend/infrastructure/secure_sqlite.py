"""Fail-closed filesystem primitives for single-host SQLite adapters.

SQLite's normal path API creates missing files and follows symbolic links.  Those
defaults are convenient for scripts but are unsafe for a long-running service
whose data directory can be modified by another local process.  This module
separates explicit creation from opening and pins both the database file and its
containing directory for the lifetime of a repository instance.
"""

from __future__ import annotations

import asyncio
import os
import stat
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import aiosqlite


class StorageIntegrityError(RuntimeError):
    """A storage path or SQLite database cannot be trusted."""


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int


@dataclass(frozen=True)
class SQLiteLocationIdentity:
    directory: FileIdentity
    database: FileIdentity


def database_uri(path: Path, *, mode: str = "rw") -> str:
    """Return an absolute SQLite URI whose mode never creates a database."""

    return f"{Path(path).absolute().as_uri()}?mode={mode}"


def ensure_secure_directory(path: Path, *, create: bool) -> FileIdentity:
    """Create or validate one designated storage directory without accepting links."""

    directory = Path(path)
    try:
        metadata = os.lstat(directory)
    except FileNotFoundError:
        if not create:
            raise StorageIntegrityError("storage directory is missing") from None
        # mkdir may create ancestors, but the designated directory itself is
        # revalidated with lstat before it is trusted.
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        metadata = os.lstat(directory)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise StorageIntegrityError("storage directory is not a real directory")
    return _identity(metadata)


def assert_directory_identity(path: Path, expected: FileIdentity) -> None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as exc:
        raise StorageIntegrityError("storage directory is missing") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise StorageIntegrityError("storage directory is not a real directory")
    if _identity(metadata) != expected:
        raise StorageIntegrityError("storage directory changed after initialization")


class SecureSQLiteFile:
    """Pin a regular SQLite file and open it only with ``mode=rw``.

    A no-follow descriptor is kept open while SQLite resolves the pathname.  We
    compare its fstat identity with lstat both before and after SQLite opens the
    database, which closes the common replace/symlink race and makes later root
    replacement fail closed.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._identity: SQLiteLocationIdentity | None = None

    @property
    def initialized(self) -> bool:
        return self._identity is not None

    async def prepare(self) -> bool:
        """Explicitly create a missing database and pin its location.

        Returns ``True`` when a non-empty database existed before this call.
        """

        existed, identity = await asyncio.to_thread(_prepare_sqlite_file, self.path)
        if self._identity is not None and self._identity != identity:
            raise StorageIntegrityError("SQLite database changed after initialization")
        self._identity = identity
        return existed

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[aiosqlite.Connection]:
        identity = self._identity
        if identity is None:
            raise StorageIntegrityError("SQLite database path has not been prepared")
        descriptor = await asyncio.to_thread(_open_guard, self.path, identity)
        connection: aiosqlite.Connection | None = None
        try:
            connection = await aiosqlite.connect(database_uri(self.path), uri=True)
            await asyncio.to_thread(_assert_location, self.path, identity, descriptor)
            yield connection
            await asyncio.to_thread(_assert_location, self.path, identity, descriptor)
        finally:
            if connection is not None:
                await connection.close()
            os.close(descriptor)


async def quick_check(connection: aiosqlite.Connection) -> None:
    """Reject databases that SQLite cannot verify as internally consistent."""

    try:
        cursor = await connection.execute("PRAGMA quick_check")
        rows = await cursor.fetchall()
        await cursor.close()
    except aiosqlite.DatabaseError as exc:
        raise StorageIntegrityError("SQLite quick_check could not read the database") from exc
    results = [str(row[0]) for row in rows]
    if results != ["ok"]:
        raise StorageIntegrityError("SQLite quick_check failed: " + "; ".join(results))


async def check_component_version(
    connection: aiosqlite.Connection,
    *,
    component: str,
    supported: int,
) -> None:
    """Reject a component schema created by a newer backend before mutation."""

    cursor = await connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' "
        "AND name = 'cloud_backend_schema_versions'"
    )
    exists = await cursor.fetchone()
    await cursor.close()
    if exists is None:
        return
    try:
        cursor = await connection.execute(
            "SELECT version FROM cloud_backend_schema_versions WHERE component = ?",
            (component,),
        )
        row = await cursor.fetchone()
        await cursor.close()
    except aiosqlite.DatabaseError as exc:
        raise StorageIntegrityError("cloud backend schema metadata is invalid") from exc
    if row is None:
        return
    try:
        version = int(row[0])
    except (TypeError, ValueError) as exc:
        raise StorageIntegrityError("cloud backend schema version is invalid") from exc
    if version < 1 or version > supported:
        raise StorageIntegrityError(
            f"{component} schema version {version} is not supported (maximum {supported})"
        )


async def record_component_version(
    connection: aiosqlite.Connection,
    *,
    component: str,
    version: int,
) -> None:
    await connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cloud_backend_schema_versions (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL CHECK(version > 0)
        ) WITHOUT ROWID
        """
    )
    await connection.execute(
        """
        INSERT INTO cloud_backend_schema_versions(component, version)
        VALUES (?, ?)
        ON CONFLICT(component) DO UPDATE SET version = excluded.version
        """,
        (component, version),
    )


async def require_table_columns(
    connection: aiosqlite.Connection,
    table: str,
    expected: Iterable[str],
    *,
    exact: bool = True,
) -> None:
    """Validate table shape after a migration and before committing it."""

    cursor = await connection.execute(f"PRAGMA table_info('{table}')")
    rows = await cursor.fetchall()
    await cursor.close()
    actual = tuple(str(row[1]) for row in rows)
    required = tuple(expected)
    valid = set(actual) == set(required) if exact else set(required).issubset(actual)
    if not valid:
        raise StorageIntegrityError(f"SQLite table schema mismatch: {table}")


def _prepare_sqlite_file(path: Path) -> tuple[bool, SQLiteLocationIdentity]:
    directory_identity = ensure_secure_directory(path.parent, create=True)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_BINARY", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            fchmod = getattr(os, "fchmod", None)
            if fchmod is not None:
                fchmod(descriptor, 0o600)
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):  # pragma: no cover - O_EXCL regular file
                raise StorageIntegrityError("SQLite database path is not a regular file")
        finally:
            os.close(descriptor)
        existed = False
    else:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise StorageIntegrityError("SQLite database path is not a regular file")
        existed = metadata.st_size > 0
    identity = SQLiteLocationIdentity(directory_identity, _identity(metadata))
    descriptor = _open_guard(path, identity)
    os.close(descriptor)
    return existed, identity


def _open_guard(path: Path, expected: SQLiteLocationIdentity) -> int:
    assert_directory_identity(path.parent, expected.directory)
    _assert_auxiliary_paths(path)
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(path, flags)
    except (FileNotFoundError, OSError) as exc:
        raise StorageIntegrityError("SQLite database file could not be opened safely") from exc
    try:
        _assert_location(path, expected, descriptor)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _assert_location(path: Path, expected: SQLiteLocationIdentity, descriptor: int) -> None:
    assert_directory_identity(path.parent, expected.directory)
    try:
        path_metadata = os.lstat(path)
        descriptor_metadata = os.fstat(descriptor)
    except FileNotFoundError as exc:
        raise StorageIntegrityError("SQLite database file is missing") from exc
    if (
        stat.S_ISLNK(path_metadata.st_mode)
        or not stat.S_ISREG(path_metadata.st_mode)
        or not stat.S_ISREG(descriptor_metadata.st_mode)
    ):
        raise StorageIntegrityError("SQLite database path is not a regular file")
    if (
        _identity(path_metadata) != expected.database
        or _identity(descriptor_metadata) != expected.database
    ):
        raise StorageIntegrityError("SQLite database changed after initialization")
    _assert_auxiliary_paths(path)


def _assert_auxiliary_paths(path: Path) -> None:
    for suffix in ("-journal", "-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        try:
            metadata = os.lstat(candidate)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise StorageIntegrityError("SQLite auxiliary path is not a regular file")


def _identity(metadata: os.stat_result) -> FileIdentity:
    return FileIdentity(metadata.st_dev, metadata.st_ino)
