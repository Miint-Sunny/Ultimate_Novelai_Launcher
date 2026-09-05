"""Cloud-host adapter of the streaming LLM relay: ``POST /api/agent/llm/chat``.

Same wire contract as the sidecar's ``/api/v1/agent/llm/chat`` (contract §2), so
the client-side Agent harness runs unchanged against either host.  What differs
follows from the deployment model and is written down in contract §2.5:

* the model is one of the deployment's ``MODEL_CHOICES`` (optional ``model``
  choice key; empty means ``ACTIVE_MODEL``) and there is no backup slot;
* failures before the first byte are flat JSON problems (``code`` / ``detail`` /
  ``retryable`` / ``context``) rather than the sidecar's Problem Details layer;
* the paid gate is the existing Agent one (live image quota, Bot service or
  admin) and the budget is the per-session rate limit plus a small cap on
  concurrent streams per owner, because one harness turn holds a stream open
  for as long as the model keeps talking.

Provider credentials never leave this process: the request carries no key and
the response carries no upstream URL.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import httpx
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import Field

from .access import AgentAccess
from .llm.chat_request import AgentChatRequest
from .llm.stream import (
    STREAM_ACCEPT,
    STREAM_TIMEOUT,
    LlmStreamError,
    LlmStreamInfo,
    LlmStreamSession,
    LlmStreamUnsupportedError,
    LlmStreamUpstreamError,
    RelayChannel,
    build_chat_body,
    connect_stream,
    drain_relay,
    run_relay,
)
from .model_provider import LlmStreamTarget, get_stream_target

logger = logging.getLogger("agent_router.llm_relay")

PROBLEM_MEDIA_TYPE = "application/problem+json"
# One harness runs its turns serially; a handful of parallel streams per owner
# leaves room for a second window without letting one session pin the pool.
MAX_STREAMS_PER_OWNER = 4
_STREAM_LIMITS = httpx.Limits(max_connections=32, max_keepalive_connections=8)
_PROBLEM_TITLES = {
    400: "Invalid request",
    422: "Validation failed",
    429: "Capacity exceeded",
    503: "Dependency unavailable",
}


class HostAgentChatRequest(AgentChatRequest):
    """Contract §2.1 plus the host-only ``model`` choice key (§2.5)."""

    model: str = Field(default="", max_length=256)


def problem(
    status: int,
    code: str,
    detail: str,
    *,
    retryable: bool = False,
    context: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    """Flat problem body the harness client reads: ``code``, ``detail``, ``retryable``."""

    body = {
        "type": "about:blank",
        "title": _PROBLEM_TITLES.get(status, "Error"),
        "status": status,
        "detail": detail,
        "code": code,
        "retryable": retryable,
        "context": dict(context or {}),
    }
    return JSONResponse(
        status_code=status,
        content=body,
        media_type=PROBLEM_MEDIA_TYPE,
        headers=dict(headers or {}),
    )


# ---------------------------------------------------------------------------
# Upstream clients: one per (adapter, proxy), shared across requests
# ---------------------------------------------------------------------------

_clients: dict[tuple[str, str], httpx.AsyncClient] = {}


def get_stream_client(target: LlmStreamTarget) -> httpx.AsyncClient:
    """Shared client for one target class; honours ``proxy`` for every OpenAI target."""

    from .novelai_provider import build_novelai_http_client, is_novelai_text_url

    kind = "novelai" if is_novelai_text_url(target.base_url) else "plain"
    key = (kind, target.proxy)
    client = _clients.get(key)
    if client is not None and not client.is_closed:
        return client
    if kind == "novelai":
        client = build_novelai_http_client(proxy_url=target.proxy or None)
    else:
        client = httpx.AsyncClient(
            proxy=target.proxy or None,
            timeout=STREAM_TIMEOUT,
            limits=_STREAM_LIMITS,
        )
    _clients[key] = client
    return client


# ---------------------------------------------------------------------------
# Per-owner concurrency
# ---------------------------------------------------------------------------

_active_streams: dict[str, int] = {}


def owner_key(access: AgentAccess) -> str:
    owner = access.owner_id
    if owner:
        return f"owner:{owner}"
    principal = access.principal
    return f"{principal.kind.value}:{principal.subject_id}"


def _acquire_stream(key: str) -> bool:
    active = _active_streams.get(key, 0)
    if active >= MAX_STREAMS_PER_OWNER:
        return False
    _active_streams[key] = active + 1
    return True


def _release_stream(key: str) -> None:
    remaining = _active_streams.get(key, 0) - 1
    if remaining <= 0:
        _active_streams.pop(key, None)
    else:
        _active_streams[key] = remaining


def active_stream_count(key: str) -> int:
    return _active_streams.get(key, 0)


# ---------------------------------------------------------------------------
# Opening the upstream stream
# ---------------------------------------------------------------------------


def _fields_for_target(req: HostAgentChatRequest, target: LlmStreamTarget) -> dict[str, Any]:
    """The client's fields with the registry's ``model_settings`` as defaults."""

    fields: dict[str, Any] = dict(req.upstream_fields())
    fields.pop("model", None)
    for key in ("temperature", "max_tokens"):
        if fields.get(key) is not None:
            continue
        value = target.model_settings.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            fields[key] = value
    return fields


def open_target_stream(
    target: LlmStreamTarget,
    body: Mapping[str, Any],
) -> Callable[[], Awaitable[LlmStreamSession]]:
    client = get_stream_client(target)
    url = f"{target.base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json", "Accept": STREAM_ACCEPT}
    if target.api_key:
        headers["Authorization"] = f"Bearer {target.api_key}"
    info = LlmStreamInfo(
        slot=target.key,
        model=target.model_name,
        provider=target.protocol,
        failed_over=False,
    )

    def opener(attempt: dict[str, Any]) -> Any:
        return client.stream("POST", url, headers=headers, json=attempt, timeout=STREAM_TIMEOUT)

    async def open_session() -> LlmStreamSession:
        return await connect_stream(opener, body, info=info)

    return open_session


async def _guarded_relay(
    open_session: Callable[[], Awaitable[LlmStreamSession]],
    channel: RelayChannel,
    owner: str,
) -> None:
    """Run the relay and give the owner's concurrency slot back before the task ends."""

    try:
        await run_relay(open_session, channel)
    finally:
        _release_stream(owner)


