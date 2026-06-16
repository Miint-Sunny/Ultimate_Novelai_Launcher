"""
自研 LLM 框架 —— OpenAI 兼容适配器（替代 pydantic_ai.models.openai.OpenAIModel）。

POST {base_url}/chat/completions（走 provider.http_client，没有则用共享默认 client）。
所有请求体保持**标准 OpenAI /chat/completions 形态**（messages[]/tools[]/tool_choice/stream），
这样 novelai_provider 的适配 transport（拦 /chat/completions、拍平 content、剥 tools、伪造非流式响应）
仍能正常拦截工作。

ModelSettings 消费：
    temperature           -> body["temperature"]
    max_tokens            -> body["max_tokens"]
    parallel_tool_calls   -> body["parallel_tool_calls"]
    extra_body            -> **最后整体并入 body**（覆盖计算出的字段，含 tool_choice / thinking）

tool_choice：extra_body 覆盖优先；否则有工具时 require_tool? "required" : "auto"。
strict 工具：转成 OpenAI strict（additionalProperties:false + required=全字段 + 可选字段 nullable）。
"""
from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from ..messages import (
    ModelMessage, ModelRequest, ModelResponse,
    SystemPromptPart, UserPromptPart, ToolReturnPart, RetryPromptPart,
    TextPart, ThinkingPart, ToolCallPart, ToolDefinition, BinaryContent,
)
from ..exceptions import ModelHTTPError
from ..result import Usage
from .base import Model, get_default_http_client


# ============================================================
# strict schema 转换
# ============================================================

def _make_nullable(sub: dict) -> dict:
    sub = dict(sub)
    if "type" in sub:
        t = sub["type"]
        if isinstance(t, str) and t != "null":
            sub["type"] = [t, "null"]
        elif isinstance(t, list) and "null" not in t:
            sub["type"] = [*t, "null"]
    elif "anyOf" in sub and isinstance(sub["anyOf"], list):
        if not any(isinstance(x, dict) and x.get("type") == "null" for x in sub["anyOf"]):
            sub["anyOf"] = [*sub["anyOf"], {"type": "null"}]
    return sub


def _to_openai_strict(schema: dict) -> dict:
    """递归把对象 schema 转成 OpenAI strict 形态（仅对「带 properties 的对象」生效）。"""
    if not isinstance(schema, dict):
        return schema
    node = dict(schema)
    if node.get("type") == "object" and isinstance(node.get("properties"), dict):
        props = node["properties"]
        orig_required = set(node.get("required", []) or [])
        new_props: dict[str, Any] = {}
        for name, sub in props.items():
            sub_strict = _to_openai_strict(sub)
            if name not in orig_required:
                sub_strict = _make_nullable(sub_strict)
            new_props[name] = sub_strict
        node["properties"] = new_props
        node["required"] = list(props.keys())
        node["additionalProperties"] = False
    if node.get("type") == "array" and isinstance(node.get("items"), dict):
        node["items"] = _to_openai_strict(node["items"])
    return node


def _to_openai_scalar_params(schema: dict, *, _root: bool = True) -> dict:
    """
    Some OpenAI-compatible gateways only accept scalar parameter property types
    (string/number/integer/boolean/null). Keep the root parameters object, but
    expose nested object/array properties as strings so request validation passes.
    Runtime tool invocation still receives the original schema and can coerce
    stringified arrays/objects back before calling Python functions.
    """
    if not isinstance(schema, dict):
        return schema

    node = dict(schema)
    for key in ("anyOf", "oneOf", "allOf"):
        variants = node.get(key)
        if isinstance(variants, list):
            chosen = next(
                (v for v in variants if isinstance(v, dict) and v.get("type") != "null"),
                variants[0] if variants else {"type": "string"},
            )
            merged = _to_openai_scalar_params(chosen, _root=_root)
            if isinstance(merged, dict):
                for keep in ("description", "title"):
                    if keep in node and keep not in merged:
                        merged[keep] = node[keep]
                return merged

    t = node.get("type")
    if isinstance(t, list):
        scalar = next(
            (x for x in t if x in {"string", "number", "integer", "boolean", "null"}),
            "string",
        )
        node["type"] = scalar
        t = scalar

    if t == "object" and _root:
        props = node.get("properties")
        if isinstance(props, dict):
            node["properties"] = {
                name: _to_openai_scalar_params(sub, _root=False)
                for name, sub in props.items()
            }
        return node

    if t in {"array", "object"} or "items" in node or "properties" in node:
        out = {
            k: v
            for k, v in node.items()
            if k not in {"items", "properties", "additionalProperties", "required"}
        }
        out["type"] = "string"
        desc = str(out.get("description") or "").strip()
        hint = "Pass this value as JSON text."
        out["description"] = f"{desc} {hint}".strip() if desc else hint
        return out

    return node


