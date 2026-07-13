"""Transport-neutral records for persistent generation jobs."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from .types import JsonValue, as_utc


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


TERMINAL_JOB_STATUSES = frozenset(
    {
        JobStatus.SUCCEEDED,
        JobStatus.FAILED,
        JobStatus.CANCELLED,
        JobStatus.INTERRUPTED,
    }
)


@dataclass(frozen=True)
class GenerationJob:
    id: str
    status: JobStatus
    payload: Mapping[str, JsonValue]
    request_hash: str
    queue_sequence: int
    created_at: datetime
    updated_at: datetime
    owner: str | None = None
    idempotency_key: str | None = None
    progress: float = 0.0
    result: Mapping[str, JsonValue] | None = None
    error_code: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_JOB_STATUSES

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "owner": self.owner,
            "idempotency_key": self.idempotency_key,
            "request_hash": self.request_hash,
            "payload": dict(self.payload),
            "status": self.status.value,
            "progress": self.progress,
            "result": dict(self.result) if self.result is not None else None,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "queue_sequence": self.queue_sequence,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
        }


@dataclass(frozen=True)
class JobEvent:
    """A persisted event with no assumptions about HTTP, SSE, or WebSockets."""

    sequence: int
    job_id: str
    kind: str
    status: JobStatus
    created_at: datetime
    data: Mapping[str, JsonValue] = field(default_factory=dict)

    @property
    def event_type(self) -> str:
        return self.kind

    def to_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status.value,
            "created_at": _iso(self.created_at),
            "data": dict(self.data),
        }


@dataclass(frozen=True)
class JobCreateResult:
    job: GenerationJob
    created: bool

    def __iter__(self):  # type: ignore[no-untyped-def]
        # Convenient for workers while keeping named fields for API adapters.
        yield self.job
        yield self.created


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return as_utc(value).isoformat()
