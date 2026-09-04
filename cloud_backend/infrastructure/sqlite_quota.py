"""Single-host SQLite/WAL quota ledger with atomic idempotent mutations."""

from __future__ import annotations

import asyncio
import sqlite3
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from ..errors import (
    IdempotencyConflictError,
    InvalidRequestError,
    QuotaExceededError,
    ReservationStateError,
    ResourceNotFoundError,
)
from ..identity import Principal, ResourceOwner
from ..quota import (
    QuotaBalance,
    QuotaReservation,
    QuotaReservationIncreaseRequest,
    QuotaReservationRequest,
    QuotaSettlementRequest,
    ReservationResult,
    ReservationState,
    SettlementAction,
    SettlementResult,
)
from .secure_sqlite import (
    SecureSQLiteFile,
    check_component_version,
    quick_check,
    record_component_version,
    require_table_columns,
)

_SCHEMA_COMPONENT = "cloud_quota"
_SCHEMA_VERSION = 1
_ACCOUNT_COLUMNS = ("tenant_id", "owner_id", "available_units", "updated_at")
_RESERVATION_COLUMNS = (
    "id",
    "tenant_id",
    "owner_id",
    "units",
    "purpose",
    "idempotency_key",
    "state",
    "actor_kind",
    "actor_subject_id",
    "created_at",
    "updated_at",
)
_SETTLEMENT_COLUMNS = (
    "tenant_id",
    "owner_id",
    "idempotency_key",
    "reservation_id",
    "action",
    "actor_kind",
    "actor_subject_id",
    "created_at",
)

_SELECT_RESERVATION_BY_KEY = """
    SELECT id, tenant_id, owner_id, units, purpose, idempotency_key, state,
           actor_kind, actor_subject_id, created_at, updated_at
    FROM cloud_quota_reservations
    WHERE tenant_id = ? AND owner_id = ? AND idempotency_key = ?
"""

