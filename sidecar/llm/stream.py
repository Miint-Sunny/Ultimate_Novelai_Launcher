"""Streaming chat-completions relay for the client-side Agent harness.

The Agent loop lives in the client (a port of Novelai-harness's ``AgentHarness``);
the sidecar keeps the LLM credentials and opens one provider stream per turn on
the configured slot.  The provider's own ``chat.completion.chunk`` events are
relayed verbatim so the client parser can stay identical to the reference
implementation.

Failover semantics mirror :func:`sidecar.llm.client.llm_chat_text`: the backup
slot is tried only when the primary fails **before any byte was relayed**.  Once
the client has seen chunks the turn belongs to that slot; a mid-stream failure is
reported as an ``error`` event and the client decides whether to retry the turn.
"""

from __future__ import annotations

import codecs
import json
import logging
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import Any

import httpx

from backend_core.types import JsonValue

from ..config import LlmSlot, Settings
from ..infrastructure import HttpClientPool
from ..security import OutboundPolicy, OutboundPolicyError
from .client import _NOT_CONFIGURED_MSG, LLMNotConfiguredError, _slot_scope_pairs

logger = logging.getLogger(__name__)

STREAM_TIMEOUT = httpx.Timeout(30.0, read=300.0, write=30.0, pool=30.0)
STREAM_ACCEPT = "text/event-stream"
SLOT_LABELS = ("primary", "backup")

# Request keys the sidecar owns. ``extra_body`` may not override them: the model
# comes from the configured slot and the stream shape is part of the contract.
RESERVED_BODY_KEYS = frozenset(
    {"model", "messages", "tools", "tool_choice", "stream", "stream_options"}
)
# Optional keys some OpenAI-compatible gateways reject with HTTP 400. They are
# dropped and the same slot is retried once (nothing has been generated yet).
_COMPAT_RETRY_KEYS = ("prompt_cache_key", "stream_options")
# Same classification as the reference client: transient means the turn may be
# retried by the caller; everything else is a configuration or request problem.
TRANSIENT_STATUSES = frozenset({408, 425, 429}) | frozenset(range(500, 600))
_ERROR_BODY_EXCERPT = 2048


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
    """The configured slot is not an OpenAI-compatible endpoint."""

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
    """The provider could not be reached at all (DNS approved, transport failed)."""

    code = "llm_upstream_unreachable"
    retryable = True


@dataclass(frozen=True)
class LlmStreamInfo:
    """What the client is told about the slot that answers this turn."""

    slot: str
    model: str
    provider: str
    failed_over: bool


def build_chat_body(slot: LlmSlot, fields: Mapping[str, JsonValue]) -> dict[str, Any]:
    """Assemble the upstream ``/chat/completions`` body for one slot.

    ``fields`` is the client's validated request minus ``extra_body``; the
    caller-supplied ``extra_body`` (vendor thinking switches and the like) goes
    in first so the sidecar-owned keys always win.
    """

    extra = fields.get("extra_body")
    body: dict[str, Any] = {}
    if isinstance(extra, Mapping):
        body.update({key: value for key, value in extra.items() if key not in RESERVED_BODY_KEYS})
    body["model"] = slot.model
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


