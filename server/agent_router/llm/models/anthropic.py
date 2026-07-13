"""
自研 LLM 框架 —— Anthropic 适配器（替代 pydantic_ai.models.anthropic.AnthropicModel）。

POST {base_url}/v1/messages（base_url 已被 model_provider._normalize_base_url 去掉版本后缀）。
头：x-api-key + anthropic-version。system 走顶层 system（text block 数组，保留分段）。
max_tokens 是 Anthropic 必填项：取 settings.max_tokens，没有则默认 4096。

require_tool -> tool_choice {"type":"any"} / {"type":"auto"}；extra_body 可覆盖。
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..exceptions import ModelHTTPError
from ..messages import (
    BinaryContent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolDefinition,
    ToolReturnPart,
    UserPromptPart,
)
from ..result import Usage
from .base import Model, get_default_http_client

_ANTHROPIC_VERSION = "2023-06-01"
_DEFAULT_MAX_TOKENS = 4096


class AnthropicModel(Model):
    def __init__(self, model_name: str, provider) -> None:
        self.model_name = model_name
        self.provider = provider

    @property
    def _client(self) -> httpx.AsyncClient:
        return self.provider.http_client or get_default_http_client()

    # ---------- 组装 ----------

    def _user_blocks(self, content: Any) -> list[dict]:
        if isinstance(content, str):
            return [{"type": "text", "text": content}] if content else []
        if isinstance(content, BinaryContent):
            content = [content]
        blocks: list[dict] = []
        if isinstance(content, list):
            for item in content:
                if isinstance(item, BinaryContent):
                    blocks.append(
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": item.media_type,
                                "data": item.base64,
                            },
                        }
                    )
                elif item is not None and str(item):
                    blocks.append({"type": "text", "text": str(item)})
        else:
            blocks.append({"type": "text", "text": str(content)})
        return blocks

    def _build_messages(
        self, messages: list[ModelMessage], system_parts: list[SystemPromptPart]
    ) -> tuple[list[dict], list[dict]]:
        system_blocks: list[dict] = [
            {"type": "text", "text": sp.content} for sp in system_parts if sp.content
        ]
        wire: list[dict] = []

        for msg in messages:
            if isinstance(msg, ModelRequest):
                blocks: list[dict] = []
                for part in msg.parts:
                    if isinstance(part, SystemPromptPart):
                        if part.content:
                            system_blocks.append({"type": "text", "text": part.content})
                    elif isinstance(part, UserPromptPart):
                        blocks.extend(self._user_blocks(part.content))
                    elif isinstance(part, ToolReturnPart):
                        blocks.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": part.tool_call_id or part.tool_name,
                                "content": _json_content(part.content),
                            }
                        )
                    elif isinstance(part, RetryPromptPart):
                        if part.tool_name:
                            blocks.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": part.tool_call_id or part.tool_name,
                                    "content": part.content,
                                    "is_error": True,
                                }
                            )
                        else:
                            blocks.append({"type": "text", "text": part.content})
                if blocks:
                    wire.append({"role": "user", "content": blocks})
            elif isinstance(msg, ModelResponse):
                blocks = []
                for part in msg.parts:
                    if isinstance(part, TextPart):
                        if part.content:
                            blocks.append({"type": "text", "text": part.content})
                    elif isinstance(part, ToolCallPart):
                        args = part.args if isinstance(part.args, dict) else _try_json(part.args)
                        blocks.append(
                            {
                                "type": "tool_use",
                                "id": part.tool_call_id or part.tool_name,
                                "name": part.tool_name,
                                "input": args,
                            }
                        )
                    # ThinkingPart 不回灌
                if blocks:
                    wire.append({"role": "assistant", "content": blocks})

        return _merge_same_role(wire), system_blocks

    def _build_body(
        self,
        messages: list[ModelMessage],
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        settings: dict,
    ) -> dict:
        wire_messages, system_blocks = self._build_messages(messages, system_parts)
        body: dict = {
            "model": self.model_name,
            "messages": wire_messages,
            "max_tokens": settings.get("max_tokens") or _DEFAULT_MAX_TOKENS,
        }
        if system_blocks:
            body["system"] = system_blocks
        if "temperature" in settings:
            body["temperature"] = settings["temperature"]
        if tools:
            body["tools"] = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters_json_schema
                    or {"type": "object", "properties": {}},
                }
                for t in tools
            ]
            body["tool_choice"] = {"type": "any"} if require_tool else {"type": "auto"}

        extra_body = settings.get("extra_body")
        if isinstance(extra_body, dict):
            body.update(extra_body)
        return body

    # ---------- 请求 ----------

    async def request(
        self,
        messages: list[ModelMessage],
        *,
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        model_settings: dict | None = None,
    ) -> tuple[ModelResponse, Usage]:
        settings = dict(model_settings or {})
        body = self._build_body(messages, system_parts, tools, require_tool, settings)

        base = self.provider.base_url.rstrip("/")
        url = f"{base}/v1/messages"
        headers = {
            "content-type": "application/json",
            "anthropic-version": _ANTHROPIC_VERSION,
        }
        if self.provider.api_key:
            headers["x-api-key"] = self.provider.api_key

        resp = await self._client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            text = _safe_text(resp)
            raise ModelHTTPError(resp.status_code, text, body=text)

        data = resp.json()
        return _parse_anthropic_response(data)


# ============================================================
# 响应解析
# ============================================================


def _parse_anthropic_response(data: dict) -> tuple[ModelResponse, Usage]:
    parts: list = []
    for block in data.get("content") or []:
        btype = block.get("type")
        if btype == "text":
            if str(block.get("text") or "").strip():
                parts.append(TextPart(content=str(block["text"])))
        elif btype == "tool_use":
            parts.append(
                ToolCallPart(
                    tool_name=block.get("name") or "",
                    args=block.get("input") or {},
                    tool_call_id=block.get("id") or "",
                )
            )
        elif btype == "thinking":
            thought = block.get("thinking") or block.get("text") or ""
            if thought:
                parts.append(ThinkingPart(content=str(thought)))

    usage = _parse_usage(data.get("usage"))
    return ModelResponse(parts=parts), usage


def _parse_usage(raw: Any) -> Usage:
    if not isinstance(raw, dict):
        return Usage(requests=1)
    inp = int(raw.get("input_tokens") or 0)
    out = int(raw.get("output_tokens") or 0)
    return Usage(input_tokens=inp, output_tokens=out, total_tokens=inp + out, requests=1)


# ============================================================
# helpers
# ============================================================


def _merge_same_role(messages: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for m in messages:
        if merged and merged[-1].get("role") == m.get("role"):
            merged[-1]["content"].extend(m.get("content") or [])
        else:
            merged.append({"role": m.get("role"), "content": list(m.get("content") or [])})
    return merged


def _json_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False, default=_json_default)
    except Exception:
        return str(content)


def _json_default(obj: Any):
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    return str(obj)


def _try_json(s: Any) -> dict:
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s)
    except Exception:
        return {}


def _safe_text(resp: httpx.Response) -> str:
    try:
        return resp.text
    except Exception:
        return ""


__all__ = ["AnthropicModel"]
