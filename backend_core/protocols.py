"""Structural interfaces at the application boundary.

Implementations may live in SQLite adapters, workers, OS security modules, or test
fakes.  Keeping these as Protocols prevents the runtime and API layer from importing
concrete infrastructure.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from .types import JsonValue


@runtime_checkable
class SerializableRecord(Protocol):
    def to_dict(self) -> Mapping[str, Any]: ...


class JobCreateResultLike(Protocol):
    @property
    def job(self) -> SerializableRecord: ...

    @property
    def created(self) -> bool: ...


@runtime_checkable
class JobService(Protocol):
    """Queue operations needed by transports and process supervisors."""

    async def initialize(self) -> None: ...

    async def create_job(
        self,
        payload: Mapping[str, JsonValue],
        *,
        idempotency_key: str | None = None,
        job_id: str | None = None,
    ) -> JobCreateResultLike: ...

    async def list_jobs(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        statuses: Iterable[Any] | None = None,
    ) -> Sequence[SerializableRecord]: ...

    async def get_job(self, job_id: str) -> SerializableRecord | None: ...

    async def cancel_job(
        self, job_id: str, reason: str | None = None
    ) -> SerializableRecord | None: ...

    async def list_events(
        self, job_id: str, *, after_sequence: int = 0, limit: int = 1000
    ) -> Sequence[SerializableRecord]: ...


@runtime_checkable
class JobEventWatchService(Protocol):
    """Optional push-style job event capability used by streaming transports."""

    def watch_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
        poll_interval: float = 0.25,
    ) -> AsyncIterator[SerializableRecord]: ...


@runtime_checkable
class JobEventSnapshotService(Protocol):
    """Atomically read a job snapshot and its persisted event watermark."""

    async def snapshot_with_watermark(
        self,
        job_id: str,
    ) -> tuple[SerializableRecord, int]: ...


@runtime_checkable
class RequestAuthenticator(Protocol):
    """Minimal shape implemented by process-local authentication managers."""

    def require(
        self,
        headers: Mapping[str, str] | None = None,
        *,
        authorization: str | None = None,
        x_sidecar_auth: str | None = None,
    ) -> str: ...


@runtime_checkable
class HealthCheck(Protocol):
    async def check(self) -> bool: ...


@runtime_checkable
class LifecycleResource(Protocol):
    """Preferred lifecycle shape; the runtime also adapts common legacy names."""

    async def start(self) -> None: ...

    async def stop(self) -> None: ...
