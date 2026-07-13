from __future__ import annotations

import asyncio
import hashlib
import json
import math
import uuid
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from datetime import datetime, timezone
from typing import Literal, overload

import aiosqlite

from backend_core.errors import (
    CapacityExceededError,
    ConflictError,
    InvalidArgumentError,
    ResourceNotFoundError,
)
from backend_core.jobs import GenerationJob, JobCreateResult, JobEvent, JobStatus
from backend_core.types import JsonValue
from sidecar.persistence import Database


class QueueFullError(CapacityExceededError):
    code = "queue_full"
    retryable = True

    def __init__(self, capacity: int) -> None:
        super().__init__(
            f"generation queue is at its capacity of {capacity}",
            code=self.code,
            details={"capacity": capacity, "retryable": True},
        )


class IdempotencyConflictError(ConflictError):
    code = "idempotency_conflict"

    def __init__(self, key: str) -> None:
        super().__init__(
            "idempotency key was already used with a different request",
            code=self.code,
            details={"idempotency_key": key},
        )


class JobNotFoundError(ResourceNotFoundError):
    code = "job_not_found"

    def __init__(self, job_id: str) -> None:
        super().__init__("generation job was not found", code=self.code, details={"job_id": job_id})


class JobNotCancellableError(ConflictError):
    code = "job_not_cancellable"

    def __init__(self, job: GenerationJob) -> None:
        super().__init__(
            f"job in {job.status.value} state cannot be cancelled",
            code=self.code,
            details={"job_id": job.id, "status": job.status.value},
        )


class InvalidJobTransitionError(ConflictError):
    code = "invalid_job_transition"

    def __init__(self, job: GenerationJob, target: JobStatus) -> None:
        super().__init__(
            f"job cannot transition from {job.status.value} to {target.value}",
            code=self.code,
            details={"job_id": job.id, "status": job.status.value, "target": target.value},
        )


