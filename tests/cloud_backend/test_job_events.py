from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any

import pytest

from cloud_backend.capabilities import HmacJobCapabilityTokens
from cloud_backend.errors import InvalidRequestError
from cloud_backend.identity import Principal, ResourceOwner
from cloud_backend.job_events import (
    AuthenticatedJobEventWebSocket,
    JobEventRecord,
    JobEventSubscriptionSet,
    WebSocketServeResult,
)

KEY_MATERIAL = bytes(range(32))


@dataclass(frozen=True)
class Event:
    job_id: str
    sequence: int

    def to_dict(self) -> Mapping[str, Any]:
        return {"job_id": self.job_id, "sequence": self.sequence, "kind": "progress"}


class Source:
    def __init__(self, owner: ResourceOwner | None, events: list[JobEventRecord]) -> None:
        self.owner = owner
        self.events = events

    async def get_job_owner(self, job_id: str) -> ResourceOwner | None:
        return self.owner

    async def watch_events(
        self, job_id: str, *, after_sequence: int = 0
    ) -> AsyncIterator[JobEventRecord]:
        for event in self.events:
            if event.to_dict()["sequence"] > after_sequence:
                yield event


class Socket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent: list[dict[str, Any]] = []
        self.closed: tuple[int, str | None] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, data: Mapping[str, Any]) -> None:
        self.sent.append(dict(data))

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason)


class FailingCloseSocket(Socket):
    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        raise RuntimeError("socket disappeared")


class FailingSource(Source):
    def __init__(self, owner: ResourceOwner, error: BaseException) -> None:
        super().__init__(owner, [])
        self.error = error

    async def watch_events(
        self, job_id: str, *, after_sequence: int = 0
    ) -> AsyncIterator[JobEventRecord]:
        raise self.error
        yield  # pragma: no cover - makes this an async generator


class LiveSource:
    def __init__(self) -> None:
        self.queues: dict[str, asyncio.Queue[JobEventRecord | None]] = {}
        self.started = 0
        self.stopped = 0

    async def get_job_owner(self, job_id: str) -> ResourceOwner | None:
        return ResourceOwner("tenant-a", "user-1")

    async def watch_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
    ) -> AsyncIterator[JobEventRecord]:
        self.started += 1
        queue = self.queues.setdefault(job_id, asyncio.Queue())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    return
                if int(event.to_dict()["sequence"]) > after_sequence:
                    yield event
        finally:
            self.stopped += 1


def _capabilities() -> HmacJobCapabilityTokens:
    return HmacJobCapabilityTokens({"primary": KEY_MATERIAL}, active_key_id="primary")


def _bearer(capabilities: HmacJobCapabilityTokens) -> str:
    return capabilities.issue(
        Principal.user("user-1", "tenant-a"),
        job_id="job-1",
        resource=ResourceOwner("tenant-a", "user-1"),
    )


@pytest.mark.asyncio
async def test_valid_capability_streams_only_authenticated_job_events() -> None:
    capabilities = _capabilities()
    socket = Socket()
    adapter = AuthenticatedJobEventWebSocket(
        capabilities,
        Source(ResourceOwner("tenant-a", "user-1"), [Event("job-1", 2)]),
    )

    result = await adapter.serve(
        socket,
        job_id="job-1",
        capability_token=_bearer(capabilities),
        after_sequence=1,
    )
    assert result is WebSocketServeResult.COMPLETED
    assert socket.accepted is True
    assert socket.sent[0]["type"] == "job_events_ready"
    assert socket.sent[1]["event"] == {"job_id": "job-1", "sequence": 2, "kind": "progress"}
    assert socket.closed == (1000, None)


@pytest.mark.asyncio
async def test_invalid_capability_is_rejected_before_accept() -> None:
    capabilities = _capabilities()
    socket = Socket()
    adapter = AuthenticatedJobEventWebSocket(capabilities, Source(None, []))

    result = await adapter.serve(socket, job_id="job-1", capability_token=str(12345))
    assert result is WebSocketServeResult.AUTHENTICATION_REJECTED
    assert socket.accepted is False
    assert socket.sent == []
    assert socket.closed == (4401, "authentication required")


@pytest.mark.asyncio
async def test_current_owner_mismatch_is_obscured_as_not_found() -> None:
    capabilities = _capabilities()
    socket = Socket()
    adapter = AuthenticatedJobEventWebSocket(
        capabilities, Source(ResourceOwner("tenant-a", "user-2"), [])
    )

    result = await adapter.serve(socket, job_id="job-1", capability_token=_bearer(capabilities))
    assert result is WebSocketServeResult.NOT_FOUND
    assert socket.accepted is False
    assert socket.closed == (4404, "not found")


@pytest.mark.asyncio
async def test_source_cannot_send_an_event_from_another_job() -> None:
    capabilities = _capabilities()
    socket = Socket()
    adapter = AuthenticatedJobEventWebSocket(
        capabilities,
        Source(ResourceOwner("tenant-a", "user-1"), [Event("job-2", 1)]),
    )

    result = await adapter.serve(socket, job_id="job-1", capability_token=_bearer(capabilities))
    assert result is WebSocketServeResult.SOURCE_VIOLATION
    assert len(socket.sent) == 1
    assert socket.closed == (1011, "event stream unavailable")