# ============================================================
# OpenAIModel
# ============================================================

class OpenAIModel(Model):
    def __init__(self, model_name: str, provider, *, supports_vision: bool = True) -> None:
        self.model_name = model_name
        self.provider = provider
        self.supports_vision = bool(supports_vision)

    @property
    def _client(self) -> httpx.AsyncClient:
        return self.provider.http_client or get_default_http_client()

    # ---------- 请求体组装 ----------

    def _user_content_to_wire(self, content: Any) -> Any:
        if isinstance(content, str):
            return content
        if isinstance(content, BinaryContent):
            if not self.supports_vision:
                return _image_placeholder(content)
            content = [content]
        if isinstance(content, list):
            parts: list[dict] = []
            for item in content:
                if isinstance(item, BinaryContent):
                    if self.supports_vision:
                        parts.append({
                            "type": "image_url",
                            "image_url": {"url": item.as_data_uri()},
                        })
                    else:
                        parts.append({"type": "text", "text": _image_placeholder(item)})
                elif item is not None:
                    parts.append({"type": "text", "text": str(item)})
            # 全文本时退化成纯字符串（更兼容老网关）
            if parts and all(p["type"] == "text" for p in parts):
                return "".join(p["text"] for p in parts)
            return parts
        return str(content)

    def _messages_to_wire(
        self, messages: list[ModelMessage], system_parts: list[SystemPromptPart]
    ) -> list[dict]:
        wire: list[dict] = []
        for sp in system_parts:
            if sp.content:
                wire.append({"role": "system", "content": sp.content})

        for msg in messages:
            if isinstance(msg, ModelRequest):
                for part in msg.parts:
                    if isinstance(part, SystemPromptPart):
                        if part.content:
                            wire.append({"role": "system", "content": part.content})
                    elif isinstance(part, UserPromptPart):
                        wire.append({"role": "user", "content": self._user_content_to_wire(part.content)})
                    elif isinstance(part, ToolReturnPart):
                        wire.append({
                            "role": "tool",
                            "tool_call_id": part.tool_call_id or part.tool_name,
                            "content": _json_content(part.content),
                        })
                    elif isinstance(part, RetryPromptPart):
                        if part.tool_name:
                            wire.append({
                                "role": "tool",
                                "tool_call_id": part.tool_call_id or part.tool_name,
                                "content": part.content,
                            })
                        else:
                            wire.append({"role": "user", "content": part.content})
            elif isinstance(msg, ModelResponse):
                text_chunks: list[str] = []
                tool_calls: list[dict] = []
                for part in msg.parts:
                    if isinstance(part, TextPart):
                        if part.content:
                            text_chunks.append(part.content)
                    elif isinstance(part, ToolCallPart):
                        tool_calls.append({
                            "id": part.tool_call_id or part.tool_name,
                            "type": "function",
                            "function": {
                                "name": part.tool_name,
                                "arguments": part.args if isinstance(part.args, str) else json.dumps(part.args, ensure_ascii=False),
                            },
                        })
                    # ThinkingPart 不回灌（与各家一致，思考不进下一轮输入）
                assistant: dict = {"role": "assistant"}
                assistant["content"] = "\n".join(text_chunks) if text_chunks else None
                if tool_calls:
                    assistant["tool_calls"] = tool_calls
                wire.append(assistant)
        return wire

    def _tools_to_wire(self, tools: list[ToolDefinition]) -> list[dict]:
        out: list[dict] = []
        for t in tools:
            schema = t.parameters_json_schema or {"type": "object", "properties": {}}
            schema = _to_openai_strict(schema) if t.strict else schema
            schema = _to_openai_scalar_params(schema)
            fn: dict = {
                "name": t.name,
                "description": t.description,
                "parameters": schema,
            }
            if t.strict:
                fn["strict"] = True
            out.append({"type": "function", "function": fn})
        return out

    def _build_body(
        self,
        messages: list[ModelMessage],
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        settings: dict,
    ) -> dict:
        body: dict = {
            "model": self.model_name,
            "messages": self._messages_to_wire(messages, system_parts),
            "stream": False,
        }
        if tools:
            body["tools"] = self._tools_to_wire(tools)
            body["tool_choice"] = "required" if require_tool else "auto"

        if "temperature" in settings:
            body["temperature"] = settings["temperature"]
        if "max_tokens" in settings:
            body["max_tokens"] = settings["max_tokens"]
        if "parallel_tool_calls" in settings and tools:
            body["parallel_tool_calls"] = settings["parallel_tool_calls"]

        # extra_body 最后整体并入：覆盖计算出的字段（如 thinking / tool_choice）
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
        model_settings: Optional[dict] = None,
    ) -> tuple[ModelResponse, Usage]:
        settings = dict(model_settings or {})
        body = self._build_body(messages, system_parts, tools, require_tool, settings)

        base = self.provider.base_url.rstrip("/")
        url = f"{base}/chat/completions"
        headers = {"content-type": "application/json"}
        if self.provider.api_key:
            headers["authorization"] = f"Bearer {self.provider.api_key}"

        resp = await self._client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            raise ModelHTTPError(resp.status_code, _safe_text(resp), body=_safe_text(resp))

        data = resp.json()
        return _parse_openai_response(data)


