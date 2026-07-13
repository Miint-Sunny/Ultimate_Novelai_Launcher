from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from backend_core.errors import AppError, ErrorCode, InvalidArgumentError
from backend_core.jobs import GenerationJob, JobCreateResult, JobEvent, JobStatus
from backend_core.types import as_utc, utc_now


def _job() -> GenerationJob:
    timestamp = datetime(2025, 1, 2, 3, 4, tzinfo=timezone(timedelta(hours=8)))
    return GenerationJob(
        id="job-1",
        status=JobStatus.QUEUED,
        payload={"prompt": "test"},
        request_hash="hash",
        queue_sequence=7,
        created_at=timestamp,
        updated_at=timestamp,
    )


def test_application_errors_preserve_transport_neutral_metadata() -> None:
    default = InvalidArgumentError("bad input", details={"field": "prompt"})
    assert str(default) == "bad input"
    assert default.code_value == ErrorCode.INVALID_ARGUMENT.value
    assert default.details == {"field": "prompt"}
    assert default.retryable is False

    custom = AppError("retry", code="upstream_busy", retryable=True)
    assert custom.code_value == "upstream_busy"
    assert custom.retryable is True


def test_generation_job_event_and_create_result_serialization() -> None:
    queued = _job()
    assert queued.terminal is False
    queued_data = queued.to_dict()
    assert queued_data["created_at"] == "2025-01-01T19:04:00+00:00"
    assert queued_data["result"] is None
    assert queued_data["started_at"] is None

    succeeded = replace(
        queued,
        status=JobStatus.SUCCEEDED,
        result={"asset_id": "asset-1"},
        started_at=queued.created_at,
        finished_at=queued.updated_at,
    )
    assert succeeded.terminal is True
    assert succeeded.to_dict()["result"] == {"asset_id": "asset-1"}

    event = JobEvent(
        sequence=3,
        job_id=queued.id,
        kind="snapshot",
        status=queued.status,
        created_at=queued.created_at,
        data={"progress": 0.5},
    )
    assert event.event_type == "snapshot"
    assert event.to_dict()["data"] == {"progress": 0.5}

    create_result = JobCreateResult(job=queued, created=True)
    assert tuple(create_result) == (queued, True)


def test_utc_helpers_normalize_aware_values_and_reject_naive_values() -> None:
    assert utc_now().tzinfo is timezone.utc
    local = datetime(2025, 1, 2, 3, 4, tzinfo=timezone(timedelta(hours=8)))
    assert as_utc(local) == datetime(2025, 1, 1, 19, 4, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="timezone"):
        as_utc(datetime(2025, 1, 2, 3, 4))
