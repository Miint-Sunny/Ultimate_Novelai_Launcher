"""Atomic quota reservations over the legacy Bot ``user_quotas`` table."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Collection
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from ..errors import IdempotencyConflictError, QuotaExceededError, ResourceNotFoundError
from .secure_sqlite import (
    SecureSQLiteFile,
    StorageIntegrityError,
    check_component_version,
    quick_check,
    record_component_version,
    require_table_columns,
)

_SCHEMA_COMPONENT = "workshop_quota"
_SCHEMA_VERSION = 1
_RESERVATION_COLUMNS = (
    "job_id",
    "user_id",
    "units",
    "daily_units",
    "extra_units",
    "quota_date",
    "result_filename",
    "state",
    "created_at",
    "updated_at",
)
_USER_QUOTA_COLUMNS = (
    "user_id",
    "daily_limit",
    "daily_balance",
    "extra_balance",
    "last_refresh_date",
)


@dataclass(frozen=True)
class WorkshopQuotaBalance:
    daily_limit: int
    daily_balance: int
    extra_balance: int

    @property
    def total_available(self) -> int:
        return self.daily_balance + self.extra_balance


class SQLiteWorkshopQuotaRepository:
    """Reserve before provider I/O and settle only after an atomic result write."""

    def __init__(self, path: Path, *, busy_timeout_ms: int = 10_000) -> None:
        self.path = Path(path)
        self._database = SecureSQLiteFile(self.path)
        self.busy_timeout_ms = busy_timeout_ms
        self._ready = False
        self._initialize_lock = asyncio.Lock()

    @property
    def ready(self) -> bool:
        return self._ready

    async def initialize(self) -> None:
        async with self._initialize_lock:
            if self._ready:
                return
            await self._database.prepare()
            async with self._database.connect() as connection:
                await connection.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms}")
                await quick_check(connection)
                await check_component_version(
                    connection,
                    component=_SCHEMA_COMPONENT,
                    supported=_SCHEMA_VERSION,
                )
                cursor = await connection.execute("PRAGMA journal_mode = WAL")
                row = await cursor.fetchone()
                await cursor.close()
                if row is None or str(row[0]).lower() != "wal":
                    raise StorageIntegrityError("workshop quota database could not enable WAL")
                await connection.execute("PRAGMA synchronous = FULL")
                await connection.execute("PRAGMA foreign_keys = ON")
                await connection.execute("BEGIN IMMEDIATE")
                try:
                    await connection.execute(
                        """
                        CREATE TABLE IF NOT EXISTS workshop_quota_reservations (
                            job_id TEXT PRIMARY KEY,
                            user_id TEXT NOT NULL,
                            units INTEGER NOT NULL CHECK(units > 0),
                            daily_units INTEGER NOT NULL CHECK(daily_units >= 0),
                            extra_units INTEGER NOT NULL CHECK(extra_units >= 0),
                            quota_date TEXT NOT NULL,
                            result_filename TEXT NOT NULL,
                            state TEXT NOT NULL CHECK(
                                state IN ('reserved', 'captured', 'refunded')
                            ),
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL
                        )
                        """
                    )
                    await require_table_columns(
                        connection,
                        "workshop_quota_reservations",
                        _RESERVATION_COLUMNS,
                    )
                    # ``user_quotas`` belongs to the existing Bot database.  A
                    # brand-new file may be initialized before the Bot creates
                    # it, but an existing table must contain every field this
                    # adapter mutates.
                    cursor = await connection.execute(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_quotas'"
                    )
                    user_quota_exists = await cursor.fetchone()
                    await cursor.close()
                    if user_quota_exists is not None:
                        await require_table_columns(
                            connection,
                            "user_quotas",
                            _USER_QUOTA_COLUMNS,
                            exact=False,
                        )
                    await record_component_version(
                        connection,
                        component=_SCHEMA_COMPONENT,
                        version=_SCHEMA_VERSION,
                    )
                    await quick_check(connection)
                    await connection.commit()
                except BaseException:
                    await connection.rollback()
                    raise
            self._ready = True

    async def balance(self, user_id: int | str, *, quota_date: str) -> WorkshopQuotaBalance:
        async with self._transaction() as connection:
            return await self._refresh_and_get(connection, str(user_id), quota_date)

    async def reserve(
        self,
        user_id: int | str,
        *,
        job_id: str,
        units: int,
        quota_date: str,
        result_filename: str,
    ) -> bool:
        if units <= 0:
            raise ValueError("units must be positive")
        now = datetime.now(timezone.utc).isoformat()
        owner = str(user_id)
        async with self._transaction() as connection:
            existing = await _fetchone(
                connection,
                """
                SELECT user_id, units, result_filename
                FROM workshop_quota_reservations WHERE job_id = ?
                """,
                (job_id,),
            )
            if existing is not None:
                if (
                    str(existing["user_id"]) != owner
                    or int(existing["units"]) != units
                    or str(existing["result_filename"]) != result_filename
                ):
                    raise IdempotencyConflictError("workshop job id was reused")
                return False
            balance = await self._refresh_and_get(connection, owner, quota_date)
            if balance.total_available < units:
                raise QuotaExceededError(
                    "quota is insufficient",
                    details={
                        "available_units": balance.total_available,
                        "required_units": units,
                    },
                )
            daily_units = min(balance.daily_balance, units)
            extra_units = units - daily_units
            cursor = await connection.execute(
                """
                UPDATE user_quotas
                SET daily_balance = daily_balance - ?, extra_balance = extra_balance - ?
                WHERE CAST(user_id AS TEXT) = ?
                  AND daily_balance >= ? AND extra_balance >= ?
                """,
                (daily_units, extra_units, owner, daily_units, extra_units),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:  # pragma: no cover - protected by BEGIN IMMEDIATE
                raise QuotaExceededError("quota changed while reserving")
            await connection.execute(
                """
                INSERT INTO workshop_quota_reservations(
                    job_id, user_id, units, daily_units, extra_units, quota_date,
                    result_filename, state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
                """,
                (
                    job_id,
                    owner,
                    units,
                    daily_units,
                    extra_units,
                    quota_date,
                    result_filename,
                    now,
                    now,
                ),
            )
        return True

    async def capture(self, job_id: str) -> bool:
        return await self._settle(job_id, capture=True)

    async def refund(self, job_id: str) -> bool:
        return await self._settle(job_id, capture=False)

    async def recover(self, output_root: Path) -> tuple[int, int]:
        """Capture only atomically-written results; refund every unstarted remainder."""

        async with self._connect() as connection:
            cursor = await connection.execute(
                """
                SELECT job_id, result_filename
                FROM workshop_quota_reservations
                WHERE state = 'reserved'
                ORDER BY created_at, job_id
                """
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
        captured = 0
        refunded = 0
        root = await asyncio.to_thread(output_root.resolve)
        for row in rows:
            filename = str(row["result_filename"])
            result_exists = await asyncio.to_thread(_result_exists, root, filename)
            if result_exists:
                captured += int(await self.capture(str(row["job_id"])))
            else:
                refunded += int(await self.refund(str(row["job_id"])))
        return captured, refunded

    async def recover_jobs(self, durable_job_ids: Collection[str]) -> tuple[int, int]:
        """Settle reservations from the persistent job/result authority.

        A result file by itself is not a completed job: it may have been written
        just before a crash and never committed to the jobs database.  Callers
        therefore pass only succeeded jobs whose result metadata was reconciled.
        """

        durable = {str(job_id) for job_id in durable_job_ids}
        async with self._connect() as connection:
            cursor = await connection.execute(
                """
                SELECT job_id
                FROM workshop_quota_reservations
                WHERE state = 'reserved'
                ORDER BY created_at, job_id
                """
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
        captured = 0
        refunded = 0
        for row in rows:
            job_id = str(row["job_id"])
            if job_id in durable:
                captured += int(await self.capture(job_id))
            else:
                refunded += int(await self.refund(job_id))
        return captured, refunded

    async def _settle(self, job_id: str, *, capture: bool) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        async with self._transaction() as connection:
            row = await _fetchone(
                connection,
                "SELECT * FROM workshop_quota_reservations WHERE job_id = ?",
                (job_id,),
            )
            if row is None:
                raise ResourceNotFoundError()
            state = str(row["state"])
            target = "captured" if capture else "refunded"
            if state == target:
                return False
            if state != "reserved":
                raise IdempotencyConflictError("workshop reservation is already settled")
            if not capture:
                # Daily units expire with their day; never inflate a refreshed day.
                current_date = await _current_quota_date(connection, str(row["user_id"]))
                daily_units = int(row["daily_units"]) if current_date == row["quota_date"] else 0
                await connection.execute(
                    """
                    UPDATE user_quotas
                    SET daily_balance = MIN(daily_limit, daily_balance + ?),
                        extra_balance = extra_balance + ?
                    WHERE CAST(user_id AS TEXT) = ?
                    """,
                    (daily_units, int(row["extra_units"]), str(row["user_id"])),
                )
            await connection.execute(
                """
                UPDATE workshop_quota_reservations
                SET state = ?, updated_at = ?
                WHERE job_id = ? AND state = 'reserved'
                """,
                (target, now, job_id),
            )
        return True

    async def _refresh_and_get(
        self,
        connection: aiosqlite.Connection,
        user_id: str,
        quota_date: str,
    ) -> WorkshopQuotaBalance:
        row = await _fetchone(
            connection,
            """
            SELECT daily_limit, daily_balance, extra_balance, last_refresh_date
            FROM user_quotas WHERE CAST(user_id AS TEXT) = ?
            """,
            (user_id,),
        )
        if row is None:
            raise ResourceNotFoundError()
        daily_limit = int(row["daily_limit"])
        daily_balance = int(row["daily_balance"])
        if str(row["last_refresh_date"] or "") != quota_date:
            daily_balance = daily_limit
            await connection.execute(
                """
                UPDATE user_quotas
                SET daily_balance = ?, last_refresh_date = ?
                WHERE CAST(user_id AS TEXT) = ?
                """,
                (daily_balance, quota_date, user_id),
            )
        return WorkshopQuotaBalance(
            daily_limit=daily_limit,
            daily_balance=daily_balance,
            extra_balance=int(row["extra_balance"]),
        )

    @asynccontextmanager
    async def _connect(self) -> AsyncIterator[aiosqlite.Connection]:
        if not self._ready:
            raise RuntimeError("workshop quota repository has not been initialized")
        async with self._database.connect() as connection:
            connection.row_factory = aiosqlite.Row
            await connection.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms}")
            await connection.execute("PRAGMA foreign_keys = ON")
            await connection.execute("PRAGMA synchronous = FULL")
            yield connection

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[aiosqlite.Connection]:
        async with self._connect() as connection:
            await connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                await connection.commit()
            except BaseException:
                await connection.rollback()
                raise


async def _current_quota_date(connection: aiosqlite.Connection, user_id: str) -> str:
    row = await _fetchone(
        connection,
        "SELECT last_refresh_date FROM user_quotas WHERE CAST(user_id AS TEXT) = ?",
        (user_id,),
    )
    return str(row["last_refresh_date"] or "") if row is not None else ""


def _result_exists(root: Path, filename: str) -> bool:
    path = (root / filename).resolve()
    return path.parent == root and path.is_file() and path.stat().st_size > 0


async def _fetchone(
    connection: aiosqlite.Connection,
    sql: str,
    parameters: tuple[object, ...] = (),
) -> aiosqlite.Row | None:
    cursor = await connection.execute(sql, parameters)
    row = await cursor.fetchone()
    await cursor.close()
    return row