# ============================================================
# 响应解析
# ============================================================

def _parse_openai_response(data: dict) -> tuple[ModelResponse, Usage]:
    parts: list = []
    choices = data.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        reasoning = message.get("reasoning_content") or message.get("reasoning")
        if reasoning:
            parts.append(ThinkingPart(content=str(reasoning)))
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            parts.append(TextPart(content=content))
        for tc in message.get("tool_calls") or []:
            fn = tc.get("function") or {}
            raw_args = fn.get("arguments")
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except (json.JSONDecodeError, TypeError):
                args = raw_args or {}
            parts.append(ToolCallPart(
                tool_name=fn.get("name") or "",
                args=args,
                tool_call_id=tc.get("id") or "",
            ))

    usage = _parse_usage(data.get("usage"))
    return ModelResponse(parts=parts), usage


def _parse_usage(raw: Any) -> Usage:
    if not isinstance(raw, dict):
        return Usage(requests=1)
    return Usage(
        input_tokens=int(raw.get("prompt_tokens") or 0),
        output_tokens=int(raw.get("completion_tokens") or 0),
        total_tokens=int(raw.get("total_tokens") or 0),
        requests=1,
    )


def _json_content(content: Any) -> str:
    """把工具返回内容序列化成字符串发回模型。"""
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False, default=_json_default)
    except Exception:
        return str(content)


def _image_placeholder(content: BinaryContent) -> str:
    data = content.data or b""
    return f"[image omitted: {content.media_type or 'image'}, {len(data)} bytes]"


def _json_default(obj: Any):
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    return str(obj)


def _safe_text(resp: httpx.Response) -> str:
    try:
        return resp.text
    except Exception:
        return ""


__all__ = ["OpenAIModel"]