def map_open_error(exc: BaseException, *, model_key: str) -> JSONResponse:
    if isinstance(exc, LlmStreamUnsupportedError):
        return problem(503, exc.code, str(exc), context={"provider": exc.provider})
    if isinstance(exc, LlmStreamUpstreamError):
        return problem(
            503,
            exc.code,
            str(exc),
            retryable=exc.retryable,
            context={"upstream_status": exc.status_code, "slot": exc.slot},
        )
    if isinstance(exc, LlmStreamError):
        return problem(503, exc.code, str(exc), retryable=exc.retryable)
    if isinstance(exc, (ValueError, LookupError)):
        return problem(422, "invalid_agent_chat_request", str(exc))
    logger.exception("LLM stream could not be opened model=%s", model_key)
    return problem(
        503,
        "llm_stream_failed",
        f"LLM stream could not be opened: {type(exc).__name__}",
        retryable=True,
    )


async def stream_llm_chat(req: HostAgentChatRequest, access: AgentAccess) -> Response:
    """Relay one harness turn to the resolved choice; headers name the target."""

    if req.slot == "backup":
        return problem(503, "llm_not_configured", "this host has no backup LLM slot")
    try:
        target = get_stream_target(req.model)
    except LookupError as exc:
        return problem(422, "unknown_model", str(exc), context={"model": req.model})
    except ValueError as exc:
        return problem(503, "llm_not_configured", str(exc))
    if target.protocol != "openai":
        return problem(
            503,
            "llm_stream_provider_unsupported",
            "streaming chat is only available on OpenAI-compatible models "
            f"(got {target.protocol!r})",
            context={"provider": target.protocol, "model": target.key},
        )

    owner = owner_key(access)
    if not _acquire_stream(owner):
        return problem(
            429,
            "llm_stream_concurrency_exceeded",
            f"at most {MAX_STREAMS_PER_OWNER} concurrent LLM streams per user",
            retryable=True,
            headers={"Retry-After": "2"},
        )

    body = build_chat_body(
        target.model_name,
        _fields_for_target(req, target),
        host_extra_body=target.extra_body,
    )
    channel = RelayChannel()
    producer = asyncio.create_task(
        _guarded_relay(open_target_stream(target, body), channel, owner),
        name=f"agent-llm-chat-{target.key}",
    )
    try:
        info = await channel.connected
    except asyncio.CancelledError:
        producer.cancel()
        raise
    except BaseException as exc:  # noqa: BLE001 - mapped to a problem body
        await asyncio.gather(producer, return_exceptions=True)
        return map_open_error(exc, model_key=target.key)

    return StreamingResponse(
        drain_relay(channel, producer),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Llm-Slot": info.slot,
            "X-Llm-Model": info.model,
            "X-Llm-Provider": info.provider,
        },
    )


__all__ = [
    "MAX_STREAMS_PER_OWNER",
    "HostAgentChatRequest",
    "active_stream_count",
    "get_stream_client",
    "map_open_error",
    "open_target_stream",
    "owner_key",
    "problem",
    "stream_llm_chat",
]
