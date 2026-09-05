"""Canonical Agent transport: the streaming LLM relay for the client-side harness."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Request

from backend_core.errors import (
    AppError,
    DependencyUnavailableError,
    InvalidArgumentError,
    RuntimeNotReadyError,
)
from sidecar.config import Settings
from sidecar.llm.client import LLMNotConfiguredError
from sidecar.llm.stream import (
    LlmStreamError,
    LlmStreamSession,
    LlmStreamUnsupportedError,
    LlmStreamUpstreamError,
    RelayChannel,
    drain_relay,
    open_llm_stream,
    run_relay,
)
from sidecar.runtime import AppRuntime
from sidecar.security import OutboundPolicyError

from ..dependencies import authorize_request, map_security_error, resolve_runtime
from ..problems import ProblemDetailsRoute, request_id_for
from .events import SSEStreamingResponse
from .models import AgentChatRequest

logger = logging.getLogger(__name__)


def _map_open_error(exc: BaseException) -> AppError:
    if isinstance(exc, AppError):
        return exc
    if isinstance(exc, LLMNotConfiguredError):
        return DependencyUnavailableError(
            str(exc),
            code="llm_not_configured",
            retryable=False,
        )
    if isinstance(exc, LlmStreamUnsupportedError):
        return DependencyUnavailableError(
            str(exc),
            code=exc.code,
            retryable=False,
            details={"provider": exc.provider},
        )
    if isinstance(exc, LlmStreamUpstreamError):
        return DependencyUnavailableError(
            str(exc),
            code=exc.code,
            retryable=exc.retryable,
            details={"upstream_status": exc.status_code, "slot": exc.slot},
        )
    if isinstance(exc, LlmStreamError):
        return DependencyUnavailableError(str(exc), code=exc.code, retryable=exc.retryable)
    if isinstance(exc, OutboundPolicyError):
        mapped = map_security_error(exc)
        if mapped is not None:
            return mapped
        return InvalidArgumentError(str(exc), code="llm_endpoint_rejected")
    if isinstance(exc, ValueError):
        return InvalidArgumentError(str(exc), code="invalid_agent_chat_request")
    return DependencyUnavailableError(
        f"LLM stream could not be opened: {type(exc).__name__}",
        code="llm_stream_failed",
        retryable=True,
    )


def create_agent_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/agent",
        tags=["v1-agent"],
        route_class=ProblemDetailsRoute,
    )

    @router.post(
        "/llm/chat",
        response_model=None,
        responses={
            200: {
                "description": (
                    "OpenAI chat.completion.chunk events relayed from the configured "
                    "LLM slot, terminated by `data: [DONE]`; `degraded` and `error` "
                    "events carry sidecar-side signals"
                ),
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            }
        },
    )
    async def stream_llm_chat(body: AgentChatRequest, request: Request) -> SSEStreamingResponse:
        """把一次对话轮次转发到已配置的 LLM 槽位,原样回传流式 chunk。

        密钥不出 sidecar;主槽位在发出任何字节前失败才切备用槽位(并先发
        ``degraded`` 事件);流中断以 ``error`` 事件收尾,由客户端决定是否重试。
        """
        current = resolve_runtime(request, runtime)
        current.assert_ready()
        await authorize_request(current, request)
        http_pool = getattr(current, "http", None)
        if http_pool is None:
            raise DependencyUnavailableError(
                "HTTP client pool is not configured",
                code="http_pool_unavailable",
            )
        supervisor = getattr(current, "tasks", None)
        if supervisor is None or not callable(getattr(supervisor, "create_task", None)):
            raise DependencyUnavailableError(
                "task supervisor is not configured",
                code="task_supervisor_unavailable",
            )
        settings = _current_settings(current)

        async def open_session() -> LlmStreamSession:
            return await open_llm_stream(
                settings=settings,
                fields=body.upstream_fields(),
                http=http_pool,
                slot=body.slot,
            )

        channel = RelayChannel()
        request_id = request_id_for(request)
        try:
            producer = supervisor.create_task(
                run_relay(open_session, channel),
                name=f"agent-llm-chat-{request_id}",
                paid=True,
            )
        except RuntimeNotReadyError:
            raise
        try:
            info = await channel.connected
        except asyncio.CancelledError:
            producer.cancel()
            raise
        except BaseException as exc:  # noqa: BLE001 - mapped to Problem Details
            await asyncio.gather(producer, return_exceptions=True)
            raise _map_open_error(exc) from exc

        return SSEStreamingResponse(
            drain_relay(channel, producer),
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Llm-Slot": info.slot,
                "X-Llm-Model": info.model,
                "X-Llm-Provider": info.provider,
            },
        )

    return router


def _current_settings(runtime: AppRuntime) -> Settings:
    value = getattr(runtime.settings, "current", runtime.settings)
    if not isinstance(value, Settings):
        raise DependencyUnavailableError(
            "settings store is not configured",
            code="settings_store_unavailable",
        )
    return value


router = create_agent_router()

__all__ = ["create_agent_router", "router"]
