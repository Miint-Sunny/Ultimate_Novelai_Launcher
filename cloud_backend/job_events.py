"""Framework-neutral authenticated WebSocket core for persisted JobEvent streams."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from .capabilities import JobCapabilityVerifier
from .errors import (
    EventSourceViolationError,
    InvalidCapabilityError,
    InvalidRequestError,
    ResourceNotFoundError,
)
from .identity import ResourceAccessPolicy, ResourceOwner


@runtime_checkable
class JobEventRecord(Protocol):
    @property
    def job_id(self) -> str: ...

    def to_dict(self) -> Mapping[str, Any]: ...


@runtime_checkable
class JobEventSource(Protocol):
    async def get_job_owner(self, job_id: str) -> ResourceOwner | None: ...

    def watch_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
    ) -> AsyncIterator[JobEventRecord]: ...


@runtime_checkable
class WebSocketPort(Protocol):
    """Small subset implemented by FastAPI/Starlette and test adapters."""

    async def accept(self) -> None: ...

    async def send_json(self, data: Mapping[str, Any]) -> None: ...

    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...


class WebSocketServeResult(str, Enum):
    COMPLETED = "completed"
    INVALID_REQUEST = "invalid_request"
    AUTHENTICATION_REJECTED = "authentication_rejected"
    NOT_FOUND = "not_found"
    SOURCE_VIOLATION = "source_violation"


class AuthenticatedJobEventWebSocket:
    """Authenticate before accept, recheck ownership, then stream one job only."""

    def __init__(
        self,
        verifier: JobCapabilityVerifier,
        source: JobEventSource,
        *,
        policy: ResourceAccessPolicy | None = None,
    ) -> None:
        self._verifier = verifier
        self._source = source
        self._policy = policy or ResourceAccessPolicy()

    async def serve(
        self,
        socket: WebSocketPort,
        *,
        job_id: str,
        capability_token: str,
        after_sequence: int = 0,
    ) -> WebSocketServeResult:
        if (
            not isinstance(after_sequence, int)
            or isinstance(after_sequence, bool)
            or after_sequence < 0
        ):
            await _safe_close(socket, 4400, "invalid request")
            return WebSocketServeResult.INVALID_REQUEST

        try:
            capability = self._verifier.verify(
                capability_token,
                expected_job_id=job_id,
            )
        except InvalidCapabilityError:
            await _safe_close(socket, 4401, "authentication required")
            return WebSocketServeResult.AUTHENTICATION_REJECTED

        owner = await self._source.get_job_owner(job_id)
        try:
            if owner is None or owner != capability.resource:
                raise ResourceNotFoundError()
            self._policy.require_access(capability.actor, owner)
        except ResourceNotFoundError:
            await _safe_close(socket, 4404, "not found")
            return WebSocketServeResult.NOT_FOUND

        await socket.accept()
        await socket.send_json(
            {
                "type": "job_events_ready",
                "job_id": job_id,
                "after_sequence": after_sequence,
            }
        )
        try:
            async for event in self._source.watch_events(
                job_id,
                after_sequence=after_sequence,
            ):
                payload = dict(event.to_dict())
                if event.job_id != job_id or payload.get("job_id") != job_id:
                    raise EventSourceViolationError("event source crossed a job boundary")
                await socket.send_json({"type": "job_event", "event": payload})
        except EventSourceViolationError:
            await _safe_close(socket, 1011, "event stream unavailable")
            return WebSocketServeResult.SOURCE_VIOLATION
        except asyncio.CancelledError:
            raise
        except Exception:
            await _safe_close(socket, 1011, "event stream unavailable")
            raise

        await _safe_close(socket, 1000, None)
        return WebSocketServeResult.COMPLETED


class JobEventSubscriptionSet:
    """Own replaceable per-job watcher tasks for one authenticated transport."""

    def __init__(
        self,
        source: JobEventSource,
        send_event: Callable[[str, Mapping[str, Any]], Awaitable[None]],
        *,
        on_error: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self._source = source
        self._send_event = send_event
        self._on_error = on_error
        self._tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def active_job_ids(self) -> frozenset[str]:
        return frozenset(self._tasks)

    async def replace(self, job_id: str, *, after_sequence: int = 0) -> None:
        if (
            not isinstance(job_id, str)
            or not job_id
            or not isinstance(after_sequence, int)
            or isinstance(after_sequence, bool)
            or after_sequence < 0
        ):
            raise InvalidRequestError("job event subscription is invalid")
        await self.unsubscribe(job_id)
        task = asyncio.create_task(
            self._watch(job_id, after_sequence=after_sequence),
            name=f"job-events:{job_id}",
        )
        self._tasks[job_id] = task
        task.add_done_callback(lambda completed: self._discard(job_id, completed))

    async def unsubscribe(self, job_id: str) -> bool:
        task = self._tasks.pop(job_id, None)
        if task is None:
            return False
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return True

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _watch(self, job_id: str, *, after_sequence: int) -> None:
        try:
            async for event in self._source.watch_events(
                job_id,
                after_sequence=after_sequence,
            ):
                payload = dict(event.to_dict())
                if event.job_id != job_id or payload.get("job_id") != job_id:
                    raise EventSourceViolationError("event source crossed a job boundary")
                await self._send_event(job_id, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            if self._on_error is not None:
                try:
                    await self._on_error(job_id)
                except Exception:
                    return

    def _discard(self, job_id: str, completed: asyncio.Task[None]) -> None:
        if self._tasks.get(job_id) is completed:
            self._tasks.pop(job_id, None)


async def _safe_close(socket: WebSocketPort, code: int, reason: str | None) -> None:
    try:
        await socket.close(code=code, reason=reason)
    except Exception:
        # A client may disappear between the final send and close.  Authentication
        # and event-source failures must not be replaced by a transport exception.
        return
