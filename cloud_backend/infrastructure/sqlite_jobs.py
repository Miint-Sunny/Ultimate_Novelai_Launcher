"""Single-host SQLite/WAL repository for legacy cloud jobs and JobEvents."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from backend_core.jobs import JobStatus

from ..errors import (
    IdempotencyConflictError,
    InvalidRequestError,
    JobStateConflictError,
    ResourceNotFoundError,
)
from ..identity import ResourceOwner
from ..jobs import CloudJob, CloudJobCreateResult, CloudJobEvent
from .secure_sqlite import (
    SecureSQLiteFile,
    check_component_version,
    quick_check,
    record_component_version,
    require_table_columns,
)

_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_MAX_PAYLOAD_JSON = 256 * 1024
_MAX_RESULT_JSON = 16 * 1024
_MAX_EVENT_JSON = 16 * 1024
_SCHEMA_COMPONENT = "cloud_jobs"
_SCHEMA_VERSION = 1

_JOB_COLUMNS = (
    "id",
    "tenant_id",
    "owner_id",
    "status",
    "request_hash",
    "idempotency_key",
    "quota_reservation_id",
    "cost_units",
    "provider_attempted",
    "cost_committed",
    "quota_settled",
    "payload_json",
    "result_json",
    "error",
    "step",
    "total_steps",
    "created_at",
    "updated_at",
    "started_at",
    "finished_at",
)
_EVENT_COLUMNS = ("job_id", "sequence", "kind", "status", "data_json", "created_at")

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS cloud_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
            'queued', 'running', 'cancelling', 'succeeded', 'failed',
            'cancelled', 'interrupted'
        )),
        request_hash TEXT NOT NULL,
        idempotency_key TEXT,
        quota_reservation_id TEXT,
        cost_units INTEGER NOT NULL DEFAULT 0 CHECK(cost_units >= 0),
        provider_attempted INTEGER NOT NULL DEFAULT 0 CHECK(provider_attempted IN (0, 1)),
        cost_committed INTEGER NOT NULL DEFAULT 0 CHECK(cost_committed IN (0, 1)),
        quota_settled INTEGER NOT NULL DEFAULT 0 CHECK(quota_settled IN (0, 1)),
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        step INTEGER NOT NULL DEFAULT 0 CHECK(step >= 0),
        total_steps INTEGER NOT NULL DEFAULT 0 CHECK(total_steps >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_jobs_owner_idempotency
    ON cloud_jobs(tenant_id, owner_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cloud_jobs_owner_created
    ON cloud_jobs(tenant_id, owner_id, created_at DESC, id DESC)
    """,
    """
    CREATE TABLE IF NOT EXISTS cloud_job_events (
        job_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, sequence),
        FOREIGN KEY(job_id) REFERENCES cloud_jobs(id) ON DELETE CASCADE
    ) WITHOUT ROWID
    """,
)

_ALLOWED_TRANSITIONS: dict[JobStatus, set[JobStatus]] = {
    JobStatus.QUEUED: {JobStatus.RUNNING, JobStatus.CANCELLED, JobStatus.INTERRUPTED},
    JobStatus.RUNNING: {
        JobStatus.CANCELLING,
        JobStatus.SUCCEEDED,
        JobStatus.FAILED,
        JobStatus.INTERRUPTED,
    },
    JobStatus.CANCELLING: {
        JobStatus.CANCELLED,
        JobStatus.SUCCEEDED,
        JobStatus.FAILED,
        JobStatus.INTERRUPTED,
    },
    JobStatus.SUCCEEDED: set(),
    JobStatus.FAILED: set(),
    JobStatus.CANCELLED: set(),
    JobStatus.INTERRUPTED: set(),
}


