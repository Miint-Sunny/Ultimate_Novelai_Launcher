from __future__ import annotations

import asyncio
from pathlib import Path

import aiosqlite
import pytest

from cloud_backend.errors import (
    IdempotencyConflictError,
    QuotaExceededError,
    ResourceNotFoundError,
)
from cloud_backend.infrastructure import SQLiteWorkshopQuotaRepository


async def _repository(tmp_path: Path, *, daily: int, extra: int) -> SQLiteWorkshopQuotaRepository:
    await asyncio.to_thread(tmp_path.mkdir, parents=True, exist_ok=True)
    path = tmp_path / "stats.db"
    async with aiosqlite.connect(path) as connection:
        await connection.execute(
            """
            CREATE TABLE user_quotas (
                user_id TEXT PRIMARY KEY,
                daily_limit INTEGER NOT NULL,
                daily_balance INTEGER NOT NULL,
                extra_balance INTEGER NOT NULL,
                last_refresh_date TEXT
            )
            """
        )
        await connection.execute(
            "INSERT INTO user_quotas VALUES ('owner', ?, ?, ?, '2026-07-13')",
            (daily, daily, extra),
        )
        await connection.commit()
    repository = SQLiteWorkshopQuotaRepository(path)
    await repository.initialize()
    await repository.initialize()  # idempotent lifecycle setup
    return repository


@pytest.mark.asyncio
async def test_concurrent_reservations_cannot_overdraw(tmp_path: Path) -> None:
    repository = await _repository(tmp_path, daily=1, extra=0)

    results = await asyncio.gather(
        repository.reserve(
            "owner",
            job_id="job-a",
            units=1,
            quota_date="2026-07-13",
            result_filename="job-a.png",
        ),
        repository.reserve(
            "owner",
            job_id="job-b",
            units=1,
            quota_date="2026-07-13",
            result_filename="job-b.png",
        ),
        return_exceptions=True,
    )

    assert sum(result is True for result in results) == 1
    assert sum(isinstance(result, QuotaExceededError) for result in results) == 1
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 0


@pytest.mark.asyncio
async def test_failed_result_write_refunds_and_recovery_captures_only_existing_file(
    tmp_path: Path,
) -> None:
    repository = await _repository(tmp_path, daily=2, extra=0)
    output = tmp_path / "outputs"
    await asyncio.to_thread(output.mkdir)
    await repository.reserve(
        "owner",
        job_id="missing-result",
        units=1,
        quota_date="2026-07-13",
        result_filename="missing-result.png",
    )
    await repository.reserve(
        "owner",
        job_id="saved-result",
        units=1,
        quota_date="2026-07-13",
        result_filename="saved-result.png",
    )
    await asyncio.to_thread((output / "saved-result.png").write_bytes, b"complete-result")

    captured, refunded = await repository.recover(output)

    assert (captured, refunded) == (1, 1)
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 1
    assert await repository.capture("saved-result") is False
    assert await repository.refund("missing-result") is False


@pytest.mark.asyncio
async def test_job_authority_recovery_ignores_uncommitted_orphan_files(tmp_path: Path) -> None:
    repository = await _repository(tmp_path, daily=2, extra=0)
    for job_id in ("durable", "orphan"):
        await repository.reserve(
            "owner",
            job_id=job_id,
            units=1,
            quota_date="2026-07-13",
            result_filename=f"{job_id}.png",
        )

    captured, refunded = await repository.recover_jobs({"durable"})

    assert (captured, refunded) == (1, 1)
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 1
    assert await repository.capture("durable") is False
    assert await repository.refund("orphan") is False


@pytest.mark.asyncio
async def test_repository_requires_initialize_and_existing_owner(tmp_path: Path) -> None:
    repository = SQLiteWorkshopQuotaRepository(tmp_path / "missing.db")
    with pytest.raises(RuntimeError, match="not been initialized"):
        await repository.balance("owner", quota_date="2026-07-13")

    repository = await _repository(tmp_path / "ready", daily=1, extra=0)
    with pytest.raises(ResourceNotFoundError):
        await repository.balance("missing", quota_date="2026-07-13")
    with pytest.raises(ResourceNotFoundError):
        await repository.reserve(
            "missing",
            job_id="missing-owner",
            units=1,
            quota_date="2026-07-13",
            result_filename="missing.png",
        )
    with pytest.raises(ResourceNotFoundError):
        await repository.capture("missing-job")
    with pytest.raises(ValueError, match="positive"):
        await repository.reserve(
            "owner",
            job_id="zero",
            units=0,
            quota_date="2026-07-13",
            result_filename="zero.png",
        )


@pytest.mark.asyncio
async def test_reservation_idempotency_rejects_reused_job_identity(tmp_path: Path) -> None:
    repository = await _repository(tmp_path, daily=5, extra=0)
    kwargs = {
        "job_id": "same-job",
        "units": 1,
        "quota_date": "2026-07-13",
        "result_filename": "same-job.png",
    }
    assert await repository.reserve("owner", **kwargs) is True
    assert await repository.reserve("owner", **kwargs) is False

    for owner, changes in [
        ("other", {}),
        ("owner", {"units": 2}),
        ("owner", {"result_filename": "different.png"}),
    ]:
        candidate = {**kwargs, **changes}
        with pytest.raises(IdempotencyConflictError, match="reused"):
            await repository.reserve(owner, **candidate)


@pytest.mark.asyncio
async def test_settlement_is_one_way_and_refund_respects_daily_refresh(tmp_path: Path) -> None:
    repository = await _repository(tmp_path, daily=1, extra=2)
    await repository.reserve(
        "owner",
        job_id="captured",
        units=1,
        quota_date="2026-07-13",
        result_filename="captured.png",
    )
    assert await repository.capture("captured") is True
    with pytest.raises(IdempotencyConflictError, match="settled"):
        await repository.refund("captured")

    await repository.reserve(
        "owner",
        job_id="refunded",
        units=2,
        quota_date="2026-07-13",
        result_filename="refunded.png",
    )
    # The next day's daily refresh must not receive yesterday's daily unit again;
    # only the reservation's two extra units are returned.
    refreshed = await repository.balance("owner", quota_date="2026-07-14")
    assert refreshed.total_available == 1
    assert await repository.refund("refunded") is True
    balance = await repository.balance("owner", quota_date="2026-07-14")
    assert balance.daily_balance == 1
    assert balance.extra_balance == 2
    with pytest.raises(IdempotencyConflictError, match="settled"):
        await repository.capture("refunded")


@pytest.mark.asyncio
async def test_recovery_rejects_traversal_and_zero_length_results(tmp_path: Path) -> None:
    repository = await _repository(tmp_path, daily=2, extra=0)
    output = tmp_path / "outputs"
    output.mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    (output / "empty.png").write_bytes(b"")
    await repository.reserve(
        "owner",
        job_id="traversal",
        units=1,
        quota_date="2026-07-13",
        result_filename="../outside.png",
    )
    await repository.reserve(
        "owner",
        job_id="empty",
        units=1,
        quota_date="2026-07-13",
        result_filename="empty.png",
    )

    assert await repository.recover(output) == (0, 2)
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 2
