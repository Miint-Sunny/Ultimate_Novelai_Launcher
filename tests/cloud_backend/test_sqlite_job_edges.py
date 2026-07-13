from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, cast

import aiosqlite
import pytest

from backend_core.jobs import JobStatus
from cloud_backend.errors import (
    IdempotencyConflictError,
    InvalidRequestError,
    JobStateConflictError,
    ResourceNotFoundError,
)
from cloud_backend.identity import ResourceOwner
from cloud_backend.infrastructure import SQLiteCloudJobRepository
from cloud_backend.infrastructure.sqlite_jobs import request_hash


async def _repository(tmp_path: Path, **kwargs) -> SQLiteCloudJobRepository:
    repository = SQLiteCloudJobRepository(tmp_path / "jobs.db", **kwargs)
    await repository.initialize()
    return repository


async def _create(
    repository: SQLiteCloudJobRepository,
    job_id: str,
    *,
    owner: ResourceOwner | None = None,
    idempotency_key: str | None = None,
    reservation: str | None = None,
) -> None:
    await repository.create(
        job_id=job_id,
        resource=owner or ResourceOwner("tenant", "owner"),
        request_hash=request_hash({"id": job_id}),
        payload={"id": job_id},
        idempotency_key=idempotency_key,
        quota_reservation_id=reservation,
    )


@pytest.mark.asyncio
async def test_repository_lifecycle_and_missing_lookup(tmp_path: Path) -> None:
    repository = SQLiteCloudJobRepository(tmp_path / "jobs.db")
    assert repository.ready is False
    with pytest.raises(RuntimeError, match="not been initialized"):
        await repository.get("missing")

    await repository.initialize()
    await repository.initialize()
    assert repository.ready is True
    assert await repository.get("missing") is None
    assert await repository.get_job_owner("missing") is None

    await _create(repository, "owned")
    assert await repository.get_job_owner("owned") == ResourceOwner("tenant", "owner")

    snapshot = await repository.snapshot_with_watermark("owned")
    assert snapshot is not None
    job, watermark = snapshot
    assert job.status is JobStatus.QUEUED
    assert watermark == 1
    assert await repository.snapshot_with_watermark("missing") is None

    await repository.transition("owned", JobStatus.RUNNING, kind="started")
    updated = await repository.snapshot_with_watermark("owned")
    assert updated is not None
    job, watermark = updated
    assert job.status is JobStatus.RUNNING
    assert watermark == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"job_id": "bad id"}, "job id"),
        ({"resource": ResourceOwner("tenant", None)}, "owner"),
        ({"request_hash": "bad"}, "request_hash"),
        ({"idempotency_key": ""}, "idempotency"),
        ({"quota_reservation_id": " bad"}, "quota reservation"),
        ({"cost_units": -1}, "cost_units"),
        ({"cost_units": True}, "cost_units"),
        ({"total_steps": -1}, "total_steps"),
        ({"total_steps": True}, "total_steps"),
        ({"payload": {"bad": object()}}, "serializable"),
        ({"payload": {"large": "x" * (256 * 1024)}}, "too large"),
    ],
)
async def test_create_rejects_invalid_fields(
    tmp_path: Path,
    overrides: dict[str, Any],
    message: str,
) -> None:
    repository = await _repository(tmp_path)
    kwargs: dict[str, Any] = {
        "job_id": "valid-job",
        "resource": ResourceOwner("tenant", "owner"),
        "request_hash": request_hash({"valid": True}),
        "payload": {"valid": True},
        "idempotency_key": None,
    }
    kwargs.update(overrides)
    with pytest.raises(InvalidRequestError, match=message):
        await repository.create(**kwargs)


@pytest.mark.asyncio
async def test_create_rejects_naive_clock(tmp_path: Path) -> None:
    repository = await _repository(tmp_path, clock=lambda: datetime(2026, 7, 13))
    with pytest.raises(ValueError, match="aware"):
        await _create(repository, "naive-clock")