@pytest.mark.asyncio
@pytest.mark.parametrize("after_sequence", [-1, True, "1"])
async def test_invalid_replay_cursor_is_rejected(after_sequence) -> None:
    capabilities = _capabilities()
    socket = Socket()
    adapter = AuthenticatedJobEventWebSocket(capabilities, Source(None, []))

    result = await adapter.serve(
        socket,
        job_id="job-1",
        capability_token=_bearer(capabilities),
        after_sequence=after_sequence,
    )
    assert result is WebSocketServeResult.INVALID_REQUEST
    assert socket.accepted is False
    assert socket.closed == (4400, "invalid request")


@pytest.mark.asyncio
async def test_source_cancellation_propagates_without_relabeling() -> None:
    capabilities = _capabilities()
    adapter = AuthenticatedJobEventWebSocket(
        capabilities,
        FailingSource(ResourceOwner("tenant-a", "user-1"), asyncio.CancelledError()),
    )
    with pytest.raises(asyncio.CancelledError):
        await adapter.serve(
            Socket(),
            job_id="job-1",
            capability_token=_bearer(capabilities),
        )


@pytest.mark.asyncio
async def test_unexpected_source_error_closes_and_propagates() -> None:
    capabilities = _capabilities()
    socket = Socket()
    adapter = AuthenticatedJobEventWebSocket(
        capabilities,
        FailingSource(ResourceOwner("tenant-a", "user-1"), RuntimeError("database failed")),
    )
    with pytest.raises(RuntimeError, match="database failed"):
        await adapter.serve(
            socket,
            job_id="job-1",
            capability_token=_bearer(capabilities),
        )
    assert socket.closed == (1011, "event stream unavailable")


@pytest.mark.asyncio
async def test_close_failure_does_not_replace_completion() -> None:
    capabilities = _capabilities()
    socket = FailingCloseSocket()
    adapter = AuthenticatedJobEventWebSocket(
        capabilities,
        Source(ResourceOwner("tenant-a", "user-1"), []),
    )
    result = await adapter.serve(
        socket,
        job_id="job-1",
        capability_token=_bearer(capabilities),
    )
    assert result is WebSocketServeResult.COMPLETED


@pytest.mark.asyncio
async def test_subscription_set_replaces_and_cancels_watchers_without_leaks() -> None:
    source = LiveSource()
    sent: list[tuple[str, Mapping[str, Any]]] = []

    async def send(job_id: str, event: Mapping[str, Any]) -> None:
        sent.append((job_id, event))

    subscriptions = JobEventSubscriptionSet(source, send)
    await subscriptions.replace("job-1")
    await asyncio.sleep(0)
    assert source.started == 1

    await subscriptions.replace("job-1", after_sequence=1)
    await asyncio.sleep(0)
    assert source.started == 2
    assert source.stopped == 1

    await source.queues["job-1"].put(Event("job-1", 2))
    for _ in range(10):
        if sent:
            break
        await asyncio.sleep(0)
    assert sent == [("job-1", {"job_id": "job-1", "sequence": 2, "kind": "progress"})]

    assert await subscriptions.unsubscribe("job-1") is True
    assert subscriptions.active_job_ids == frozenset()
    assert source.stopped == 2
    assert await subscriptions.unsubscribe("job-1") is False


@pytest.mark.asyncio
async def test_subscription_set_rejects_invalid_cursor_and_closes_all() -> None:
    source = LiveSource()

    async def send(job_id: str, event: Mapping[str, Any]) -> None:
        return None

    subscriptions = JobEventSubscriptionSet(source, send)
    with pytest.raises(InvalidRequestError):
        await subscriptions.replace("job-1", after_sequence=True)

    await subscriptions.replace("job-1")
    await subscriptions.replace("job-2")
    await asyncio.sleep(0)
    assert subscriptions.active_job_ids == frozenset({"job-1", "job-2"})
    await subscriptions.close()
    assert subscriptions.active_job_ids == frozenset()
    assert source.stopped == 2


@pytest.mark.asyncio
async def test_subscription_set_reports_source_boundary_errors_and_discards_completion() -> None:
    errors: list[str] = []

    async def send(job_id: str, event: Mapping[str, Any]) -> None:
        return None

    async def on_error(job_id: str) -> None:
        errors.append(job_id)

    subscriptions = JobEventSubscriptionSet(
        Source(ResourceOwner("tenant-a", "user-1"), [Event("other-job", 1)]),
        send,
        on_error=on_error,
    )
    await subscriptions.replace("job-1")
    for _ in range(10):
        if not subscriptions.active_job_ids:
            break
        await asyncio.sleep(0)
    assert errors == ["job-1"]
    assert subscriptions.active_job_ids == frozenset()


@pytest.mark.asyncio
async def test_subscription_set_contains_error_callback_failure() -> None:
    async def failed_send(job_id: str, event: Mapping[str, Any]) -> None:
        raise RuntimeError("socket failed")

    async def failed_error(job_id: str) -> None:
        raise RuntimeError("socket still failed")

    subscriptions = JobEventSubscriptionSet(
        Source(ResourceOwner("tenant-a", "user-1"), [Event("job-1", 1)]),
        failed_send,
        on_error=failed_error,
    )
    await subscriptions.replace("job-1")
    for _ in range(10):
        if not subscriptions.active_job_ids:
            break
        await asyncio.sleep(0)
    assert subscriptions.active_job_ids == frozenset()
