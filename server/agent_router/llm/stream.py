"""Transport-neutral streaming relay for the client-side Agent harness.

Both hosts of the shared Agent core open one OpenAI-compatible
``chat/completions`` stream per harness turn and relay the provider's own
``chat.completion.chunk`` events verbatim: the desktop sidecar
(``sidecar.llm.stream``) and the legacy cloud server
(``agent_router.llm_relay``).  Everything that does not depend on how a host
resolves credentials or guards outbound traffic lives here: the request body
shape, the SSE grammar repairs, the 400 compatibility retry, the error taxonomy
and the producer/consumer hand-off that cancels the paid upstream stream when
the client disconnects.

A host supplies an *opener*: a callable taking the JSON body of one attempt and
returning an async context manager that yields the streamed ``httpx.Response``.
The sidecar wraps its SSRF-guarded pool, the cloud server wraps a plain client.
Anything the opener raises that is not an ``httpx`` transport error propagates
unchanged, so host-specific policy errors keep their identity.
"""

from __future__ import annotations

import asyncio
import codecs
import json
import logging
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

STREAM_TIMEOUT = httpx.Timeout(30.0, read=300.0, write=30.0, pool=30.0)
STREAM_ACCEPT = "text/event-stream"

# Request keys the relay owns. ``extra_body`` may not override them: the model
# comes from the host's configuration and the stream shape is part of the contract.
RESERVED_BODY_KEYS = frozenset(
    {"model", "messages", "tools", "tool_choice", "stream", "stream_options"}
)
# Optional keys some OpenAI-compatible gateways reject with HTTP 400. They are
# dropped and the same target is retried once (nothing has been generated yet).
COMPAT_RETRY_KEYS = ("prompt_cache_key", "stream_options")
# Same classification as the reference client: transient means the turn may be
# retried by the caller; everything else is a configuration or request problem.
TRANSIENT_STATUSES = frozenset({408, 425, 429}) | frozenset(range(500, 600))
_ERROR_BODY_EXCERPT = 2048

StreamOpener = Callable[[dict[str, Any]], AbstractAsyncContextManager[httpx.Response]]


class LlmStreamError(Exception):
    """A stream could not be opened or was interrupted."""

    code = "llm_stream_failed"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None, retryable: bool | None = None):
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if retryable is not None:
            self.retryable = retryable


class LlmStreamUnsupportedError(LlmStreamError):
    """The configured target is not an OpenAI-compatible endpoint."""

    code = "llm_stream_provider_unsupported"

    def __init__(self, provider: str) -> None:
        super().__init__(
            f"streaming chat is only available on OpenAI-compatible slots (got {provider!r})"
        )
        self.provider = provider


class LlmStreamUpstreamError(LlmStreamError):
    """The provider answered with a non-success status before streaming."""

    code = "llm_upstream_failed"

    def __init__(self, status_code: int, excerpt: str, *, slot: str) -> None:
        super().__init__(
            f"LLM upstream responded with HTTP {status_code}",
            retryable=status_code in TRANSIENT_STATUSES,
        )
        self.status_code = status_code
        self.excerpt = excerpt
        self.slot = slot


class LlmStreamUnreachableError(LlmStreamError):
    """The provider could not be reached at all (endpoint approved, transport failed)."""

    code = "llm_upstream_unreachable"
    retryable = True


@dataclass(frozen=True)
class LlmStreamInfo:
    """What the client is told about the target that answers this turn."""

    slot: str
    model: str
    provider: str
    failed_over: bool