class JobService:
    """SQLite-backed FIFO queue and state machine for generation work."""

    def __init__(
        self, database: Database, *, capacity: int = 100, owner: str | None = None
    ) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self.database = database
        self.capacity = capacity
        self.owner = _normalize_owner(owner)
        self._initialized = False
        self._initialize_lock = asyncio.Lock()

    async def initialize(self) -> None:
        async with self._initialize_lock:
            if self._initialized:
                return
            await self.database.initialize()
            now = _utc_now()
            async with self.database.transaction() as connection:
                cursor = await connection.execute(
                    """
                    SELECT * FROM generation_jobs
                    WHERE status IN ('running', 'cancelling')
                    ORDER BY queue_sequence
                    """
                )
                rows = await cursor.fetchall()
                await cursor.close()
                for row in rows:
                    await connection.execute(
                        """
                        UPDATE generation_jobs
                        SET status = 'interrupted', error_code = 'worker_restarted',
                            error_message = 'job was interrupted by sidecar restart',
                            updated_at = ?, finished_at = ?
                        WHERE id = ? AND status IN ('running', 'cancelling')
                        """,
                        (now, now, row["id"]),
                    )
                    await self._append_event(
                        connection,
                        str(row["id"]),
                        "interrupted",
                        JobStatus.INTERRUPTED,
                        {"error_code": "worker_restarted"},
                        created_at=now,
                    )
            self._initialized = True

    async def create_job(
        self,
        payload: Mapping[str, JsonValue],
        *,
        idempotency_key: str | None = None,
        job_id: str | None = None,
        owner: str | None = None,
    ) -> JobCreateResult:
        request_json = _canonical_object(payload, field="payload")
        request_hash = hashlib.sha256(request_json.encode("utf-8")).hexdigest()
        key = _normalize_idempotency_key(idempotency_key)
        resolved_owner = self.owner if owner is None else _normalize_owner(owner)
        resolved_id = _normalize_job_id(job_id) if job_id is not None else str(uuid.uuid4())
        now = _utc_now()

        async with self.database.transaction() as connection:
            if key is not None:
                row = await _fetchone(
                    connection,
                    """
                    SELECT * FROM generation_jobs
                    WHERE COALESCE(owner, '') = COALESCE(?, '') AND idempotency_key = ?
                    """,
                    (resolved_owner, key),
                )
                if row is not None:
                    job = _row_to_job(row)
                    if job.request_hash != request_hash:
                        raise IdempotencyConflictError(key)
                    return JobCreateResult(job=job, created=False)

            count_row = await _fetchone(
                connection,
                """
                SELECT COUNT(*) AS count FROM generation_jobs
                WHERE status = 'queued'
                """,
            )
            assert count_row is not None
            if int(count_row["count"]) >= self.capacity:
                raise QueueFullError(self.capacity)

            try:
                await connection.execute(
                    """
                    INSERT INTO generation_jobs(
                        id, owner, idempotency_key, request_hash, request_json, status,
                        progress, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
                    """,
                    (resolved_id, resolved_owner, key, request_hash, request_json, now, now),
                )
            except aiosqlite.IntegrityError as exc:
                raise ConflictError(
                    "generation job identifier already exists",
                    code="job_id_conflict",
                    details={"job_id": resolved_id},
                ) from exc
            await self._append_event(
                connection,
                resolved_id,
                "queued",
                JobStatus.QUEUED,
                {},
                created_at=now,
            )
            row = await _fetch_job_row(connection, resolved_id)
            return JobCreateResult(job=_row_to_job(row), created=True)

    async def list_jobs(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        statuses: Iterable[JobStatus | str] | None = None,
    ) -> list[GenerationJob]:
        _validate_page(limit, offset)
        normalized = _normalize_statuses(statuses)
        status_values = [status.value for status in normalized]
        status_values.extend("" for _ in range(len(JobStatus) - len(status_values)))
        parameters: list[object] = [int(bool(normalized)), *status_values]
        parameters.extend((limit, offset))
        async with self.database.connect() as connection:
            cursor = await connection.execute(
                """
                SELECT * FROM generation_jobs
                WHERE ? = 0 OR status IN (?, ?, ?, ?, ?, ?, ?)
                ORDER BY queue_sequence DESC
                LIMIT ? OFFSET ?
                """,
                tuple(parameters),
            )
            rows = await cursor.fetchall()
            await cursor.close()
        return [_row_to_job(row) for row in rows]

    async def get_job(self, job_id: str) -> GenerationJob | None:
        async with self.database.connect() as connection:
            row = await _fetchone(
                connection,
                "SELECT * FROM generation_jobs WHERE id = ?",
                (_normalize_job_id(job_id),),
            )
        return _row_to_job(row) if row is not None else None

    async def require_job(self, job_id: str) -> GenerationJob:
        job = await self.get_job(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        return job

    async def snapshot_with_watermark(self, job_id: str) -> tuple[GenerationJob, int]:
        """Read current state and the last event from one SQLite snapshot."""

        resolved_id = _normalize_job_id(job_id)
        async with self.database.transaction(immediate=False) as connection:
            row = await _fetch_job_row(connection, resolved_id, required=False)
            if row is None:
                raise JobNotFoundError(resolved_id)
            watermark_row = await _fetchone(
                connection,
                "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM job_events WHERE job_id = ?",
                (resolved_id,),
            )
        assert watermark_row is not None
        return _row_to_job(row), int(watermark_row["watermark"])

    async def cancel_job(self, job_id: str, reason: str | None = None) -> GenerationJob:
        resolved_id = _normalize_job_id(job_id)
        now = _utc_now()
        message = str(reason).strip() if reason else "job cancelled"
        async with self.database.transaction() as connection:
            row = await _fetch_job_row(connection, resolved_id, required=False)
            if row is None:
                raise JobNotFoundError(resolved_id)
            job = _row_to_job(row)
            if job.status in {JobStatus.CANCELLED, JobStatus.CANCELLING}:
                return job
            if job.status not in {JobStatus.QUEUED, JobStatus.RUNNING}:
                raise JobNotCancellableError(job)
            if job.status is JobStatus.QUEUED:
                await connection.execute(
                    """
                    UPDATE generation_jobs
                    SET status = 'cancelled', error_code = 'cancelled', error_message = ?,
                        updated_at = ?, finished_at = ?
                    WHERE id = ? AND status = 'queued'
                    """,
                    (message, now, now, resolved_id),
                )
                await self._append_event(
                    connection,
                    resolved_id,
                    "cancelled",
                    JobStatus.CANCELLED,
                    {"reason": message},
                    created_at=now,
                )
            else:
                await connection.execute(
                    """
                    UPDATE generation_jobs
                    SET status = 'cancelling', error_code = 'cancellation_requested',
                        error_message = ?, updated_at = ?
                    WHERE id = ? AND status = 'running'
                    """,
                    (message, now, resolved_id),
                )
                await self._append_event(
                    connection,
                    resolved_id,
                    "cancel_requested",
                    JobStatus.CANCELLING,
                    {"reason": message},
                    created_at=now,
                )
            return _row_to_job(await _fetch_job_row(connection, resolved_id))

    async def mark_cancelled(self, job_id: str, reason: str | None = None) -> GenerationJob:
        """A worker calls this after upstream cancellation has completed."""
        resolved_id = _normalize_job_id(job_id)
        now = _utc_now()
        async with self.database.transaction() as connection:
            job = _row_to_job(await _fetch_job_row(connection, resolved_id))
            if job.status is JobStatus.CANCELLED:
                return job
            if job.status is not JobStatus.CANCELLING:
                raise InvalidJobTransitionError(job, JobStatus.CANCELLED)
            message = str(reason).strip() if reason else (job.error_message or "job cancelled")
            await connection.execute(
                """
                UPDATE generation_jobs
                SET status = 'cancelled', error_code = 'cancelled', error_message = ?,
                    updated_at = ?, finished_at = ?
                WHERE id = ? AND status = 'cancelling'
                """,
                (message, now, now, resolved_id),
            )
            await self._append_event(
                connection,
                resolved_id,
                "cancelled",
                JobStatus.CANCELLED,
                {"reason": message},
                created_at=now,
            )
            return _row_to_job(await _fetch_job_row(connection, resolved_id))

    async def claim_next(self) -> GenerationJob | None:
        now = _utc_now()
        async with self.database.transaction() as connection:
            row = await _fetchone(
                connection,
                """
                SELECT * FROM generation_jobs
                WHERE status = 'queued'
                ORDER BY queue_sequence ASC
                LIMIT 1
                """,
            )
            if row is None:
                return None
            job_id = str(row["id"])
            await connection.execute(
                """
                UPDATE generation_jobs
                SET status = 'running', updated_at = ?, started_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (now, now, job_id),
            )
            await self._append_event(
                connection, job_id, "started", JobStatus.RUNNING, {}, created_at=now
            )
            return _row_to_job(await _fetch_job_row(connection, job_id))

    async def update_progress(
        self, job_id: str, progress: float, data: Mapping[str, JsonValue] | None = None
    ) -> GenerationJob:
        if not isinstance(progress, (int, float)) or not math.isfinite(progress):
            raise InvalidArgumentError("progress must be a finite number")
        normalized = float(progress)
        if normalized < 0 or normalized > 1:
            raise InvalidArgumentError("progress must be between 0 and 1")
        event_data = dict(data or {})
        _canonical_object(event_data, field="event data")
        now = _utc_now()
        async with self.database.transaction() as connection:
            job = _row_to_job(await _fetch_job_row(connection, _normalize_job_id(job_id)))
            if job.status is not JobStatus.RUNNING:
                raise InvalidJobTransitionError(job, JobStatus.RUNNING)
            if normalized < job.progress:
                raise InvalidArgumentError("job progress cannot move backwards")
            await connection.execute(
                "UPDATE generation_jobs SET progress = ?, updated_at = ? WHERE id = ?",
                (normalized, now, job.id),
            )
            event_data["progress"] = normalized
            await self._append_event(
                connection, job.id, "progress", JobStatus.RUNNING, event_data, created_at=now
            )
            return _row_to_job(await _fetch_job_row(connection, job.id))

    async def succeed_job(
        self, job_id: str, result: Mapping[str, JsonValue] | None = None
    ) -> GenerationJob:
        result_json = _canonical_object(result or {}, field="result")
        return await self._finish(
            job_id,
            target=JobStatus.SUCCEEDED,
            kind="succeeded",
            allowed_statuses={JobStatus.RUNNING},
            result_json=result_json,
            event_data={"result": json.loads(result_json)},
        )

    async def fail_job(self, job_id: str, error_code: str, error_message: str) -> GenerationJob:
        code = str(error_code).strip()
        message = str(error_message).strip()
        if not code or not message:
            raise InvalidArgumentError("error_code and error_message are required")
        return await self._finish(
            job_id,
            target=JobStatus.FAILED,
            kind="failed",
            allowed_statuses={JobStatus.RUNNING, JobStatus.CANCELLING},
            error_code=code,
            error_message=message,
            event_data={"error_code": code, "error_message": message},
        )

    async def interrupt_job(self, job_id: str, reason: str = "worker interrupted") -> GenerationJob:
        message = str(reason).strip() or "worker interrupted"
        return await self._finish(
            job_id,
            target=JobStatus.INTERRUPTED,
            kind="interrupted",
            allowed_statuses={JobStatus.RUNNING, JobStatus.CANCELLING},
            error_code="interrupted",
            error_message=message,
            event_data={"reason": message},
        )

    async def list_events(
        self, job_id: str, *, after_sequence: int = 0, limit: int = 1000
    ) -> list[JobEvent]:
        resolved_id = _normalize_job_id(job_id)
        if after_sequence < 0 or limit < 1 or limit > 5000:
            raise InvalidArgumentError("invalid event page")
        async with self.database.connect() as connection:
            exists = await _fetchone(
                connection, "SELECT 1 FROM generation_jobs WHERE id = ?", (resolved_id,)
            )
            if exists is None:
                raise JobNotFoundError(resolved_id)
            cursor = await connection.execute(
                """
                SELECT * FROM job_events
                WHERE job_id = ? AND sequence > ?
                ORDER BY sequence ASC
                LIMIT ?
                """,
                (resolved_id, after_sequence, limit),
            )
            rows = await cursor.fetchall()
            await cursor.close()
        return [_row_to_event(row) for row in rows]

    async def watch_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
        poll_interval: float = 0.25,
    ) -> AsyncIterator[JobEvent]:
        """Poll persisted events; transports may adapt this to SSE or WebSockets."""
        if poll_interval <= 0:
            raise InvalidArgumentError("poll_interval must be positive")
        cursor = after_sequence
        while True:
            events = await self.list_events(job_id, after_sequence=cursor)
            for event in events:
                cursor = event.sequence
                yield event
            job = await self.require_job(job_id)
            if job.terminal and not events:
                return
            await asyncio.sleep(poll_interval)

    async def active_count(self) -> int:
        async with self.database.connect() as connection:
            row = await _fetchone(
                connection,
                """
                SELECT COUNT(*) AS count FROM generation_jobs
                WHERE status IN ('queued', 'running', 'cancelling')
                """,
            )
            assert row is not None
            return int(row["count"])

    async def _finish(
        self,
        job_id: str,
        *,
        target: JobStatus,
        kind: str,
        allowed_statuses: set[JobStatus],
        result_json: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        event_data: Mapping[str, JsonValue],
    ) -> GenerationJob:
        resolved_id = _normalize_job_id(job_id)
        now = _utc_now()
        async with self.database.transaction() as connection:
            job = _row_to_job(await _fetch_job_row(connection, resolved_id))
            if job.status not in allowed_statuses:
                raise InvalidJobTransitionError(job, target)
            progress = 1.0 if target is JobStatus.SUCCEEDED else job.progress
            await connection.execute(
                """
                UPDATE generation_jobs
                SET status = ?, progress = ?, result_json = ?, error_code = ?,
                    error_message = ?, updated_at = ?, finished_at = ?
                WHERE id = ?
                """,
                (
                    target.value,
                    progress,
                    result_json,
                    error_code,
                    error_message,
                    now,
                    now,
                    resolved_id,
                ),
            )
            await self._append_event(
                connection, resolved_id, kind, target, event_data, created_at=now
            )
            return _row_to_job(await _fetch_job_row(connection, resolved_id))

    async def _append_event(
        self,
        connection: aiosqlite.Connection,
        job_id: str,
        kind: str,
        status: JobStatus,
        data: Mapping[str, JsonValue],
        *,
        created_at: str,
    ) -> None:
        await connection.execute(
            """
            INSERT INTO job_events(job_id, kind, status, data_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (job_id, kind, status.value, _canonical_object(data, field="event data"), created_at),
        )


async def _fetchone(
    connection: aiosqlite.Connection, sql: str, parameters: Sequence[object] = ()
) -> aiosqlite.Row | None:
    cursor = await connection.execute(sql, tuple(parameters))
    row = await cursor.fetchone()
    await cursor.close()
    return row


@overload
async def _fetch_job_row(
    connection: aiosqlite.Connection, job_id: str, *, required: Literal[True] = True
) -> aiosqlite.Row: ...


@overload
async def _fetch_job_row(
    connection: aiosqlite.Connection, job_id: str, *, required: Literal[False]
) -> aiosqlite.Row | None: ...


async def _fetch_job_row(
    connection: aiosqlite.Connection, job_id: str, *, required: bool = True
) -> aiosqlite.Row | None:
    row = await _fetchone(connection, "SELECT * FROM generation_jobs WHERE id = ?", (job_id,))
    if row is None and required:
        raise JobNotFoundError(job_id)
    return row


def _row_to_job(row: aiosqlite.Row) -> GenerationJob:
    result = json.loads(row["result_json"]) if row["result_json"] is not None else None
    return GenerationJob(
        id=str(row["id"]),
        owner=str(row["owner"]) if row["owner"] is not None else None,
        idempotency_key=(
            str(row["idempotency_key"]) if row["idempotency_key"] is not None else None
        ),
        request_hash=str(row["request_hash"]),
        payload=json.loads(row["request_json"]),
        status=JobStatus(str(row["status"])),
        progress=float(row["progress"]),
        result=result,
        error_code=str(row["error_code"]) if row["error_code"] is not None else None,
        error_message=(str(row["error_message"]) if row["error_message"] is not None else None),
        queue_sequence=int(row["queue_sequence"]),
        created_at=_parse_time(str(row["created_at"])),
        updated_at=_parse_time(str(row["updated_at"])),
        started_at=_parse_time(str(row["started_at"])) if row["started_at"] else None,
        finished_at=_parse_time(str(row["finished_at"])) if row["finished_at"] else None,
    )


def _row_to_event(row: aiosqlite.Row) -> JobEvent:
    return JobEvent(
        sequence=int(row["sequence"]),
        job_id=str(row["job_id"]),
        kind=str(row["kind"]),
        status=JobStatus(str(row["status"])),
        data=json.loads(row["data_json"]),
        created_at=_parse_time(str(row["created_at"])),
    )


def _canonical_object(value: Mapping[str, JsonValue], *, field: str) -> str:
    if not isinstance(value, Mapping):
        raise InvalidArgumentError(f"{field} must be a JSON object")
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise InvalidArgumentError(f"{field} must contain valid JSON values") from exc


def _normalize_job_id(value: str) -> str:
    normalized = str(value).strip()
    if not normalized or len(normalized) > 200 or any(ord(char) < 32 for char in normalized):
        raise InvalidArgumentError("job_id is invalid")
    return normalized


def _normalize_idempotency_key(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized or len(normalized) > 200 or any(ord(char) < 32 for char in normalized):
        raise InvalidArgumentError("idempotency_key is invalid")
    return normalized


def _normalize_owner(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized or len(normalized) > 200:
        raise InvalidArgumentError("owner is invalid")
    return normalized


def _normalize_statuses(
    statuses: Iterable[JobStatus | str] | None,
) -> tuple[JobStatus, ...]:
    if statuses is None:
        return ()
    try:
        return tuple(dict.fromkeys(JobStatus(item) for item in statuses))
    except ValueError as exc:
        raise InvalidArgumentError("unknown job status") from exc


def _validate_page(limit: int, offset: int) -> None:
    if limit < 1 or limit > 1000 or offset < 0:
        raise InvalidArgumentError("invalid job page")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
