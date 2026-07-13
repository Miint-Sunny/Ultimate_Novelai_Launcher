"""Transport-neutral records for persisted legacy cloud jobs and events."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from backend_core.jobs import JobStatus

from .identity import ResourceOwner


@dataclass(frozen=True)
class CloudJob:
    id: str
    resource: ResourceOwner
    status: JobStatus
    request_hash: str
    payload: Mapping[str, Any]
    idempotency_key: str | None
    quota_reservation_id: str | None
    cost_units: int
    provider_attempted: bool
    cost_committed: bool
    quota_settled: bool
    result: Mapping[str, Any] | None
    error: str | None
    step: int
    total_steps: int
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None

    @property
    def terminal(self) -> bool:
        return self.status in {
            JobStatus.SUCCEEDED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
            JobStatus.INTERRUPTED,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tenant_id": self.resource.tenant_id,
            "owner_id": self.resource.owner_id,
            "status": self.status.value,
            "request_hash": self.request_hash,
            "payload": dict(self.payload),
            "idempotency_key": self.idempotency_key,
            "quota_reservation_id": self.quota_reservation_id,
            "cost_units": self.cost_units,
            "provider_attempted": self.provider_attempted,
            "cost_committed": self.cost_committed,
            "quota_settled": self.quota_settled,
            "result": dict(self.result) if self.result is not None else None,
            "error": self.error,
            "step": self.step,
            "total_steps": self.total_steps,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


@dataclass(frozen=True)
class CloudJobEvent:
    job_id: str
    sequence: int
    kind: str
    status: JobStatus
    created_at: datetime
    data: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "sequence": self.sequence,
            "kind": self.kind,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "data": dict(self.data),
        }


@dataclass(frozen=True)
class CloudJobCreateResult:
    job: CloudJob
    created: bool
