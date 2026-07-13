"""
自研 LLM 框架 —— Model 抽象基类（替代 pydantic_ai.models.Model）。

Model.request：把「中性消息列表 + system 段 + 工具定义 + 设置」翻成各家 wire 格式发出去，
再把响应解析回中性的 ModelResponse（parts: TextPart / ThinkingPart / ToolCallPart）。

约定：
    - messages 只含对话（ModelRequest/ModelResponse），**不含 system**；
      system 单独从 system_parts 传。
    - require_tool=True 时强制模型这一轮必须调用某个工具（native 结构化输出靠它逼出 final_result）；
      各 provider 映射到自家 tool_choice（OpenAI "required" / Gemini ANY / Anthropic any），
      且允许 model_settings["extra_body"]["tool_choice"] 覆盖（DeepSeek thinking 需要 "auto"）。
    - HTTP 非 2xx -> 抛 ModelHTTPError(status_code=...)（router 据 status_code 判瞬时重试）。
    - 网络层异常（httpx.TimeoutException/ConnectError...）原样上抛（router 据异常类名判瞬时）。
"""

from __future__ import annotations

import abc
from collections.abc import Iterable

import httpx

from ..messages import (
    ModelMessage,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ToolCallPart,
    ToolDefinition,
)
from ..result import Usage

# 共享默认 httpx client（无自定义 transport 的直连场景复用一个连接池）
_DEFAULT_CLIENT: httpx.AsyncClient | None = None


def get_default_http_client() -> httpx.AsyncClient:
    global _DEFAULT_CLIENT
    if _DEFAULT_CLIENT is None or _DEFAULT_CLIENT.is_closed:
        _DEFAULT_CLIENT = httpx.AsyncClient(timeout=httpx.Timeout(120.0))
    return _DEFAULT_CLIENT


def has_usable_terminal_part(parts: Iterable[object]) -> bool:
    """Return whether a provider response can advance or finish an Agent turn.

    Thinking is supplemental metadata, not a terminal response. A response is
    usable only when it contains non-blank assistant text or a named tool call.
    """

    return any(
        (
            isinstance(part, TextPart)
            and isinstance(part.content, str)
            and bool(part.content.strip())
        )
        or (
            isinstance(part, ToolCallPart)
            and isinstance(part.tool_name, str)
            and bool(part.tool_name.strip())
        )
        for part in parts
    )


class Model(abc.ABC):
    """LLM 后端抽象。一个实例绑定一个真实模型名 + 一个 provider 连接。"""

    model_name: str

    @abc.abstractmethod
    async def request(
        self,
        messages: list[ModelMessage],
        *,
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        model_settings: dict | None = None,
    ) -> tuple[ModelResponse, Usage]:
        """发一轮请求，返回（解析后的模型响应, 本次用量）。"""
        raise NotImplementedError


__all__ = ["Model", "get_default_http_client", "has_usable_terminal_part", "Usage"]
