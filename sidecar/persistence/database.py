from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite

from backend_core.errors import RuntimeNotReadyError

from .migrations import (
    DEFAULT_MIGRATIONS,
    DatabaseIntegrityError,
    Migration,
    MigrationRunner,
    configure_live_connection,
    validate_default_schema,
)


class DatabaseNotReadyError(RuntimeNotReadyError):
    code = "database_not_ready"
    retryable = True

    def __init__(self, message: str = "database has not completed initialization") -> None:
        super().__init__(message, code=self.code, details={"retryable": True})


class Database:
    """Small aiosqlite boundary; callers own SQL and no ORM is introduced."""

    def __init__(
        self,
        path: Path,
        *,
        migrations: Sequence[Migration] = DEFAULT_MIGRATIONS,
        migration_backup_dir: Path | None = None,
        migration_backup_keep: int = 3,
        busy_timeout_ms: int = 10_000,
    ) -> None:
        self.path = Path(path)
        self.busy_timeout_ms = busy_timeout_ms
        self.migrations = MigrationRunner(
            self.path,
            migrations=migrations,
            backup_dir=migration_backup_dir,
            backup_keep=migration_backup_keep,
            busy_timeout_ms=busy_timeout_ms,
        )
        self._ready = False
        self._initialize_lock = asyncio.Lock()

    @property
    def ready(self) -> bool:
        return self._ready

    async def initialize(self) -> list[int]:
        async with self._initialize_lock:
            if self._ready:
                return []
            self._ready = False
            applied = await self.migrations.migrate()
            self._ready = True
            return applied

    def mark_not_ready(self) -> None:
        """Used by restore before replacing the on-disk database."""
        self._ready = False

    async def checkpoint(self) -> None:
        if not self._ready or not self.path.exists():
            return
        async with self.connect() as connection:
            cursor = await connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            await cursor.close()

    async def close(self) -> None:
        await self.checkpoint()
        self._ready = False

    stop = close

    async def schema_version(self) -> int:
        return await self.migrations.current_version()

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[aiosqlite.Connection]:
        if not self._ready:
            raise DatabaseNotReadyError()
        if self.path.is_symlink() or not self.path.is_file():
            self._ready = False
            raise DatabaseNotReadyError("database file is missing or is not a regular file")
        uri = self.path.absolute().as_uri() + "?mode=rw"
        try:
            connection = await aiosqlite.connect(uri, uri=True)
        except aiosqlite.Error as exc:
            self._ready = False
            raise DatabaseNotReadyError(
                "database file could not be opened without creating it"
            ) from exc
        connection.row_factory = aiosqlite.Row
        try:
            await configure_live_connection(
                connection,
                busy_timeout_ms=self.busy_timeout_ms,
                enable_wal=False,
            )
            yield connection
        finally:
            await connection.close()

    async def check(self) -> bool:
        """Probe the live file, WAL connection invariants, schema, and integrity."""

        if not self._ready or self.path.is_symlink() or not self.path.is_file():
            self._ready = False
            return False
        try:
            async with self.connect() as connection:
                cursor = await connection.execute("PRAGMA quick_check")
                rows = await cursor.fetchall()
                await cursor.close()
                version_cursor = await connection.execute("PRAGMA user_version")
                version_row = await version_cursor.fetchone()
                await version_cursor.close()
            if [str(row[0]) for row in rows] != ["ok"] or version_row is None:
                self._ready = False
                return False
            if int(str(version_row[0])) != self.migrations.latest_version:
                self._ready = False
                return False
            await asyncio.to_thread(
                validate_default_schema,
                self.path,
                self.migrations.latest_version,
            )
        except (aiosqlite.Error, DatabaseIntegrityError, DatabaseNotReadyError):
            self._ready = False
            return False
        return True

    @asynccontextmanager
    async def transaction(self, *, immediate: bool = True) -> AsyncIterator[aiosqlite.Connection]:
        async with self.connect() as connection:
            await connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            try:
                yield connection
                await connection.commit()
            except BaseException:
                await connection.rollback()
                raise
