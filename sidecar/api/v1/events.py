"""Resumable server-sent event adaptation for generation jobs."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Mapping
from typing import Any, cast

from fastapi import Request
from starlette.responses import StreamingResponse
from starlette.types import Message, Receive, Scope, Send

from backend_core.errors import AppError, ResourceNotFoundError
from backend_core.protocols import JobService

from ..models import ProblemDetails
from ..problems import app_error_problem, request_id_for
from .models import GenerationJobEventResponse
from .serialization import event_response, job_response, record_data

logger = logging.getLogger(__name__)


class SSEStreamingResponse(StreamingResponse):
    """Stream SSE with one explicit ASGI receive owner.

    Starlette's generic response races a disconnect-listener task against the body
    task.  A dedicated adapter is smaller here and guarantees that disconnect
    cancellation reaches the event generator (and its upstream watcher) without
    the task-group cancellation race seen with fast finite streams.
    """

    def __init__(self, content: Any, *, headers: Mapping[str, str] | None = None) -> None:
        super().__init__(content, media_type="text/event-stream", headers=dict(headers or {}))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": self.status_code,
                "headers": self.raw_headers,
            }
        )
        disconnect = asyncio.create_task(_wait_for_disconnect(receive))
        iterator = cast(AsyncIterator[Any], self.body_iterator.__aiter__())
        pending: asyncio.Future[Any] | None = None
        disconnected = False
        try:
            while True:
                pending = asyncio.ensure_future(anext(iterator))
                done, _ = await asyncio.wait(
                    {pending, disconnect},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if disconnect in done:
                    disconnected = True
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
                    pending = None
                    break
                try:
                    chunk = pending.result()
                except StopAsyncIteration:
                    pending = None
                    break
                pending = None
                if not isinstance(chunk, bytes):
                    chunk = str(chunk).encode(self.charset)
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            if not disconnected:
                await send({"type": "http.response.body", "body": b"", "more_body": False})
        finally:
            disconnect.cancel()
            await asyncio.gather(disconnect, return_exceptions=True)
            if pending is not None and not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            close = getattr(iterator, "aclose", None)
            if callable(close):
                closed = close()
                if inspect.isawaitable(closed):
                    await closed
        if self.background is not None:
            await self.background()


async def _wait_for_disconnect(receive: Receive) -> None:
    while True:
        message: Message = await receive()
        if message["type"] == "http.disconnect":
            return


async def generation_event_stream(
    request: Request,
    jobs: JobService,
    snapshot: Any,
    *,
    after_sequence: int = 0,
    snapshot_watermark: int = 0,
    keepalive_interval: float = 15.0,
    poll_interval: float = 0.25,
) -> AsyncGenerator[str, None]:
    """Emit a snapshot, ordered persisted events, then periodic keepalives."""

    if keepalive_interval <= 0 or poll_interval <= 0:
        raise ValueError("stream intervals must be positive")
    snapshot_response = job_response(snapshot)
    stream_cursor = max(after_sequence, snapshot_watermark)
    snapshot_data = snapshot_response.model_dump(mode="json")
    snapshot_data["event_watermark"] = snapshot_watermark
    snapshot_data["resume_sequence"] = stream_cursor
    yield _sse_chunk("snapshot", snapshot_data, event_id=str(stream_cursor))
    source = _job_event_source(
        jobs,
        snapshot_response.id,
        after_sequence=stream_cursor,
        poll_interval=poll_interval,
    )
    pending: asyncio.Future[GenerationJobEventResponse] | None = None
    try:
        # ``StreamingResponse`` owns the ASGI receive loop and cancels this
        # generator when the client disconnects. Reading ``receive`` here as well
        # races Starlette's disconnect listener and can leave a completed stream
        # waiting forever under slower/instrumented runtimes.
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(source))
            done, _ = await asyncio.wait({pending}, timeout=keepalive_interval)
            if not done:
                yield ": keepalive\n\n"
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                return
            pending = None
            yield _sse_chunk(
                event.kind,
                event.model_dump(mode="json"),
                event_id=str(event.sequence),
            )
    except AppError as exc:
        problem = app_error_problem(exc, request)
        yield _sse_chunk("error", problem.model_dump(mode="json"))
    except Exception:
        logger.exception("job event stream failed", extra={"path": request.url.path})
        problem = ProblemDetails(
            type="urn:ultimate-novelai:problem:event_stream_failed",
            title="Event stream failed",
            status=500,
            detail="the job event stream ended unexpectedly",
            request_id=request_id_for(request),
            instance=request.url.path,
            code="event_stream_failed",
            retryable=True,
        )
        yield _sse_chunk("error", problem.model_dump(mode="json"))
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await source.aclose()


async def _job_event_source(
    jobs: JobService,
    job_id: str,
    *,
    after_sequence: int,
    poll_interval: float,
) -> AsyncGenerator[GenerationJobEventResponse, None]:
    watch_events = getattr(jobs, "watch_events", None)
    if callable(watch_events):
        cursor = after_sequence
        watcher = cast(Callable[..., AsyncIterator[Any]], watch_events)
        async for record in watcher(
            job_id,
            after_sequence=after_sequence,
            poll_interval=poll_interval,
        ):
            event = event_response(record)
            # Keep the wire sequence monotonic even if a custom watcher returns
            # an already acknowledged event.
            if event.sequence <= cursor:
                continue
            cursor = event.sequence
            yield event
        return

    cursor = after_sequence
    terminal = {"succeeded", "failed", "cancelled", "interrupted"}
    while True:
        records = await jobs.list_events(job_id, after_sequence=cursor, limit=1000)
        for record in records:
            event = event_response(record)
            if event.sequence <= cursor:
                continue
            cursor = event.sequence
            yield event
        current = await jobs.get_job(job_id)
        if current is None:
            raise ResourceNotFoundError(
                "generation job was not found",
                code="job_not_found",
                details={"job_id": job_id},
            )
        status = record_data(current).get("status")
        if status in terminal and not records:
            return
        await asyncio.sleep(poll_interval)


def _sse_chunk(event: str, data: Mapping[str, Any], *, event_id: str | None = None) -> str:
    safe_event = event if re.fullmatch(r"[A-Za-z0-9_.-]+", event) else "job"
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {safe_event}")
    lines.append(f"data: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}")
    return "\n".join(lines) + "\n\n"
