"""Sidecar host of the streaming chat-completions relay.

The Agent loop lives in the client (a port of Novelai-harness's ``AgentHarness``);
the sidecar keeps the LLM credentials and opens one provider stream per turn on
the configured slot.  The relay itself (body shape, SSE repairs, compatibility
retry, producer/consumer hand-off) is the shared
:mod:`server.agent_router.llm.stream`; this module adds what only the sidecar
knows: the primary/backup slots, the SSRF outbound policy and the guarded
client pool.

Failover semantics mirror :func:`sidecar.llm.client.llm_chat_text`: the backup
slot is tried only when the primary fails **before any byte was relayed**.  Once
the client has seen chunks the turn belongs to that slot; a mid-stream failure is
reported as an ``error`` event and the client decides whether to retry the turn.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

from backend_core.types import JsonValue
from server.agent_router.llm.stream import (
    RESERVED_BODY_KEYS,
    STREAM_ACCEPT,
    STREAM_TIMEOUT,
    TRANSIENT_STATUSES,
    LlmStreamError,
    LlmStreamInfo,
    LlmStreamSession,
    LlmStreamUnreachableError,
    LlmStreamUnsupportedError,
    LlmStreamUpstreamError,
    RelayChannel,
    completion_to_chunk,
    connect_stream,
    drain_relay,
    format_sse,
    run_relay,
)
from server.agent_router.llm.stream import build_chat_body as _build_shared_chat_body

from ..config import LlmSlot, Settings
from ..infrastructure import HttpClientPool
from ..security import OutboundPolicy
from .client import _NOT_CONFIGURED_MSG, LLMNotConfiguredError, _slot_scope_pairs

logger = logging.getLogger(__name__)

SLOT_LABELS = ("primary", "backup")


def build_chat_body(slot: LlmSlot, fields: Mapping[str, JsonValue]) -> dict[str, Any]:
    """Assemble the upstream body for one sidecar slot (the slot owns the model)."""

    return _build_shared_chat_body(slot.model, fields)


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
        except LlmStreamError as exc:
            last_error = exc
            logger.warning(
                "LLM stream slot failed slot=%s code=%s retryable=%s",
                label,
                exc.code,
                exc.retryable,
            )
            continue
        # OutboundPolicyError is local endpoint validation, not an outage: the
        # shared connector re-raises it unchanged and no other credential is tried.
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

    def opener(body: dict[str, Any]) -> Any:
        return http.streaming_request(
            policy,
            "POST",
            url,
            long_running=True,
            headers=headers,
            json=body,
            timeout=STREAM_TIMEOUT,
        )

    info = LlmStreamInfo(
        slot=label,
        model=llm_slot.model,
        provider=llm_slot.provider,
        failed_over=failed_over,
    )
    return await connect_stream(opener, build_chat_body(llm_slot, fields), info=info)


__all__ = [
    "LlmStreamError",
    "LlmStreamInfo",
    "LlmStreamSession",
    "LlmStreamUnreachableError",
    "LlmStreamUnsupportedError",
    "LlmStreamUpstreamError",
    "RESERVED_BODY_KEYS",
    "RelayChannel",
    "SLOT_LABELS",
    "STREAM_ACCEPT",
    "STREAM_TIMEOUT",
    "TRANSIENT_STATUSES",
    "build_chat_body",
    "completion_to_chunk",
    "drain_relay",
    "format_sse",
    "open_llm_stream",
    "run_relay",
]