@pytest.mark.asyncio
async def test_job_id_replay_requires_same_owner_hash_and_idempotency(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    owner = ResourceOwner("tenant", "owner")
    digest = request_hash({"id": "same"})
    first = await repository.create(
        job_id="same",
        resource=owner,
        request_hash=digest,
        payload={"id": "same"},
        idempotency_key=None,
    )
    replay = await repository.create(
        job_id="same",
        resource=owner,
        request_hash=digest,
        payload={"id": "same"},
        idempotency_key=None,
    )
    assert first.created is True and replay.created is False

    with pytest.raises(IdempotencyConflictError, match="job id"):
        await repository.create(
            job_id="same",
            resource=ResourceOwner("tenant", "other"),
            request_hash=digest,
            payload={"id": "same"},
            idempotency_key=None,
        )


@pytest.mark.asyncio
async def test_transition_validation_terminal_idempotency_and_preservation(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    await _create(repository, "job")

    with pytest.raises(ResourceNotFoundError):
        await repository.transition("missing", JobStatus.RUNNING)
    with pytest.raises(InvalidRequestError, match="status"):
        await repository.transition("job", cast(JobStatus, "running"))
    with pytest.raises(InvalidRequestError, match="event kind"):
        await repository.transition("job", JobStatus.RUNNING, kind="")
    with pytest.raises(InvalidRequestError, match="serializable"):
        await repository.transition("job", JobStatus.RUNNING, data={"bad": object()})
    with pytest.raises(InvalidRequestError, match="too large"):
        await repository.transition("job", JobStatus.RUNNING, data={"large": "x" * 20_000})
    with pytest.raises(JobStateConflictError, match="not allowed"):
        await repository.transition("job", JobStatus.SUCCEEDED)
    with pytest.raises(InvalidRequestError, match="step"):
        await repository.transition("job", JobStatus.RUNNING, step=-1)
    with pytest.raises(InvalidRequestError, match="step"):
        await repository.transition("job", JobStatus.RUNNING, step=2, total_steps=1)

    running, _ = await repository.transition(
        "job",
        JobStatus.RUNNING,
        result={"type": "file", "path": "job.png"},
        error="temporary",
        total_steps=2,
    )
    progress, _ = await repository.transition("job", JobStatus.RUNNING, step=1)
    assert progress.started_at == running.started_at
    assert progress.result == {"type": "file", "path": "job.png"}
    assert progress.error == "temporary"
    completed, _ = await repository.transition("job", JobStatus.SUCCEEDED, step=2)
    assert completed.finished_at is not None
    same, event = await repository.transition("job", JobStatus.SUCCEEDED)
    assert same.status is JobStatus.SUCCEEDED and event is None
    with pytest.raises(JobStateConflictError, match="terminal"):
        await repository.transition("job", JobStatus.FAILED)


@pytest.mark.asyncio
async def test_cancel_classification_is_atomic_and_terminal_safe(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    with pytest.raises(ResourceNotFoundError):
        await repository.request_cancel("missing")

    await _create(repository, "queued")
    cancelled, event = await repository.request_cancel("queued")
    assert cancelled.status is JobStatus.CANCELLED
    assert event and event.kind == "cancelled"
    replay, event = await repository.request_cancel("queued")
    assert replay.status is JobStatus.CANCELLED and event is None

    await _create(repository, "running")
    await repository.transition("running", JobStatus.RUNNING)
    cancelling, event = await repository.request_cancel("running")
    assert cancelling.status is JobStatus.CANCELLING
    assert event and event.kind == "cancel_requested"
    replay, event = await repository.request_cancel("running")
    assert replay.status is JobStatus.CANCELLING and event is None
    await repository.transition("running", JobStatus.CANCELLED)

    await _create(repository, "failed")
    await repository.transition("failed", JobStatus.RUNNING)
    await repository.transition("failed", JobStatus.FAILED)
    with pytest.raises(JobStateConflictError, match="not cancellable"):
        await repository.request_cancel("failed")


@pytest.mark.asyncio
async def test_provider_and_quota_markers_are_idempotent_and_ordered(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    for missing_call in (
        repository.mark_provider_attempted,
        repository.mark_cost_committed,
        repository.mark_quota_refunded,
    ):
        with pytest.raises(ResourceNotFoundError):
            await missing_call("missing")

    await _create(repository, "attempted", reservation="reservation-attempted")
    with pytest.raises(JobStateConflictError, match="running"):
        await repository.mark_provider_attempted("attempted")
    with pytest.raises(JobStateConflictError, match="before"):
        await repository.mark_cost_committed("attempted")
    await repository.transition("attempted", JobStatus.RUNNING)
    attempted, event = await repository.mark_provider_attempted("attempted")
    assert attempted.provider_attempted and event
    replay, event = await repository.mark_provider_attempted("attempted")
    assert replay.provider_attempted and event is None
    with pytest.raises(JobStateConflictError, match="cannot be refunded"):
        await repository.mark_quota_refunded("attempted")
    committed, event = await repository.mark_cost_committed("attempted")
    assert committed.cost_committed and committed.quota_settled and event
    replay, event = await repository.mark_cost_committed("attempted")
    assert replay.cost_committed and event is None

    await _create(repository, "refunded", reservation="reservation-refunded")
    refunded, event = await repository.mark_quota_refunded("refunded")
    assert refunded.quota_settled and not refunded.cost_committed and event
    replay, event = await repository.mark_quota_refunded("refunded")
    assert replay.quota_settled and event is None


@pytest.mark.asyncio
async def test_recovery_queries_and_missing_result_repair_edges(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    await _create(repository, "settlement", reservation="reservation")
    await _create(repository, "succeeded")
    await repository.transition("succeeded", JobStatus.RUNNING)
    await repository.transition("succeeded", JobStatus.SUCCEEDED)

    assert [job.id for job in await repository.list_succeeded()] == ["succeeded"]
    assert (await repository.invalidate_missing_result("settlement")).status is JobStatus.QUEUED
    with pytest.raises(ResourceNotFoundError):
        await repository.invalidate_missing_result("missing")

    recovered = await repository.recover_interrupted()
    assert [job.id for job in recovered] == ["settlement"]
    assert [job.id for job in await repository.list_recovery_settlements()] == ["settlement"]
    assert await repository.recover_interrupted() == []


@pytest.mark.asyncio
async def test_recovery_settlements_include_every_unsettled_terminal_state(
    tmp_path: Path,
) -> None:
    repository = await _repository(tmp_path)
    for job_id in (
        "cancelled-unsettled",
        "failed-unsettled",
        "interrupted-unsettled",
        "succeeded-unsettled",
        "active-reservation",
        "settled-reservation",
    ):
        await _create(repository, job_id, reservation=f"reservation-{job_id}")

    await repository.transition("cancelled-unsettled", JobStatus.CANCELLED)
    await repository.transition("failed-unsettled", JobStatus.RUNNING)
    await repository.transition("failed-unsettled", JobStatus.FAILED)
    await repository.transition("interrupted-unsettled", JobStatus.INTERRUPTED)
    await repository.transition("succeeded-unsettled", JobStatus.RUNNING)
    await repository.transition("succeeded-unsettled", JobStatus.SUCCEEDED)
    await repository.transition("active-reservation", JobStatus.RUNNING)
    await repository.transition("settled-reservation", JobStatus.CANCELLED)
    await repository.mark_quota_refunded("settled-reservation")

    recoverable = await repository.list_recovery_settlements()

    assert {job.id: job.status for job in recoverable} == {
        "cancelled-unsettled": JobStatus.CANCELLED,
        "failed-unsettled": JobStatus.FAILED,
        "interrupted-unsettled": JobStatus.INTERRUPTED,
        "succeeded-unsettled": JobStatus.SUCCEEDED,
    }


@pytest.mark.asyncio
async def test_watch_events_waits_for_new_events_and_stops_at_terminal(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    await _create(repository, "watched")

    async def collect():
        return [event async for event in repository.watch_events("watched", after_sequence=1)]

    watcher = asyncio.create_task(collect())
    await asyncio.sleep(0.01)
    await repository.transition("watched", JobStatus.RUNNING)
    await repository.transition("watched", JobStatus.SUCCEEDED)
    events = await asyncio.wait_for(watcher, timeout=1)

    assert [event.status for event in events] == [JobStatus.RUNNING, JobStatus.SUCCEEDED]


@pytest.mark.asyncio
async def test_initialize_upgrades_pre_release_job_columns(tmp_path: Path) -> None:
    path = tmp_path / "old.db"
    async with aiosqlite.connect(path) as connection:
        await connection.execute(
            """
            CREATE TABLE cloud_jobs (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                status TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                idempotency_key TEXT,
                payload_json TEXT NOT NULL,
                result_json TEXT,
                error TEXT,
                step INTEGER NOT NULL DEFAULT 0,
                total_steps INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            )
            """
        )
        await connection.commit()

    repository = SQLiteCloudJobRepository(path)
    await repository.initialize()
    await _create(repository, "upgraded", reservation="reservation")
    upgraded = await repository.get("upgraded")

    assert upgraded and upgraded.quota_reservation_id == "reservation"