class SQLiteCloudJobRepository:
    """Persistent job authority for one SQLite/WAL cloud backend process."""

    def __init__(
        self,
        path: Path,
        *,
        busy_timeout_ms: int = 10_000,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.path = Path(path)
        self._database = SecureSQLiteFile(self.path)
        self.busy_timeout_ms = busy_timeout_ms
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._ready = False
        self._initialize_lock = asyncio.Lock()
        self._condition = asyncio.Condition()
        self._change_version = 0

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
                    raise RuntimeError("cloud jobs database could not enable WAL")
                await connection.execute("PRAGMA synchronous = FULL")
                await connection.execute("PRAGMA foreign_keys = ON")
                await connection.execute("BEGIN IMMEDIATE")
                try:
                    for statement in _SCHEMA:
                        await connection.execute(statement)
                    await self._ensure_columns(connection)
                    await require_table_columns(connection, "cloud_jobs", _JOB_COLUMNS)
                    await require_table_columns(connection, "cloud_job_events", _EVENT_COLUMNS)
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

    async def create(
        self,
        *,
        job_id: str,
        resource: ResourceOwner,
        request_hash: str,
        payload: Mapping[str, Any],
        idempotency_key: str | None,
        quota_reservation_id: str | None = None,
        cost_units: int = 0,
        total_steps: int = 0,
    ) -> CloudJobCreateResult:
        _validate_job_id(job_id)
        _validate_resource(resource)
        if _HASH.fullmatch(request_hash) is None:
            raise InvalidRequestError("request_hash is invalid")
        normalized_key = _idempotency_key(idempotency_key)
        reservation_id = (
            _bounded_text(quota_reservation_id, "quota reservation id", 200)
            if quota_reservation_id is not None
            else None
        )
        payload_json = _json(payload, _MAX_PAYLOAD_JSON, "job payload")
        cost_units = _counter(cost_units, "cost_units")
        if not isinstance(total_steps, int) or isinstance(total_steps, bool) or total_steps < 0:
            raise InvalidRequestError("total_steps is invalid")
        now = _timestamp(self._clock())

        async with self._transaction() as connection:
            if normalized_key is not None:
                existing = await _fetchone(
                    connection,
                    """
                    SELECT * FROM cloud_jobs
                    WHERE tenant_id = ? AND owner_id = ? AND idempotency_key = ?
                    """,
                    (resource.tenant_id, resource.owner_id, normalized_key),
                )
                if existing is not None:
                    job = _row_to_job(existing)
                    if job.request_hash != request_hash:
                        raise IdempotencyConflictError(
                            "idempotency key was already used for a different job"
                        )
                    return CloudJobCreateResult(job, created=False)

            existing_id = await _fetchone(
                connection,
                "SELECT * FROM cloud_jobs WHERE id = ?",
                (job_id,),
            )
            if existing_id is not None:
                job = _row_to_job(existing_id)
                if (
                    job.resource == resource
                    and job.request_hash == request_hash
                    and job.idempotency_key == normalized_key
                ):
                    return CloudJobCreateResult(job, created=False)
                raise IdempotencyConflictError("job id already exists")

            await connection.execute(
                """
                INSERT INTO cloud_jobs(
                    id, tenant_id, owner_id, status, request_hash,
                    idempotency_key, quota_reservation_id, cost_units,
                    provider_attempted, cost_committed, quota_settled,
                    payload_json, result_json, error,
                    step, total_steps, created_at, updated_at, started_at, finished_at
                ) VALUES (
                    ?, ?, ?, 'queued', ?, ?, ?, ?, 0, 0, 0, ?, NULL, NULL,
                    0, ?, ?, ?, NULL, NULL
                )
                """,
                (
                    job_id,
                    resource.tenant_id,
                    resource.owner_id,
                    request_hash,
                    normalized_key,
                    reservation_id,
                    cost_units,
                    payload_json,
                    total_steps,
                    now,
                    now,
                ),
            )
            await self._insert_event(
                connection,
                job_id=job_id,
                kind="submitted",
                status=JobStatus.QUEUED,
                data_json="{}",
                created_at=now,
            )
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("created cloud job could not be read")
            job = _row_to_job(row)
        await self._notify_change()
        return CloudJobCreateResult(job, created=True)

    async def get(self, job_id: str) -> CloudJob | None:
        _validate_job_id(job_id)
        async with self._connect() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
        return _row_to_job(row) if row is not None else None

    async def snapshot_with_watermark(self, job_id: str) -> tuple[CloudJob, int] | None:
        """Read one job and its event watermark from the same SQLite snapshot."""

        _validate_job_id(job_id)
        async with self._connect() as connection:
            # A deferred read transaction establishes its WAL snapshot on the
            # first SELECT without unnecessarily blocking concurrent writers.
            await connection.execute("BEGIN")
            try:
                row = await _fetchone(
                    connection,
                    "SELECT * FROM cloud_jobs WHERE id = ?",
                    (job_id,),
                )
                if row is None:
                    await connection.commit()
                    return None
                watermark_row = await _fetchone(
                    connection,
                    """
                    SELECT COALESCE(MAX(sequence), 0) AS watermark
                    FROM cloud_job_events
                    WHERE job_id = ?
                    """,
                    (job_id,),
                )
                await connection.commit()
            except BaseException:
                await connection.rollback()
                raise
        watermark = int(watermark_row["watermark"]) if watermark_row is not None else 0
        return _row_to_job(row), watermark

    async def get_job_owner(self, job_id: str) -> ResourceOwner | None:
        job = await self.get(job_id)
        return job.resource if job is not None else None

    async def transition(
        self,
        job_id: str,
        status: JobStatus,
        *,
        kind: str = "state_changed",
        step: int | None = None,
        total_steps: int | None = None,
        result: Mapping[str, Any] | None = None,
        error: str | None = None,
        data: Mapping[str, Any] | None = None,
    ) -> tuple[CloudJob, CloudJobEvent | None]:
        _validate_job_id(job_id)
        if not isinstance(status, JobStatus):
            raise InvalidRequestError("job status is invalid")
        kind = _bounded_text(kind, "event kind", 80)
        result_json = _json(result, _MAX_RESULT_JSON, "job result") if result is not None else None
        event_data = dict(data or {})
        # Large image data belongs in the result store, never in the event log.
        if any(key in event_data for key in {"image", "imageBase64", "preview", "result"}):
            raise InvalidRequestError("binary image data is forbidden in job events")
        data_json = _json(event_data, _MAX_EVENT_JSON, "job event")
        now = _timestamp(self._clock())

        async with self._transaction() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:
                raise ResourceNotFoundError()
            current = _row_to_job(row)
            if current.terminal:
                if status is current.status:
                    return current, None
                raise JobStateConflictError("terminal job status cannot change")
            if status is not current.status and status not in _ALLOWED_TRANSITIONS[current.status]:
                raise JobStateConflictError(
                    f"transition from {current.status.value} to {status.value} is not allowed"
                )

            next_step = current.step if step is None else _counter(step, "step")
            next_total = (
                current.total_steps if total_steps is None else _counter(total_steps, "total_steps")
            )
            if next_total and next_step > next_total:
                raise InvalidRequestError("step cannot exceed total_steps")
            started_at = current.started_at
            if started_at is None and status in {JobStatus.RUNNING, JobStatus.CANCELLING}:
                started_at = _parse_timestamp(now)
            finished_at = _parse_timestamp(now) if status in _TERMINAL else None
            next_result = (
                result_json
                if result_json is not None
                else (
                    _json(current.result, _MAX_RESULT_JSON, "job result")
                    if current.result is not None
                    else None
                )
            )
            next_error = error if error is not None else current.error
            if next_error is not None:
                next_error = _bounded_text(next_error, "job error", 2_000)
            await connection.execute(
                """
                UPDATE cloud_jobs
                SET status = ?, result_json = ?, error = ?, step = ?, total_steps = ?,
                    updated_at = ?, started_at = ?, finished_at = ?
                WHERE id = ?
                """,
                (
                    status.value,
                    next_result,
                    next_error,
                    next_step,
                    next_total,
                    now,
                    _optional_timestamp(started_at),
                    _optional_timestamp(finished_at),
                    job_id,
                ),
            )
            event = await self._insert_event(
                connection,
                job_id=job_id,
                kind=kind,
                status=status,
                data_json=data_json,
                created_at=now,
            )
            updated_row = await _fetchone(
                connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,)
            )
            if updated_row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("updated cloud job could not be read")
            updated = _row_to_job(updated_row)
        await self._notify_change()
        return updated, event

    async def request_cancel(self, job_id: str) -> tuple[CloudJob, CloudJobEvent | None]:
        """Atomically classify and apply cancellation against the current state."""

        _validate_job_id(job_id)
        now = _timestamp(self._clock())
        event: CloudJobEvent | None = None
        async with self._transaction() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:
                raise ResourceNotFoundError()
            current = _row_to_job(row)
            if current.status is JobStatus.QUEUED:
                next_status = JobStatus.CANCELLED
                kind = "cancelled"
                finished_at: str | None = now
            elif current.status is JobStatus.RUNNING:
                next_status = JobStatus.CANCELLING
                kind = "cancel_requested"
                finished_at = None
            elif current.status in {JobStatus.CANCELLING, JobStatus.CANCELLED}:
                return current, None
            else:
                raise JobStateConflictError("job is not cancellable")
            await connection.execute(
                """
                UPDATE cloud_jobs
                SET status = ?, error = ?, updated_at = ?, finished_at = ?
                WHERE id = ?
                """,
                (next_status.value, "user cancelled", now, finished_at, job_id),
            )
            event = await self._insert_event(
                connection,
                job_id=job_id,
                kind=kind,
                status=next_status,
                data_json="{}",
                created_at=now,
            )
            updated_row = await _fetchone(
                connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,)
            )
            if updated_row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("cancelled cloud job could not be read")
            updated = _row_to_job(updated_row)
        await self._notify_change()
        return updated, event

    async def mark_provider_attempted(
        self,
        job_id: str,
    ) -> tuple[CloudJob, CloudJobEvent | None]:
        """Durably record the billable boundary before contacting an upstream."""

        _validate_job_id(job_id)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:
                raise ResourceNotFoundError()
            current = _row_to_job(row)
            if current.provider_attempted:
                return current, None
            if current.status is not JobStatus.RUNNING:
                raise JobStateConflictError("provider attempt requires a running job")
            await connection.execute(
                """
                UPDATE cloud_jobs
                SET provider_attempted = 1, updated_at = ?
                WHERE id = ?
                """,
                (now, job_id),
            )
            event = await self._insert_event(
                connection,
                job_id=job_id,
                kind="provider_attempted",
                status=current.status,
                data_json="{}",
                created_at=now,
            )
            updated_row = await _fetchone(
                connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,)
            )
            if updated_row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("updated cloud job could not be read")
            updated = _row_to_job(updated_row)
        await self._notify_change()
        return updated, event

    async def mark_cost_committed(
        self,
        job_id: str,
    ) -> tuple[CloudJob, CloudJobEvent | None]:
        """Record that a reservation was captured; safe after crash recovery."""

        _validate_job_id(job_id)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:
                raise ResourceNotFoundError()
            current = _row_to_job(row)
            if current.cost_committed:
                return current, None
            if not current.provider_attempted:
                raise JobStateConflictError("cost cannot be committed before a provider attempt")
            await connection.execute(
                """
                UPDATE cloud_jobs
                SET cost_committed = 1, quota_settled = 1, updated_at = ?
                WHERE id = ?
                """,
                (now, job_id),
            )
            event = await self._insert_event(
                connection,
                job_id=job_id,
                kind="cost_committed",
                status=current.status,
                data_json="{}",
                created_at=now,
            )
            updated_row = await _fetchone(
                connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,)
            )
            if updated_row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("updated cloud job could not be read")
            updated = _row_to_job(updated_row)
        await self._notify_change()
        return updated, event

    async def mark_quota_refunded(
        self,
        job_id: str,
    ) -> tuple[CloudJob, CloudJobEvent | None]:
        """Record an idempotent refund for a job that never reached its provider."""

        _validate_job_id(job_id)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:
                raise ResourceNotFoundError()
            current = _row_to_job(row)
            if current.quota_settled:
                return current, None
            if current.provider_attempted or current.cost_committed:
                raise JobStateConflictError("attempted provider cost cannot be refunded")
            await connection.execute(
                """
                UPDATE cloud_jobs
                SET quota_settled = 1, updated_at = ?
                WHERE id = ?
                """,
                (now, job_id),
            )
            event = await self._insert_event(
                connection,
                job_id=job_id,
                kind="quota_refunded",
                status=current.status,
                data_json="{}",
                created_at=now,
            )
            updated_row = await _fetchone(
                connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,)
            )
            if updated_row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("updated cloud job could not be read")
            updated = _row_to_job(updated_row)
        await self._notify_change()
        return updated, event

    async def list_recovery_settlements(self) -> list[CloudJob]:
        """Return terminal reservations whose capture/refund is still unknown."""

        async with self._connect() as connection:
            cursor = await connection.execute(
                """
                SELECT * FROM cloud_jobs
                WHERE status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
                  AND quota_reservation_id IS NOT NULL
                  AND quota_settled = 0
                ORDER BY created_at, id
                """
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
        return [_row_to_job(row) for row in rows]

    async def list_succeeded(self) -> list[CloudJob]:
        async with self._connect() as connection:
            cursor = await connection.execute(
                "SELECT * FROM cloud_jobs WHERE status = 'succeeded' ORDER BY created_at, id"
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
        return [_row_to_job(row) for row in rows]

    async def list_active(self) -> list[CloudJob]:
        """Return every non-terminal job for deterministic process recovery."""

        async with self._connect() as connection:
            cursor = await connection.execute(
                """
                SELECT * FROM cloud_jobs
                WHERE status IN ('queued', 'running', 'cancelling')
                ORDER BY created_at, id
                """
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
        return [_row_to_job(row) for row in rows]

    async def list_for_owner(
        self,
        resource: ResourceOwner,
        *,
        limit: int = 200,
        payload_kind: str | None = None,
    ) -> list[CloudJob]:
        """Return a bounded recent owner view; authorization remains caller-side."""

        _validate_resource(resource)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1_000:
            raise InvalidRequestError("job list limit is invalid")
        normalized_kind = (
            _bounded_text(payload_kind, "payload kind", 80)
            if payload_kind is not None
            else None
        )
        async with self._connect() as connection:
            if normalized_kind is None:
                cursor = await connection.execute(
                    """
                    SELECT * FROM cloud_jobs
                    WHERE tenant_id = ? AND owner_id = ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                    """,
                    (resource.tenant_id, resource.owner_id, limit),
                )
            else:
                cursor = await connection.execute(
                    """
                    SELECT * FROM cloud_jobs
                    WHERE tenant_id = ? AND owner_id = ?
                      AND json_extract(payload_json, '$.kind') = ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                    """,
                    (resource.tenant_id, resource.owner_id, normalized_kind, limit),
                )
            rows = list(await cursor.fetchall())
            await cursor.close()
        return [_row_to_job(row) for row in rows]

    async def invalidate_missing_result(self, job_id: str) -> CloudJob:
        """Repair a succeeded row whose file failed startup integrity checks."""

        _validate_job_id(job_id)
        now = _timestamp(self._clock())
        async with self._transaction() as connection:
            row = await _fetchone(connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,))
            if row is None:
                raise ResourceNotFoundError()
            current = _row_to_job(row)
            if current.status is not JobStatus.SUCCEEDED:
                return current
            await connection.execute(
                """
                UPDATE cloud_jobs
                SET status = 'interrupted', result_json = NULL, error = ?,
                    updated_at = ?, finished_at = ?
                WHERE id = ?
                """,
                ("persisted result is missing or corrupt", now, now, job_id),
            )
            await self._insert_event(
                connection,
                job_id=job_id,
                kind="result_missing",
                status=JobStatus.INTERRUPTED,
                data_json='{"reason":"result_integrity"}',
                created_at=now,
            )
            updated_row = await _fetchone(
                connection, "SELECT * FROM cloud_jobs WHERE id = ?", (job_id,)
            )
            if updated_row is None:  # pragma: no cover - local transaction invariant
                raise RuntimeError("reconciled cloud job could not be read")
            updated = _row_to_job(updated_row)
        await self._notify_change()
        return updated

    async def recover_interrupted(self) -> list[CloudJob]:
        now = _timestamp(self._clock())
        recovered_ids: list[str] = []
        async with self._transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT id FROM cloud_jobs
                WHERE status IN ('queued', 'running', 'cancelling')
                ORDER BY created_at, id
                """
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
            for row in rows:
                job_id = str(row[0])
                await connection.execute(
                    """
                    UPDATE cloud_jobs
                    SET status = 'interrupted', error = ?, updated_at = ?, finished_at = ?
                    WHERE id = ?
                    """,
                    ("server restarted before the job completed", now, now, job_id),
                )
                await self._insert_event(
                    connection,
                    job_id=job_id,
                    kind="interrupted",
                    status=JobStatus.INTERRUPTED,
                    data_json='{"reason":"process_restart"}',
                    created_at=now,
                )
                recovered_ids.append(job_id)
        if recovered_ids:
            await self._notify_change()
        recovered: list[CloudJob] = []
        for job_id in recovered_ids:
            job = await self.get(job_id)
            if job is not None:
                recovered.append(job)
        return recovered

    async def list_events(self, job_id: str, *, after_sequence: int = 0) -> list[CloudJobEvent]:
        _validate_job_id(job_id)
        after_sequence = _counter(after_sequence, "after_sequence")
        async with self._connect() as connection:
            cursor = await connection.execute(
                """
                SELECT job_id, sequence, kind, status, data_json, created_at
                FROM cloud_job_events
                WHERE job_id = ? AND sequence > ?
                ORDER BY sequence
                """,
                (job_id, after_sequence),
            )
            rows = list(await cursor.fetchall())
            await cursor.close()
        return [_row_to_event(row) for row in rows]

    async def latest_sequence(self, job_id: str) -> int:
        _validate_job_id(job_id)
        async with self._connect() as connection:
            row = await _fetchone(
                connection,
                "SELECT COALESCE(MAX(sequence), 0) FROM cloud_job_events WHERE job_id = ?",
                (job_id,),
            )
        return int(row[0]) if row is not None else 0

    async def watch_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
    ) -> AsyncIterator[CloudJobEvent]:
        cursor = _counter(after_sequence, "after_sequence")
        while True:
            observed_version = self._change_version
            events = await self.list_events(job_id, after_sequence=cursor)
            for event in events:
                cursor = event.sequence
                yield event
            job = await self.get(job_id)
            if job is None or job.terminal:
                # A terminal transition can commit after list_events but before
                # get.  Drain that final transaction before closing the stream.
                if job is not None:
                    terminal_events = await self.list_events(job_id, after_sequence=cursor)
                    for event in terminal_events:
                        cursor = event.sequence
                        yield event
                return
            async with self._condition:
                if self._change_version == observed_version:
                    try:
                        await asyncio.wait_for(self._condition.wait(), timeout=15.0)
                    except TimeoutError:
                        pass

    async def _insert_event(
        self,
        connection: aiosqlite.Connection,
        *,
        job_id: str,
        kind: str,
        status: JobStatus,
        data_json: str,
        created_at: str,
    ) -> CloudJobEvent:
        row = await _fetchone(
            connection,
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM cloud_job_events WHERE job_id = ?",
            (job_id,),
        )
        sequence = int(row[0]) if row is not None else 1
        await connection.execute(
            """
            INSERT INTO cloud_job_events(job_id, sequence, kind, status, data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (job_id, sequence, kind, status.value, data_json, created_at),
        )
        return CloudJobEvent(
            job_id=job_id,
            sequence=sequence,
            kind=kind,
            status=status,
            data=json.loads(data_json),
            created_at=_parse_timestamp(created_at),
        )

    async def _notify_change(self) -> None:
        async with self._condition:
            self._change_version += 1
            self._condition.notify_all()

    @staticmethod
    async def _ensure_columns(connection: aiosqlite.Connection) -> None:
        """Add columns for databases created by an earlier pre-release build."""

        cursor = await connection.execute("PRAGMA table_info(cloud_jobs)")
        names = {str(row[1]) for row in await cursor.fetchall()}
        await cursor.close()
        additions = {
            "quota_reservation_id": "TEXT",
            "cost_units": "INTEGER NOT NULL DEFAULT 0 CHECK(cost_units >= 0)",
            "provider_attempted": (
                "INTEGER NOT NULL DEFAULT 0 CHECK(provider_attempted IN (0, 1))"
            ),
            "cost_committed": "INTEGER NOT NULL DEFAULT 0 CHECK(cost_committed IN (0, 1))",
            "quota_settled": "INTEGER NOT NULL DEFAULT 0 CHECK(quota_settled IN (0, 1))",
        }
        for name, declaration in additions.items():
            if name not in names:
                await connection.execute(f"ALTER TABLE cloud_jobs ADD COLUMN {name} {declaration}")

    @asynccontextmanager
    async def _connect(self) -> AsyncIterator[aiosqlite.Connection]:
        if not self._ready:
            raise RuntimeError("cloud jobs repository has not been initialized")
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


_TERMINAL = {
    JobStatus.SUCCEEDED,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
    JobStatus.INTERRUPTED,
}


def _validate_job_id(value: str) -> str:
    if not isinstance(value, str) or _JOB_ID.fullmatch(value) is None:
        raise InvalidRequestError("job id is invalid")
    return value


def _validate_resource(resource: ResourceOwner) -> None:
    if resource.owner_id is None:
        raise InvalidRequestError("cloud jobs require an owner")


def _idempotency_key(value: str | None) -> str | None:
    if value is None:
        return None
    return _bounded_text(value, "idempotency key", 200)


def _counter(value: int, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise InvalidRequestError(f"{field} is invalid")
    return value


def _bounded_text(value: str, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > maximum:
        raise InvalidRequestError(f"{field} is invalid")
    if any(ord(character) < 0x20 and character not in "\n\t" for character in value):
        raise InvalidRequestError(f"{field} is invalid")
    return value


def _json(value: Mapping[str, Any] | None, maximum: int, field: str) -> str:
    try:
        encoded = json.dumps(value or {}, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise InvalidRequestError(f"{field} is not JSON serializable") from exc
    if len(encoded.encode("utf-8")) > maximum:
        raise InvalidRequestError(f"{field} is too large")
    return encoded


def request_hash(payload: Mapping[str, Any]) -> str:
    encoded = _json(payload, _MAX_PAYLOAD_JSON, "job payload").encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware timestamp")
    return value.astimezone(timezone.utc).isoformat()


def _optional_timestamp(value: datetime | None) -> str | None:
    return _timestamp(value) if value is not None else None


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError("cloud jobs database contains a naive timestamp")
    return parsed.astimezone(timezone.utc)


def _row_to_job(row: aiosqlite.Row) -> CloudJob:
    return CloudJob(
        id=str(row["id"]),
        resource=ResourceOwner(str(row["tenant_id"]), str(row["owner_id"])),
        status=JobStatus(str(row["status"])),
        request_hash=str(row["request_hash"]),
        idempotency_key=str(row["idempotency_key"]) if row["idempotency_key"] else None,
        quota_reservation_id=(
            str(row["quota_reservation_id"]) if row["quota_reservation_id"] else None
        ),
        cost_units=int(row["cost_units"]),
        provider_attempted=bool(row["provider_attempted"]),
        cost_committed=bool(row["cost_committed"]),
        quota_settled=bool(row["quota_settled"]),
        payload=json.loads(str(row["payload_json"])),
        result=json.loads(str(row["result_json"])) if row["result_json"] else None,
        error=str(row["error"]) if row["error"] else None,
        step=int(row["step"]),
        total_steps=int(row["total_steps"]),
        created_at=_parse_timestamp(str(row["created_at"])),
        updated_at=_parse_timestamp(str(row["updated_at"])),
        started_at=_parse_timestamp(str(row["started_at"])) if row["started_at"] else None,
        finished_at=_parse_timestamp(str(row["finished_at"])) if row["finished_at"] else None,
    )


def _row_to_event(row: aiosqlite.Row) -> CloudJobEvent:
    return CloudJobEvent(
        job_id=str(row["job_id"]),
        sequence=int(row["sequence"]),
        kind=str(row["kind"]),
        status=JobStatus(str(row["status"])),
        data=json.loads(str(row["data_json"])),
        created_at=_parse_timestamp(str(row["created_at"])),
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