def build_chat_body(
    model: str,
    fields: Mapping[str, Any],
    *,
    host_extra_body: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the upstream ``/chat/completions`` body for one target.

    ``fields`` is the client's validated request; its ``extra_body`` (vendor
    thinking switches and the like) goes in first, the host's own ``extra_body``
    (deployment configuration) overrides it, and the relay-owned keys always win.
    """

    body: dict[str, Any] = {}
    client_extra = fields.get("extra_body")
    if isinstance(client_extra, Mapping):
        body.update(
            {key: value for key, value in client_extra.items() if key not in RESERVED_BODY_KEYS}
        )
    if host_extra_body:
        body.update(
            {key: value for key, value in host_extra_body.items() if key not in RESERVED_BODY_KEYS}
        )
    body["model"] = model
    body["messages"] = fields["messages"]
    tools = fields.get("tools")
    if tools:
        body["tools"] = tools
        body["tool_choice"] = fields.get("tool_choice") or "auto"
    for key in ("temperature", "max_tokens", "reasoning_effort", "prompt_cache_key"):
        value = fields.get(key)
        if value is not None:
            body[key] = value
    body["stream"] = True
    body["stream_options"] = {"include_usage": True}
    return body


def format_sse(event: str | None, data: Any) -> str:
    """Encode one SSE block; ``event`` ``None`` means a bare ``data:`` line."""

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)
    if event is None:
        return f"data: {payload}\n\n"
    return f"event: {event}\ndata: {payload}\n\n"


def completion_to_chunk(completion: Mapping[str, Any]) -> dict[str, Any]:
    """Re-shape a non-streaming completion into one ``chat.completion.chunk``.

    Some gateways ignore ``stream: true`` and answer JSON.  Instead of leaking a
    second wire shape to the client, the whole message becomes a single delta.
    """

    choices_out: list[dict[str, Any]] = []
    for index, choice in enumerate(completion.get("choices") or []):
        if not isinstance(choice, Mapping):
            continue
        message = choice.get("message")
        delta: dict[str, Any] = {}
        if isinstance(message, Mapping):
            delta = {key: value for key, value in message.items() if value is not None}
            tool_calls = delta.get("tool_calls")
            if isinstance(tool_calls, list):
                delta["tool_calls"] = [
                    {"index": position, **call}
                    for position, call in enumerate(tool_calls)
                    if isinstance(call, Mapping)
                ]
        choices_out.append(
            {
                "index": choice.get("index", index),
                "delta": delta,
                "finish_reason": choice.get("finish_reason"),
            }
        )
    chunk: dict[str, Any] = {
        "id": completion.get("id", ""),
        "object": "chat.completion.chunk",
        "created": completion.get("created", 0),
        "model": completion.get("model", ""),
        "choices": choices_out,
    }
    if completion.get("usage") is not None:
        chunk["usage"] = completion["usage"]
    return chunk


class LlmStreamSession:
    """One connected provider stream.  Close it (or use ``async with``)."""

    def __init__(
        self,
        info: LlmStreamInfo,
        response: httpx.Response,
        stack: AsyncExitStack,
    ) -> None:
        self.info = info
        self._response = response
        self._stack = stack
        self._closed = False

    async def __aenter__(self) -> LlmStreamSession:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._stack.aclose()

    async def iter_sse(self) -> AsyncIterator[str]:
        """Relay the provider body as SSE text; always terminates the stream.

        Line endings are normalised to ``\\n`` and a missing ``[DONE]`` marker is
        appended, so the client can rely on the OpenAI stream grammar even when
        a gateway is sloppy.  A transport failure mid-stream becomes an
        ``error`` event (retryable) instead of a truncated body.
        """

        if self.info.failed_over:
            yield format_sse("degraded", {"reason": "llm_backup", "slot": self.info.slot})

        content_type = self._response.headers.get("content-type", "").lower()
        if "application/json" in content_type:
            async for chunk in self._relay_json_body():
                yield chunk
            return

        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buffer = ""
        saw_done = False
        try:
            async for raw in self._response.aiter_bytes():
                buffer += decoder.decode(raw)
                buffer = buffer.replace("\r\n", "\n").replace("\r", "\n")
                while True:
                    newline = buffer.find("\n")
                    if newline < 0:
                        break
                    line = buffer[: newline + 1]
                    buffer = buffer[newline + 1 :]
                    if line.strip() == "data: [DONE]":
                        saw_done = True
                    yield line
            buffer += decoder.decode(b"", final=True)
            if buffer:
                if buffer.strip() == "data: [DONE]":
                    saw_done = True
                yield buffer + "\n"
        except httpx.HTTPError as exc:
            logger.warning(
                "LLM stream interrupted slot=%s error_type=%s",
                self.info.slot,
                type(exc).__name__,
            )
            yield format_sse(
                "error",
                {
                    "code": "llm_stream_interrupted",
                    "message": f"LLM stream interrupted: {type(exc).__name__}",
                    "retryable": True,
                    "slot": self.info.slot,
                },
            )
            return
        if not saw_done:
            yield "\ndata: [DONE]\n\n"

    async def _relay_json_body(self) -> AsyncIterator[str]:
        try:
            raw = await self._response.aread()
            completion = json.loads(raw.decode("utf-8", errors="replace"))
        except (httpx.HTTPError, ValueError) as exc:
            yield format_sse(
                "error",
                {
                    "code": "llm_stream_interrupted",
                    "message": f"LLM response was not readable: {type(exc).__name__}",
                    "retryable": True,
                    "slot": self.info.slot,
                },
            )
            return
        if not isinstance(completion, Mapping):
            yield format_sse(
                "error",
                {
                    "code": "llm_stream_interrupted",
                    "message": "LLM response was not a completion object",
                    "retryable": False,
                    "slot": self.info.slot,
                },
            )
            return
        yield format_sse(None, completion_to_chunk(completion))
        yield "data: [DONE]\n\n"


async def connect_stream(
    opener: StreamOpener,
    body: Mapping[str, Any],
    *,
    info: LlmStreamInfo,
) -> LlmStreamSession:
    """Open one stream on a target, retrying once without the optional keys on 400.

    The retry happens before any byte was generated, so it can never double a
    turn.  Transport failures become :class:`LlmStreamUnreachableError`; any
    other exception from the opener is the host's own and propagates as-is.
    """

    attempts: list[dict[str, Any]] = [dict(body)]
    if any(key in body for key in COMPAT_RETRY_KEYS):
        attempts.append({key: value for key, value in body.items() if key not in COMPAT_RETRY_KEYS})

    for attempt_index, attempt_body in enumerate(attempts):
        stack = AsyncExitStack()
        try:
            response = await stack.enter_async_context(opener(attempt_body))
        except httpx.HTTPError as exc:
            await stack.aclose()
            raise LlmStreamUnreachableError(
                f"LLM upstream unreachable: {type(exc).__name__}",
            ) from exc
        except BaseException:
            await stack.aclose()
            raise

        if 200 <= response.status_code < 300:
            return LlmStreamSession(info, response, stack)

        excerpt = await read_excerpt(response)
        await stack.aclose()
        is_last_attempt = attempt_index == len(attempts) - 1
        if response.status_code == 400 and not is_last_attempt:
            logger.info(
                "LLM upstream rejected optional stream fields slot=%s; retrying without them",
                info.slot,
            )
            continue
        raise LlmStreamUpstreamError(response.status_code, excerpt, slot=info.slot)
    raise AssertionError("connect loop terminated unexpectedly")


async def read_excerpt(response: httpx.Response) -> str:
    """Read at most a short excerpt of an error body for logs and problem context."""

    collected = bytearray()
    try:
        async for piece in response.aiter_bytes():
            collected.extend(piece)
            if len(collected) >= _ERROR_BODY_EXCERPT:
                break
    except httpx.HTTPError:
        pass
    return bytes(collected[:_ERROR_BODY_EXCERPT]).decode("utf-8", errors="replace")


_CLOSE: object = object()


class RelayChannel:
    """Hand-off between the upstream producer task and the HTTP response.

    ``connected`` resolves with the stream info once the upstream answered 2xx
    (so the route can set headers before the first chunk) or fails with the
    open error, which the host maps to its own error shape.
    """

    def __init__(self, maxsize: int = 512) -> None:
        self.queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=maxsize)
        self.connected: asyncio.Future[LlmStreamInfo] = asyncio.get_running_loop().create_future()

    def set_connected(self, info: LlmStreamInfo) -> None:
        if not self.connected.done():
            self.connected.set_result(info)

    def set_failed(self, exc: BaseException) -> None:
        if not self.connected.done():
            self.connected.set_exception(exc)

    async def put(self, chunk: str) -> None:
        await self.queue.put(chunk)

    def close(self) -> None:
        try:
            self.queue.put_nowait(_CLOSE)
        except asyncio.QueueFull:
            # A vanished consumer must never wedge producer cleanup.
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self.queue.put_nowait(_CLOSE)


async def run_relay(
    open_session: Callable[[], Awaitable[LlmStreamSession]],
    channel: RelayChannel,
) -> None:
    """Producer half: open the upstream stream and push its SSE text into ``channel``."""

    try:
        session = await open_session()
    except asyncio.CancelledError:
        raise
    except BaseException as exc:  # noqa: BLE001 - surfaced through the future
        channel.set_failed(exc)
        channel.close()
        return
    try:
        async with session:
            channel.set_connected(session.info)
            async for chunk in session.iter_sse():
                await channel.put(chunk)
    finally:
        channel.close()


async def drain_relay(
    channel: RelayChannel, producer: asyncio.Task[None]
) -> AsyncGenerator[str, None]:
    """Consumer half: yield relayed chunks; cancel the paid upstream when the client leaves."""

    try:
        while True:
            item = await channel.queue.get()
            if item is _CLOSE:
                break
            yield item
    finally:
        if not producer.done():
            producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)


__all__ = [
    "COMPAT_RETRY_KEYS",
    "LlmStreamError",
    "LlmStreamInfo",
    "LlmStreamSession",
    "LlmStreamUnreachableError",
    "LlmStreamUnsupportedError",
    "LlmStreamUpstreamError",
    "RESERVED_BODY_KEYS",
    "RelayChannel",
    "STREAM_ACCEPT",
    "STREAM_TIMEOUT",
    "StreamOpener",
    "TRANSIENT_STATUSES",
    "build_chat_body",
    "completion_to_chunk",
    "connect_stream",
    "drain_relay",
    "format_sse",
    "read_excerpt",
    "run_relay",
]