_SELECT_RESERVATION_BY_ID = """
    SELECT id, tenant_id, owner_id, units, purpose, idempotency_key, state,
           actor_kind, actor_subject_id, created_at, updated_at
    FROM cloud_quota_reservations
    WHERE id = ? AND tenant_id = ? AND owner_id = ?
"""

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS cloud_quota_accounts (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        available_units INTEGER NOT NULL CHECK (available_units >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, owner_id)
    ) WITHOUT ROWID
    """,
    """
    CREATE TABLE IF NOT EXISTS cloud_quota_reservations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        units INTEGER NOT NULL CHECK (units > 0),
        purpose TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'captured', 'refunded')),
        actor_kind TEXT NOT NULL,
        actor_subject_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, owner_id, idempotency_key),
        FOREIGN KEY (tenant_id, owner_id)
            REFERENCES cloud_quota_accounts(tenant_id, owner_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cloud_quota_reservation_owner_state
    ON cloud_quota_reservations(tenant_id, owner_id, state)
    """,
    """
    CREATE TABLE IF NOT EXISTS cloud_quota_settlements (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('capture', 'refund')),
        actor_kind TEXT NOT NULL,
        actor_subject_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, owner_id, idempotency_key),
        FOREIGN KEY (reservation_id) REFERENCES cloud_quota_reservations(id)
    ) WITHOUT ROWID
    """,
)


class SQLiteQuotaRepository:
    """Quota repository optimized for one host and multiple async connections.

    Every balance mutation runs under ``BEGIN IMMEDIATE``.  WAL permits concurrent
    readers while SQLite's single writer lock serializes balance checks with debit
    or refund, so an application-level asyncio lock is neither needed nor trusted.
    """

    def __init__(
        self,
        path: Path,
        *,
        busy_timeout_ms: int = 10_000,
        clock: Callable[[], datetime] | None = None,
        reservation_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if busy_timeout_ms < 1:
            raise ValueError("busy_timeout_ms must be positive")
        self.path = Path(path)
        self._database = SecureSQLiteFile(self.path)
        self.busy_timeout_ms = busy_timeout_ms
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._reservation_id_factory = reservation_id_factory or (lambda: uuid.uuid4().hex)
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
                    raise RuntimeError("quota database could not enable WAL mode")
                await connection.execute("PRAGMA synchronous = NORMAL")
                await connection.execute("PRAGMA foreign_keys = ON")
                await connection.execute("BEGIN IMMEDIATE")
                try:
                    for statement in _SCHEMA:
                        await connection.execute(statement)
                    await require_table_columns(
                        connection,
                        "cloud_quota_accounts",
                        _ACCOUNT_COLUMNS,
                    )
                    await require_table_columns(
                        connection,
                        "cloud_quota_reservations",
                        _RESERVATION_COLUMNS,
                    )
                    await require_table_columns(
                        connection,
                        "cloud_quota_settlements",
                        _SETTLEMENT_COLUMNS,
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

    async def journal_mode(self) -> str:
        async with self._connect() as connection:
            row = await _fetchone(connection, "PRAGMA journal_mode")
            return str(row[0]).lower() if row is not None else ""

    async def refund_interrupted_reservations(self) -> int:
        """Refund reservations left open by a previous single-host process.

        The legacy server does not persist executable jobs yet.  Consequently a
        reservation that is still ``reserved`` when a new process starts cannot
        have a live worker and is an interrupted job.  Recovery is one immediate
        transaction and writes deterministic settlement rows for auditability.
        """

        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT id, tenant_id, owner_id, units, actor_kind, actor_subject_id
                FROM cloud_quota_reservations
                WHERE state = 'reserved'
                ORDER BY created_at, id
                """
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
            for row in rows:
                tenant_id = str(row["tenant_id"])
                owner_id = str(row["owner_id"])
                reservation_id = str(row["id"])
                await connection.execute(
                    """
                    UPDATE cloud_quota_accounts
                    SET available_units = available_units + ?, updated_at = ?
                    WHERE tenant_id = ? AND owner_id = ?
                    """,
                    (int(row["units"]), now, tenant_id, owner_id),
                )
                await connection.execute(
                    """
                    UPDATE cloud_quota_reservations
                    SET state = 'refunded', updated_at = ?
                    WHERE id = ? AND state = 'reserved'
                    """,
                    (now, reservation_id),
                )
                await connection.execute(
                    """
                    INSERT OR IGNORE INTO cloud_quota_settlements(
                        tenant_id, owner_id, idempotency_key, reservation_id,
                        action, actor_kind, actor_subject_id, created_at
                    ) VALUES (?, ?, ?, ?, 'refund', ?, ?, ?)
                    """,
                    (
                        tenant_id,
                        owner_id,
                        f"recovery:{reservation_id}",
                        reservation_id,
                        str(row["actor_kind"]),
                        str(row["actor_subject_id"]),
                        now,
                    ),
                )
            return len(rows)

    async def provision_account(
        self,
        resource: ResourceOwner,
        *,
        available_units: int,
    ) -> QuotaBalance:
        """Create an account once; later balance changes must use ledger operations."""

        _require_quota_resource(resource)
        _non_negative_units(available_units)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            existing = await _fetchone(
                connection,
                """
                SELECT available_units, updated_at
                FROM cloud_quota_accounts
                WHERE tenant_id = ? AND owner_id = ?
                """,
                (resource.tenant_id, resource.owner_id),
            )
            if existing is not None:
                if int(existing["available_units"]) != available_units:
                    raise IdempotencyConflictError("quota account already exists")
                return _row_to_balance(existing, resource)
            await connection.execute(
                """
                INSERT INTO cloud_quota_accounts(
                    tenant_id, owner_id, available_units, updated_at
                ) VALUES (?, ?, ?, ?)
                """,
                (resource.tenant_id, resource.owner_id, available_units, now),
            )
            return QuotaBalance(resource, available_units, _parse_timestamp(now))

    async def get_balance(self, resource: ResourceOwner) -> QuotaBalance:
        _require_quota_resource(resource)
        async with self._connect() as connection:
            row = await _fetchone(
                connection,
                """
                SELECT available_units, updated_at
                FROM cloud_quota_accounts
                WHERE tenant_id = ? AND owner_id = ?
                """,
                (resource.tenant_id, resource.owner_id),
            )
        if row is None:
            raise ResourceNotFoundError()
        return _row_to_balance(row, resource)

    async def reserve(
        self,
        resource: ResourceOwner,
        *,
        units: int,
        purpose: str,
        idempotency_key: str,
        actor: Principal,
    ) -> ReservationResult:
        _require_quota_resource(resource)
        # Reuse domain request validation even when a caller targets this port directly.
        QuotaReservationRequest(units, idempotency_key, purpose)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            existing = await self._reservation_by_key(
                connection,
                resource,
                idempotency_key,
            )
            if existing is not None:
                reservation = _row_to_reservation(existing)
                if not _same_reservation_request(reservation, units, purpose, actor):
                    raise IdempotencyConflictError(
                        "idempotency key was already used for a different reservation"
                    )
                return ReservationResult(reservation, created=False)

            cursor = await connection.execute(
                """
                UPDATE cloud_quota_accounts
                SET available_units = available_units - ?, updated_at = ?
                WHERE tenant_id = ? AND owner_id = ? AND available_units >= ?
                """,
                (units, now, resource.tenant_id, resource.owner_id, units),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                balance = await _fetchone(
                    connection,
                    """
                    SELECT available_units
                    FROM cloud_quota_accounts
                    WHERE tenant_id = ? AND owner_id = ?
                    """,
                    (resource.tenant_id, resource.owner_id),
                )
                if balance is None:
                    raise ResourceNotFoundError()
                raise QuotaExceededError(
                    "quota is insufficient",
                    details={
                        "available_units": int(balance["available_units"]),
                        "required_units": units,
                    },
                )

            reservation_id = self._reservation_id_factory()
            if not isinstance(reservation_id, str) or not reservation_id:
                raise RuntimeError("reservation id factory returned an invalid id")
            await connection.execute(
                """
                INSERT INTO cloud_quota_reservations(
                    id, tenant_id, owner_id, units, purpose, idempotency_key,
                    state, actor_kind, actor_subject_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)
                """,
                (
                    reservation_id,
                    resource.tenant_id,
                    resource.owner_id,
                    units,
                    purpose,
                    idempotency_key,
                    actor.kind.value,
                    actor.subject_id,
                    now,
                    now,
                ),
            )
            row = await self._reservation_by_id(connection, resource, reservation_id)
            if row is None:  # pragma: no cover - protects an impossible local invariant
                raise RuntimeError("created quota reservation could not be read")
            return ReservationResult(_row_to_reservation(row), created=True)

    async def increase_reservation(
        self,
        resource: ResourceOwner,
        *,
        reservation_id: str,
        target_units: int,
    ) -> QuotaReservation:
        """Atomically debit the delta and grow one still-open reservation."""

        _require_quota_resource(resource)
        QuotaReservationIncreaseRequest(reservation_id, target_units)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            row = await self._reservation_by_id(connection, resource, reservation_id)
            if row is None:
                raise ResourceNotFoundError()
            reservation = _row_to_reservation(row)
            if reservation.state is not ReservationState.RESERVED:
                raise ReservationStateError(
                    "reservation increase requires a reserved reservation"
                )
            if target_units < reservation.units:
                raise InvalidRequestError("reservation units cannot decrease")
            if target_units == reservation.units:
                return reservation

            additional_units = target_units - reservation.units
            cursor = await connection.execute(
                """
                UPDATE cloud_quota_accounts
                SET available_units = available_units - ?, updated_at = ?
                WHERE tenant_id = ? AND owner_id = ? AND available_units >= ?
                """,
                (
                    additional_units,
                    now,
                    resource.tenant_id,
                    resource.owner_id,
                    additional_units,
                ),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                balance = await _fetchone(
                    connection,
                    """
                    SELECT available_units
                    FROM cloud_quota_accounts
                    WHERE tenant_id = ? AND owner_id = ?
                    """,
                    (resource.tenant_id, resource.owner_id),
                )
                if balance is None:
                    raise ResourceNotFoundError()
                raise QuotaExceededError(
                    "quota is insufficient",
                    details={
                        "available_units": int(balance["available_units"]),
                        "required_units": additional_units,
                    },
                )

            await connection.execute(
                """
                UPDATE cloud_quota_reservations
                SET units = ?, updated_at = ?
                WHERE id = ? AND tenant_id = ? AND owner_id = ? AND state = 'reserved'
                """,
                (
                    target_units,
                    now,
                    reservation_id,
                    resource.tenant_id,
                    resource.owner_id,
                ),
            )
            updated = await self._reservation_by_id(connection, resource, reservation_id)
            if updated is None:  # pragma: no cover - guarded by transaction
                raise RuntimeError("updated quota reservation could not be read")
            return _row_to_reservation(updated)

    async def settle(
        self,
        resource: ResourceOwner,
        *,
        reservation_id: str,
        action: SettlementAction,
        idempotency_key: str,
        actor: Principal,
    ) -> SettlementResult:
        _require_quota_resource(resource)
        QuotaSettlementRequest(reservation_id, idempotency_key)
        if not isinstance(action, SettlementAction):
            raise InvalidRequestError("settlement action is invalid")
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            replay = await _fetchone(
                connection,
                """
                SELECT reservation_id, action, actor_kind, actor_subject_id
                FROM cloud_quota_settlements
                WHERE tenant_id = ? AND owner_id = ? AND idempotency_key = ?
                """,
                (resource.tenant_id, resource.owner_id, idempotency_key),
            )
            if replay is not None:
                if (
                    str(replay["reservation_id"]) != reservation_id
                    or str(replay["action"]) != action.value
                    or str(replay["actor_kind"]) != actor.kind.value
                    or str(replay["actor_subject_id"]) != actor.subject_id
                ):
                    raise IdempotencyConflictError(
                        "idempotency key was already used for a different settlement"
                    )
                row = await self._reservation_by_id(connection, resource, reservation_id)
                if row is None:  # pragma: no cover - guarded by foreign keys
                    raise RuntimeError("settled quota reservation could not be read")
                return SettlementResult(_row_to_reservation(row), changed=False)

            row = await self._reservation_by_id(connection, resource, reservation_id)
            if row is None:
                raise ResourceNotFoundError()
            reservation = _row_to_reservation(row)
            target = (
                ReservationState.CAPTURED
                if action is SettlementAction.CAPTURE
                else ReservationState.REFUNDED
            )
            changed = reservation.state is ReservationState.RESERVED
            if reservation.state not in {ReservationState.RESERVED, target}:
                raise ReservationStateError(
                    f"{action.value} is not allowed for a {reservation.state.value} reservation"
                )

            if changed:
                if action is SettlementAction.REFUND:
                    await connection.execute(
                        """
                        UPDATE cloud_quota_accounts
                        SET available_units = available_units + ?, updated_at = ?
                        WHERE tenant_id = ? AND owner_id = ?
                        """,
                        (reservation.units, now, resource.tenant_id, resource.owner_id),
                    )
                await connection.execute(
                    """
                    UPDATE cloud_quota_reservations
                    SET state = ?, updated_at = ?
                    WHERE id = ? AND tenant_id = ? AND owner_id = ? AND state = 'reserved'
                    """,
                    (
                        target.value,
                        now,
                        reservation_id,
                        resource.tenant_id,
                        resource.owner_id,
                    ),
                )

            await connection.execute(
                """
                INSERT INTO cloud_quota_settlements(
                    tenant_id, owner_id, idempotency_key, reservation_id,
                    action, actor_kind, actor_subject_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resource.tenant_id,
                    resource.owner_id,
                    idempotency_key,
                    reservation_id,
                    action.value,
                    actor.kind.value,
                    actor.subject_id,
                    now,
                ),
            )
            updated = await self._reservation_by_id(connection, resource, reservation_id)
            if updated is None:  # pragma: no cover - guarded by transaction
                raise RuntimeError("updated quota reservation could not be read")
            return SettlementResult(_row_to_reservation(updated), changed=changed)

    async def _reservation_by_key(
        self,
        connection: aiosqlite.Connection,
        resource: ResourceOwner,
        idempotency_key: str,
    ) -> aiosqlite.Row | None:
        return await _fetchone(
            connection,
            _SELECT_RESERVATION_BY_KEY,
            (resource.tenant_id, resource.owner_id, idempotency_key),
        )

    async def _reservation_by_id(
        self,
        connection: aiosqlite.Connection,
        resource: ResourceOwner,
        reservation_id: str,
    ) -> aiosqlite.Row | None:
        return await _fetchone(
            connection,
            _SELECT_RESERVATION_BY_ID,
            (reservation_id, resource.tenant_id, resource.owner_id),
        )

    @asynccontextmanager
    async def _connect(self) -> AsyncIterator[aiosqlite.Connection]:
        if not self._ready:
            raise RuntimeError("quota repository has not been initialized")
        async with self._database.connect() as connection:
            connection.row_factory = aiosqlite.Row
            await connection.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms}")
            await connection.execute("PRAGMA foreign_keys = ON")
            await connection.execute("PRAGMA synchronous = NORMAL")
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


def _require_quota_resource(resource: ResourceOwner) -> None:
    if resource.owner_id is None:
        raise InvalidRequestError("owner_id is required for a quota account")


def _non_negative_units(value: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 2**63 - 1:
        raise InvalidRequestError("available_units must be a non-negative integer")


def _same_reservation_request(
    reservation: QuotaReservation,
    units: int,
    purpose: str,
    actor: Principal,
) -> bool:
    return (
        reservation.units == units
        and reservation.purpose == purpose
        and reservation.actor_kind == actor.kind.value
        and reservation.actor_subject_id == actor.subject_id
    )


def _row_to_balance(row: sqlite3.Row | aiosqlite.Row, resource: ResourceOwner) -> QuotaBalance:
    return QuotaBalance(
        resource=resource,
        available_units=int(row["available_units"]),
        updated_at=_parse_timestamp(str(row["updated_at"])),
    )


def _row_to_reservation(row: sqlite3.Row | aiosqlite.Row) -> QuotaReservation:
    return QuotaReservation(
        id=str(row["id"]),
        resource=ResourceOwner(str(row["tenant_id"]), str(row["owner_id"])),
        units=int(row["units"]),
        purpose=str(row["purpose"]),
        idempotency_key=str(row["idempotency_key"]),
        state=ReservationState(str(row["state"])),
        actor_kind=str(row["actor_kind"]),
        actor_subject_id=str(row["actor_subject_id"]),
        created_at=_parse_timestamp(str(row["created_at"])),
        updated_at=_parse_timestamp(str(row["updated_at"])),
    )


async def _fetchone(
    connection: aiosqlite.Connection,
    sql: str,
    parameters: tuple[object, ...] = (),
) -> aiosqlite.Row | None:
    cursor = await connection.execute(sql, parameters)
    row = await cursor.fetchone()
    await cursor.close()
    return row


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware timestamp")
    return value.astimezone(timezone.utc).isoformat()


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError("quota database contains a naive timestamp")
    return parsed.astimezone(timezone.utc)