async def open_llm_stream(
    *,
    settings: Settings,
    fields: Mapping[str, JsonValue],
    http: HttpClientPool,
    slot: str = "auto",
    policy_factory: Callable[[str], OutboundPolicy] | None = None,
) -> LlmStreamSession:
    """Open one streaming chat completion on the configured LLM slot(s).

    ``slot`` selects ``primary``/``backup`` explicitly or ``auto`` for
    primary-with-failover.  Outbound policy rejections fail closed and are never
    retried on another credential, exactly like the buffered client.
    """

    slot_scopes = _slot_scope_pairs(settings)
    if not slot_scopes:
        raise LLMNotConfiguredError(_NOT_CONFIGURED_MSG)
    candidates = list(enumerate(slot_scopes))
    if slot == "primary":
        candidates = candidates[:1]
    elif slot == "backup":
        candidates = candidates[1:2]
        if not candidates:
            raise LLMNotConfiguredError("backup LLM slot is not configured")
    elif slot != "auto":
        raise ValueError(f"unknown LLM slot selector: {slot!r}")

    last_error: LlmStreamError | None = None
    for index, (llm_slot, network_scope, trusted_networks) in candidates:
        label = SLOT_LABELS[index] if index < len(SLOT_LABELS) else f"slot{index}"
        if llm_slot.provider != "openai":
            last_error = LlmStreamUnsupportedError(llm_slot.provider)
            continue
        policy = (
            policy_factory(network_scope)
            if policy_factory is not None
            else OutboundPolicy(network_scope, trusted_networks=trusted_networks)
        )
        failed_over = index > 0 and last_error is not None
        try:
            return await _connect(
                llm_slot,
                label,
                policy,
                fields,
                http,
                failed_over=failed_over,
            )
        except OutboundPolicyError:
            # Local endpoint validation, not an outage: never try another credential.
            raise
        except LlmStreamError as exc:
            last_error = exc
            logger.warning(
                "LLM stream slot failed slot=%s code=%s retryable=%s",
                label,
                exc.code,
                exc.retryable,
            )
            continue
    assert last_error is not None
    raise last_error


async def _connect(
    llm_slot: LlmSlot,
    label: str,
    policy: OutboundPolicy,
    fields: Mapping[str, JsonValue],
    http: HttpClientPool,
    *,
    failed_over: bool,
) -> LlmStreamSession:
    url = f"{llm_slot.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {llm_slot.api_key}",
        "Content-Type": "application/json",
        "Accept": STREAM_ACCEPT,
    }
    body = build_chat_body(llm_slot, fields)
    attempts = [body]
    if any(key in body for key in _COMPAT_RETRY_KEYS):
        attempts.append(
            {key: value for key, value in body.items() if key not in _COMPAT_RETRY_KEYS}
        )

    for attempt_index, attempt_body in enumerate(attempts):
        stack = AsyncExitStack()
        try:
            response = await stack.enter_async_context(
                http.streaming_request(
                    policy,
                    "POST",
                    url,
                    long_running=True,
                    headers=headers,
                    json=attempt_body,
                    timeout=STREAM_TIMEOUT,
                )
            )
        except OutboundPolicyError:
            await stack.aclose()
            raise
        except httpx.HTTPError as exc:
            await stack.aclose()
            raise LlmStreamUnreachableError(
                f"LLM upstream unreachable: {type(exc).__name__}",
            ) from exc

        if 200 <= response.status_code < 300:
            info = LlmStreamInfo(
                slot=label,
                model=llm_slot.model,
                provider=llm_slot.provider,
                failed_over=failed_over,
            )
            return LlmStreamSession(info, response, stack)

        excerpt = await _read_excerpt(response)
        await stack.aclose()
        is_last_attempt = attempt_index == len(attempts) - 1
        if response.status_code == 400 and not is_last_attempt:
            logger.info(
                "LLM upstream rejected optional stream fields slot=%s; retrying without them",
                label,
            )
            continue
        raise LlmStreamUpstreamError(response.status_code, excerpt, slot=label)
    raise AssertionError("connect loop terminated unexpectedly")


async def _read_excerpt(response: httpx.Response) -> str:
    collected = bytearray()
    try:
        async for piece in response.aiter_bytes():
            collected.extend(piece)
            if len(collected) >= _ERROR_BODY_EXCERPT:
                break
    except httpx.HTTPError:
        pass
    return bytes(collected[:_ERROR_BODY_EXCERPT]).decode("utf-8", errors="replace")


__all__ = [
    "LlmStreamError",
    "LlmStreamInfo",
    "LlmStreamSession",
    "LlmStreamUnreachableError",
    "LlmStreamUnsupportedError",
    "LlmStreamUpstreamError",
    "RESERVED_BODY_KEYS",
    "TRANSIENT_STATUSES",
    "build_chat_body",
    "completion_to_chunk",
    "format_sse",
    "open_llm_stream",
]
